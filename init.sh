#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

# Color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

run_command() {
  echo -e "${YELLOW}Running:${NC} $*"
  "$@"
}

complete_message() {
  echo -e "${GREEN}$1 completed.${NC}"
}

remove_if_broken_dotfile_symlink() {
  local link="$1" target repo_name

  [ -L "$link" ] || return 1
  [ -e "$link" ] && return 1

  target=$(readlink "$link")
  repo_name=$(basename "$repo_dir")
  # Match absolute ("/.../dotfiles/...") and relative ("dotfiles/..." or
  # "../../../dotfiles/...") paths.
  if [[ "$target" == "$repo_dir/"* || "$target" == "$repo_name/"* || "$target" == *"/$repo_name/"* ]]; then
    echo -e "${YELLOW}Removing broken symlink:${NC} $link -> $target"
    rm -f "$link"
    return 0
  fi

  return 1
}

remove_broken_symlinks() {
  local target_dir="$1"
  local link

  # BSD `find` (macOS) doesn't support `-xtype`, so iterate all symlinks
  # and check each one ourselves.
  while IFS= read -r -d '' link; do
    remove_if_broken_dotfile_symlink "$link" || true
  done < <(find "$target_dir" -type l -print0 2>/dev/null)
}

remove_broken_symlinks_direct() {
  local target_dir="$1" link

  shopt -s dotglob nullglob
  for link in "$target_dir"/*; do
    remove_if_broken_dotfile_symlink "$link" || true
  done
  shopt -u dotglob nullglob
}

# True if $1 is a symlink whose target resolves into the dotfiles repo.
# Matches both absolute paths ("/.../dotfiles/...") and stow-style relative
# paths ("../../../dotfiles/...").
is_dotfile_repo_link() {
  [ -L "$1" ] || return 1
  local target
  target=$(readlink "$1")
  [[ "$target" == *"$repo_dir/"* || "$target" == *"/dotfiles/"* ]]
}

# True if $1 is a broken dotfile-repo symlink.
is_stale_dotfile_link() {
  [ ! -e "$1" ] && is_dotfile_repo_link "$1"
}

# True if $1 is a directory whose entries are all stale dotfile symlinks
# (or empty) — the leftover state from a previous `home/.claude/skills/` stow.
is_stale_dotfile_dir() {
  local dir="$1" entry
  [ -d "$dir" ] || return 1
  local all_stale=true
  while IFS= read -r -d '' entry; do
    is_stale_dotfile_link "$entry" || { all_stale=false; break; }
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  [ "$all_stale" = true ]
}

# True if $1 is safe to replace with our per-skill symlink: missing, a
# broken dotfile symlink, or a dir whose contents are all broken dotfile
# symlinks. False if $1 might be content from `npx agents` or another
# tool — we leave those alone to avoid clobbering other programs.
is_stale_dotfile_entry() {
  local p="$1"

  # Path doesn't resolve — either missing or a broken symlink
  if [ ! -e "$p" ]; then
    if [ -L "$p" ]; then
      # Broken symlink → replace only if target is in the dotfiles repo
      is_stale_dotfile_link "$p" && return 0
      return 1
    fi
    # Truly missing → create new
    return 0
  fi

  # Working symlink → leave alone (could be npx, our correct link, etc.)
  if [ -L "$p" ]; then
    return 1
  fi

  # Real dir → replace only if contents are all stale dotfile symlinks
  if [ -d "$p" ]; then
    is_stale_dotfile_dir "$p" && return 0
  fi

  return 1
}

link_agents_skills() {
  local skill_dir skill_name link_path link_target manifest_target

  run_command mkdir -p "$HOME/.agents/skills"
  for skill_dir in "$repo_dir"/home/.agents/skills/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    link_path="$HOME/.agents/skills/$skill_name"
    link_target="$skill_dir"

    # Correct directory symlink: leave it alone.
    if [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$link_target" ]; then
      continue
    fi

    # Replace only the real directories Stow previously created for this
    # repository. Never remove skills installed by another tool.
    manifest_target="$link_path/SKILL.md"
    if [ -d "$link_path" ] && is_dotfile_repo_link "$manifest_target"; then
      rm -rf "$link_path"
    elif [ -e "$link_path" ] || [ -L "$link_path" ]; then
      echo -e "${YELLOW}Skipping ${skill_name}: ${link_path} is not managed by this dotfiles repository${NC}"
      continue
    fi

    run_command ln -s "$link_target" "$link_path"
  done
}

user_config() {
  run_command mkdir -p ~/.config ~/.local ~/.agents

  remove_broken_symlinks ~/.local
  run_command stow --dir "$repo_dir" --target ~/.local --restow .local

  # ~/.agents/skills must be a real (stowed) directory before stow so that
  # ~/.claude/skills/<skill> can symlink to entries inside it.
  if [ -L ~/.agents/skills ]; then
    echo -e "${YELLOW}Removing stale symlink:${NC} ~/.agents/skills -> $(readlink ~/.agents/skills)"
    rm -f ~/.agents/skills
  fi

  remove_broken_symlinks_direct ~
  remove_broken_symlinks ~/.claude
  remove_broken_symlinks ~/.pi
  run_command stow --dir "$repo_dir" --target ~ --restow home

  # Codex follows skill-directory symlinks, so use those rather than Stow's
  # default per-file SKILL.md symlinks.
  link_agents_skills

  # Share .agents/skills with Claude Code: per-skill symlinks from
  # ~/.claude/skills/<skill> to ../../.agents/skills/<skill>.
  # Only replace entries that are clearly our own stale leftovers — never
  # touch symlinks or content from `npx agents` and other tools.
  run_command mkdir -p ~/.claude/skills
  for skill_dir in ~/.agents/skills/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    link_path="$HOME/.claude/skills/$skill_name"
    link_target="../../.agents/skills/$skill_name"

    # Skip if already a correct symlink (idempotent)
    if [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$link_target" ]; then
      continue
    fi

    if ! is_stale_dotfile_entry "$link_path"; then
      echo -e "${YELLOW}Skipping ${skill_name}: ${link_path} is not a stale dotfile leftover (leaving it alone — may be from npx agents or another tool)${NC}"
      continue
    fi

    rm -rf "$link_path"
    run_command ln -s "$link_target" "$link_path"
  done

  remove_broken_symlinks ~/.config
  run_command stow --dir "$repo_dir" --target ~/.config --restow .config

  if [[ "$(uname)" == "Linux" ]]; then
    run_command systemctl --user enable ssh-agent
    run_command systemctl --user start ssh-agent
  fi

  # Remind about pi extension deps if missing (stow no longer manages node_modules)
  if [ ! -d ~/.pi/agent/extensions/node_modules ]; then
    echo -e "${YELLOW}Hint: run 'make pi' to install npm deps for pi extensions${NC}"
  fi
}

linux_system_config() {
  run_command sudo ln -sf "$repo_dir"/misc/keymaps/colemak /usr/share/X11/xkb/symbols/colemak
  run_command sudo ln -sf "$repo_dir"/misc/keymaps/keyd.conf /etc/keyd/default.conf

  run_command sudo mkdir -p -m 755 \
    /etc/systemd/sleep.conf.d/ \
    /etc/systemd/logind.conf.d/ \
    /etc/systemd/resolved.conf.d/

  run_command sudo cp -f "$repo_dir"/misc/systemd-config/zram-generator.conf /etc/systemd/
  run_command sudo systemctl daemon-reload
  run_command sudo systemctl start systemd-zram-setup@zram0.service

  # Systemd runs in a sandbox and does not have access to user directories by default.
  # That's why we copy things
  run_command sudo rm -f /etc/systemd/sleep.conf.d/99-sleep.conf
  run_command sudo cp -f "$repo_dir"/misc/systemd-config/99-sleep.conf /etc/systemd/sleep.conf.d/

  # sudoers
  run_command sudo ln -sf "$repo_dir"/misc/99-sudoers /etc/sudoers.d/
  run_command sudo chown root:root /etc/sudoers.d/99-sudoers

  # logind
  run_command sudo rm -f /etc/systemd/logind.conf.d/99-logind.conf
  run_command sudo cp -f "$repo_dir"/misc/systemd-config/99-logind.conf /etc/systemd/logind.conf.d/

  run_command sudo sed -i '/Color/s/^#//g' /etc/pacman.conf

  # CPU power scaling
  run_command sudo systemctl enable --now power-profiles-daemon.service
  run_command powerprofilesctl set balanced

  run_command sudo systemctl enable --now fstrim.timer
  run_command sudo systemctl enable --now bluetooth.service

  run_command sudo ln -sfT "$repo_dir"/misc/pacman-hooks /etc/pacman.d/hooks
  run_command sudo ln -sfT dash /usr/bin/sh

}

mac_system_config() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "${RED}macOS system configuration can only run on macOS.${NC}"
    return 1
  fi

  local keyboard_layout_dir="$HOME/Library/Keyboard Layouts"
  local keyboard_layout_src="$repo_dir/misc/keymaps/Colemak-DH-ANSI.keylayout"

  run_command mkdir -p "$keyboard_layout_dir"
  run_command install -m 0644 "$keyboard_layout_src" "$keyboard_layout_dir/"

  echo -e "${YELLOW}Log out and back in, then enable:${NC} System Settings → Keyboard → Text Input → Edit → + → Others → Colemak-DH ANSI"
}

run() {
  local option="${1:-}"
  local -r options=("User Configuration" "Linux (Arch) System Configuration" "Mac System Configuration" "Quit")

  if [[ -z $option ]]; then
    echo -e "${YELLOW}Select an option:${NC}"
    select _ in "${options[@]}"; do
      option=$REPLY
      break
    done
  fi

  case "$option" in
  1)
    user_config
    complete_message "${options[0]}"
    ;;
  2)
    linux_system_config
    complete_message "${options[1]}"
    ;;
  3)
    mac_system_config
    complete_message "${options[2]}"
    ;;
  4 | q | quit)
    return 0
    ;;
  *)
    echo -e "${RED}Invalid option: ${option}${NC}"
    [[ -n ${1:-} ]] && echo "Usage: $0 [1|2|3|4]"
    return 2
    ;;
  esac
}

run "${1:-}"
