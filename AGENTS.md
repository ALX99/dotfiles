# Repository Guidelines

## Project Structure & Module Organization
.config/ holds per-app configs (Neovim, river, tmux, etc.) that get symlinked into `~/.config`. Shell entrypoints live in `shell/` (`.bashrc`, `.aliasrc`, `.profile`). Executable helpers belong in `.local/bin/` (one file per command, lowercase names). System-level tweaks live under `misc/`, keyboard layouts under `keymaps/`, and pacman hooks in `hooks/`. Keep screenshots or diagrams in the root-level PNG artifacts. Submodules (`.local/bin/adb-uninstall`, `.config/mpv/scripts/subs2srs`, `ghostty-shaders/`) must be kept in sync with `git submodule update --init --recursive`.

## Setup, Build & Development Commands
- `./setupDots` – interactive menu that links configs, enables services, and applies Arch-specific tweaks. Run after cloning to refresh symlinks.
- `./setupDots user_config` is not exposed, so trigger menu option 1 to re-sync dotfiles; option 2+ cover system/udev settings.
- `task <target>` (Taskfile v3) – extend or use the shared `./task/Taskfile.yml` when automating repetitive steps.

## Coding Style & Naming Conventions
Shell scripts should target Bash with `set -euo pipefail`, two-space indentation, and descriptive lowercase names (`tmux-history`, `paccy`). Prefer POSIX-compatible syntax when possible for portability. Keep config fragments declarative; comment non-obvious overrides above the relevant stanza. When editing YAML or JSON (e.g., `.config/alacritty`, `.claude/settings.json`), preserve existing indentation (two spaces for YAML, two or four spaces where already used). New aliases go into `shell/.aliasrc`, grouped by topic, while secrets stay outside the repo; reference them via environment variables or `.privrc`.

## Testing Guidelines
There is no central test suite, so validate changes per artifact: run `shellcheck shell/.bashrc .local/bin/<script>` before committing, and exercise scripts manually (`bash -x script.sh` or `./script --help`). When modifying systemd units or udev rules under `misc/`, reload with `systemctl --user daemon-reload` or `sudo udevadm control --reload-rules` and confirm status. Keep coverage informal but note verification steps inside the pull request.

## Commit & Pull Request Workflow
The history follows Conventional Commits (`feat:`, `fix:`, `chore:`). Scope optional but encouraged (`feat(shell): add prompt theme`). Keep commits focused on one intent and mention affected subsystems. Pull requests should describe the motivation, summarize manual verification (commands run, hosts tested), and reference any related issues. Include screenshots when tweaking UI-facing configs (e.g., waybar themes, ghostty palettes) so reviewers can assess visual impact quickly. Update documentation (README, AGENTS.md) whenever behavior changes or new tooling is introduced.
