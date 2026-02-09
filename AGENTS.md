# CLAUDE.md

Personal dotfiles repo for Arch Linux + macOS. Configs managed via GNU Stow (`home/`→`~/`, `.config/`→`~/.config/`, `.local/`→`~/.local/`).

## Layout

- `home/` — Shell dotfiles (.bashrc, .profile, .aliasrc, .gitconfig, .claude/)
- `.config/` — XDG configs (nvim, ghostty, tmux, hyprland, waybar, aerospace, ...)
- `.local/bin/` — Custom shell scripts
- `misc/` — System-level configs (keymaps, systemd, pacman hooks)

## Neovim

`init.lua` bootstraps lazy.nvim, leader is space.

- `plugin/` — Core config, loaded alphabetically: `10_opts`, `20_keymaps`, `30_autocmds`, `40_lsp_attach`
- `lua/plugins/` — lazy.nvim plugin specs
- `lua/custom_plugins/` — Local plugins: `gh-review/` (PR review), `gitgud/` (git utils), `vscode/` (VS Code helpers)
- `lua/colemak.lua` — Colemak key remapping table

## Conventions

- Keyboard layout: **Colemak DH** — keybindings remapped throughout (nvim, tmux, hyprland)
- Shell: `#!/usr/bin/env bash` with `set -euo pipefail`
- Neovim: lazy.nvim lazy-loading, `_G.Config` for cross-file state
- Lua: use `local` everywhere, no OOP unless the plugin API requires it
