set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set quiet := true

repo_dir := justfile_directory()

# List available setup tasks.
default:
    just --list

# Install user dotfiles and share agent skills with Claude Code.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob

    repo_dir={{ quote(repo_dir) }}

    link_if_missing() {
      local target="$1" link="$2"

      if [[ -e "$link" || -L "$link" ]]; then
        [[ -L "$link" && $(readlink "$link") == "$target" ]] ||
          printf 'Skipping existing path: %s\n' "$link"
        return
      fi

      printf 'Linking: %s -> %s\n' "$link" "$target"
      ln -s "$target" "$link"
    }

    clean_broken_skill_links() {
      local repo_name=${repo_dir##*/}

      while IFS= read -r -d '' link; do
        [[ ! -e "$link" ]] || continue
        target=$(readlink "$link")

        if [[ "$target" == "$repo_dir/"* || "$target" == "$repo_name/"* || "$target" == *"/$repo_name/"* ]] ||
           [[ "$link" == "$HOME/.claude/skills/"* && "$target" == "../../.agents/skills/"* ]]; then
          printf 'Removing broken symlink: %s -> %s\n' "$link" "$target"
          rm -f "$link"
        fi
      done < <(
        find "$HOME/.agents/skills" "$HOME/.claude/skills" \
          -mindepth 1 -maxdepth 1 -type l -print0 2>/dev/null
      )
    }

    mkdir -p "$HOME/.config" "$HOME/.local" "$HOME/.agents/skills" "$HOME/.claude/skills"

    clean_broken_skill_links

    stow --dir "$repo_dir" --target "$HOME/.local" --restow .local
    stow --dir "$repo_dir" --target "$HOME" --restow home

    # Keep repo skills where they are while allowing other tools to add their
    # own entries to ~/.agents/skills and ~/.claude/skills.
    for skill_dir in "$repo_dir"/home/.agents/skills/*/; do
      skill_name=$(basename "$skill_dir")
      link_if_missing "$skill_dir" "$HOME/.agents/skills/$skill_name"
    done

    for skill_dir in "$HOME"/.agents/skills/*/; do
      skill_name=$(basename "$skill_dir")
      link_if_missing "../../.agents/skills/$skill_name" "$HOME/.claude/skills/$skill_name"
    done

    stow --dir "$repo_dir" --target "$HOME/.config" --restow .config

    if [[ $(uname) == Linux ]] &&
       command -v systemctl >/dev/null 2>&1 &&
       [[ -n ${XDG_RUNTIME_DIR:-} && -S "$XDG_RUNTIME_DIR/bus" ]] &&
       systemctl --user show-environment >/dev/null 2>&1; then
      systemctl --user enable --now ssh-agent
    fi

    if [[ ! -d "$HOME/.pi/agent/extensions/node_modules" ]]; then
      printf "Hint: run 'just install-pi' to install pi extension dependencies\n"
    fi

    printf 'User configuration completed.\n'

# Install Arch Linux system configuration (requires sudo).
linux-system:
    #!/usr/bin/env bash
    set -euo pipefail
    repo_dir={{ quote(repo_dir) }}

    [[ $(uname) == Linux ]] || { echo 'Linux system configuration can only run on Linux.' >&2; exit 1; }

    sudo ln -sf "$repo_dir/misc/keymaps/colemak" /usr/share/X11/xkb/symbols/colemak
    sudo ln -sf "$repo_dir/misc/keymaps/keyd.conf" /etc/keyd/default.conf

    sudo mkdir -p -m 755 \
      /etc/systemd/sleep.conf.d/ \
      /etc/systemd/logind.conf.d/ \
      /etc/systemd/resolved.conf.d/

    sudo cp -f "$repo_dir/misc/systemd-config/zram-generator.conf" /etc/systemd/
    sudo systemctl daemon-reload
    sudo systemctl start systemd-zram-setup@zram0.service

    # These must be copied because systemd cannot access the user directory
    # from its sandbox.
    sudo rm -f /etc/systemd/sleep.conf.d/99-sleep.conf
    sudo cp -f "$repo_dir/misc/systemd-config/99-sleep.conf" /etc/systemd/sleep.conf.d/

    sudo ln -sf "$repo_dir/misc/99-sudoers" /etc/sudoers.d/99-sudoers
    sudo chown root:root /etc/sudoers.d/99-sudoers

    sudo rm -f /etc/systemd/logind.conf.d/99-logind.conf
    sudo cp -f "$repo_dir/misc/systemd-config/99-logind.conf" /etc/systemd/logind.conf.d/

    sudo sed -i '/Color/s/^#//g' /etc/pacman.conf
    sudo systemctl enable --now power-profiles-daemon.service
    powerprofilesctl set balanced
    sudo systemctl enable --now fstrim.timer bluetooth.service

    sudo ln -sfT "$repo_dir/misc/pacman-hooks" /etc/pacman.d/hooks
    sudo ln -sfT dash /usr/bin/sh

    printf 'Linux system configuration completed.\n'

# Install the Colemak-DH ANSI keyboard layout on macOS.
mac-system:
    #!/usr/bin/env bash
    set -euo pipefail
    repo_dir={{ quote(repo_dir) }}

    [[ $(uname) == Darwin ]] || { echo 'macOS system configuration can only run on macOS.' >&2; exit 1; }

    keyboard_layout_dir="$HOME/Library/Keyboard Layouts"
    mkdir -p "$keyboard_layout_dir"
    install -m 0644 "$repo_dir/misc/keymaps/Colemak-DH-ANSI.keylayout" "$keyboard_layout_dir/"

    echo 'Log out and back in, then enable:'
    echo 'System Settings → Keyboard → Text Input → Edit → + → Others → Colemak-DH ANSI'
    printf 'macOS system configuration completed.\n'

# Generate the Karabiner-Elements configuration from its CUE source.
karabiner-generate:
    #!/usr/bin/env bash
    set -euo pipefail

    generated=$(mktemp)
    trap 'rm -f "$generated"' EXIT
    cue export misc/karabiner/karabiner.cue --expression config --out json | jq . > "$generated"
    mv "$generated" .config/karabiner/karabiner.json
    trap - EXIT

# Verify the Karabiner CUE source and generated configuration are current.
karabiner-check:
    #!/usr/bin/env bash
    set -euo pipefail

    cue fmt --check --files misc/karabiner/karabiner.cue
    cue vet misc/karabiner/karabiner.cue
    generated=$(mktemp)
    trap 'rm -f "$generated"' EXIT
    cue export misc/karabiner/karabiner.cue --expression config --out json | jq . > "$generated"
    diff -u .config/karabiner/karabiner.json "$generated"

# Install pnpm dependencies for pi extensions.
install-pi:
    cd "$HOME/.pi/agent/extensions" && pnpm install --frozen-lockfile

# Format the pi extensions.
fmt:
    cd {{ quote(repo_dir) }}/home/.pi/agent/extensions && pnpm run format

# Typecheck, lint, and test the pi extensions.
check:
    cd {{ quote(repo_dir) }}/home/.pi/agent/extensions && pnpm run check
