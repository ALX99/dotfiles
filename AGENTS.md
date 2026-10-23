# Repository Guide

## Layout and sources of truth

- This is a Stow repo: `.local/`, `home/`, and `.config/` install to `~/.local`, `~`, and `~/.config`. `.stowrc` disables folding; keep tracked symlinks intact, especially the Claude/Codex instruction links to the shared `home/.agents/AGENTS.md` (installed as `~/.agents/AGENTS.md`).
- `.local/bin/` owns user executables; `home/` owns shell and agent configuration; `.config/` owns application configuration; `misc/` owns keyboard layouts and generated assets. Start shell work at `home/.bash_profile`, `home/.bashrc`, and `home/.bashrc.d/`.
- Herdr plugins share CLI/workspace helpers in `.config/herdr/plugins/_shared/herdrlib.py`; plugin-specific Git and install policy stays with each plugin.
- `home/.agents/AGENTS.md` is the shared general instruction source for Claude and Codex; `home/.agents/skills/` contains harness-independent skills. Pi configuration and extensions live in the separate `~/projects/pi-lot` repository, which owns installation into `~/.pi/agent`. Dotfiles must not Stow or install Pi resources.
- `misc/themes/twilight-bloom.cue` is the theme source for the Ghostty and Herdr outputs. Colemak-DH mappings are coordinated across Nvim, tmux, Sail, Ghostty, and readline.
- Interactive macOS Bash maps GNU utility names to private aliases instead of adding GNU directories to `PATH`; keep GNU-option aliases in `home/.aliasrc` consistent with those aliases.

## Commands

- `mise.toml` and `.mise/tasks/` define tools, setup, generators, and checks. CI runs `mise run check`; `mise run fmt` formats the repo and `mise run gen` runs every generator.
- For generated assets, edit the source first, then run `mise run gen:theme` / `mise run theme:check`.
- `mise run shell:check` runs ShellCheck and shfmt on repository shell scripts.

## Host changes

- `mise run install` changes `$HOME`: it restows packages, synchronizes skill links (including stale repo-managed links), and may enable the user `ssh-agent`. Do not run it for routine code verification.

Keep this file limited to verified ownership, source-of-truth, and workflow facts; update it when those change.
