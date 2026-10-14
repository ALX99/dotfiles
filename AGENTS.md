# Repository Map

## Repository Purpose

This Stow-managed personal repository holds shell tooling, desktop applications, system setup, and AI-agent configuration. `.local/`, `home/`, and `.config/` are packages installed into `~/.local`, `~`, and `~/.config`; `.stowrc` deliberately disables Stow folding.

## Architecture and Ownership

- `.local/bin/` owns user executables. `home/` owns configuration, including Bash, SSH, Git, and agent files. Start shell changes at `home/.profile`, `home/.bashrc`, and `home/.bashrc.d/`.
- `.config/` owns application configuration. Neovim starts at `.config/nvim/init.lua`; compositor, terminal, and other desktop settings live beside it. Karabiner's JSON is generated from `misc/karabiner/karabiner.cue` into the tracked `misc/karabiner/karabiner.json`, and `mise run install` copies it to `~/.config/karabiner/karabiner.json` when that path is absent; Karabiner rewrites the installed file itself, so it is copied once rather than stowed as a link its writes would dirty. Herdr plugins share CLI execution and validated workspace fields through `.config/herdr/plugins/_shared/herdrlib.py`; each plugin owns its Git or installation policy.
- `misc/` owns Arch, systemd, pacman-hook, and keyboard assets. `.devcontainer/` defines the Arch development environment rather than the installed host configuration.
- `home/.agents/skills/` contains harness-independent skills. Pi configuration and extensions now live in `~/projects/pi-lot`, which owns installation into `~/.pi/agent`; dotfiles must not Stow or install Pi resources.

## Key Flows and Sources of Truth

`mise run install` restows the three user packages and links shared skills; it can change `$HOME` and enable the user `ssh-agent`. `mise.toml` owns the bootstrap manifest and tools; `.mise/tasks/` owns automation as standalone scripts (entry points flat, subsystem work namespaced like `shell:check` and `karabiner:check`, generators inverted as `gen:<area>` and run together by `mise run gen`). Together they are the source for installation and host setup. GitHub Actions installs the tools from `mise.toml` and runs `mise run check` for every push and pull request.

## Where to Start

- For user commands or shell behavior, inspect `.local/bin/` and the `home/` shell file.
- For an application or desktop change, begin under `.config/`; follow related Colemak-DH mappings across affected applications.
- For Karabiner changes, edit `misc/karabiner/karabiner.cue`, then run `mise run gen:karabiner` and `mise run karabiner:check`; copy `misc/karabiner/karabiner.json` over `~/.config/karabiner/karabiner.json` to apply a regenerated config to an existing install.
- For Twilight Bloom changes, edit `misc/themes/twilight-bloom.cue`, then run `mise run gen:theme` and `mise run theme:check`. It generates Ghostty and Herdr themes.
- For system provisioning or keymaps, begin at `misc/` and `mise.linux.toml`. Do not casually run `MISE_ENV=linux mise bootstrap` or the `linux-system` task; they make privileged host changes.

## Critical Constraints

Keep tracked links as links: `CLAUDE.md` targets this file, `home/.bash_profile` targets `.profile`, and the Claude/Codex instruction links resolve through `~/.pi/agent/APPEND_SYSTEM.md`, installed by pi-lot. Colemak-DH navigation is coordinated across Nvim, tmux, Sail, keyd, Karabiner, Ghostty, and readline. `misc/themes/twilight-bloom.cue` is the source of truth for the Ghostty and Herdr themes. Bash PS1 and LS_COLORS consume the Ghostty ANSI palette directly. Interactive macOS Bash maps GNU utility names to private aliases in `home/.bashrc`, without adding GNU directories to PATH; child processes such as coding agents therefore retain the inherited native-utility PATH. Keep GNU-option aliases in `home/.aliasrc` consistent with those private aliases.

## Maintenance

Keep this repository map current. When a change adds, removes, or relocates a major subsystem; changes an architectural boundary or source of truth; or introduces a critical repository-wide constraint, update `AGENTS.md` in the same commit. Do not record routine implementation details or file-level churn.
