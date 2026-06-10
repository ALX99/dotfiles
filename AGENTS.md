# AGENTS.md

Personal dotfiles repo for Arch Linux + macOS. Configs managed via GNU Stow (`home/`→`~/`, `.config/`→`~/.config/`, `.local/`→`~/.local/`).

## Layout

```
home/            → ~/  (shell dotfiles: .bashrc, .profile, .aliasrc, .gitconfig, .claude/, .inputrc, .ssh/config)
.config/         → ~/.config/  (nvim, ghostty, tmux, hyprland, waybar, dunst, fcitx5, lazygit, mpv, ...)
.local/bin/      → ~/.local/bin/  (custom shell scripts)
misc/            → system-level configs (keymaps, systemd, pacman-hooks, sudoers)
```

## Architecture & Key Gotchas

### GNU Stow Conventions
- `.config/` is stowed directly to `~/.config/` (not `~/.config/.config/`)
- `home/` is stowed to `~/`
- `.local/` is stowed to `~/.local/`
- `.stowrc` enables `--no-folding` (creates symlinks for each file, not directories)

### Bi-Platform Code
Platform conditionals everywhere — always check both branches:
- Shell: `[[ $OSTYPE == darwin* ]]` vs `else` (Linux)
- Shell: `[ "$(uname)" = "Linux" ]`
- macOS uses Homebrew (`/opt/homebrew/bin`), GNU utils via aliases (`gls`, `gfind`, `gsed`)
- Linux uses Arch Linux, systemd, Hyprland

### Keyboard: Colemak DH
**Every keybinding config in this repo assumes Colemak DH.** Home row movement keys are:
```
Colemak:  m(←) n(↓) e(↑) i(→)
Qwerty:   h(←) j(↓) k(↑) l(→)
```

Config files with Colemak remappings:
- `.config/nvim/lua/colemak.lua` — nvim normal/visual mode movement, displaced keys
- `.config/nvim/plugin/75_snacks.lua` — picker keys: `n`=down, `e`=up
- `.config/tmux/tmux.conf` — copy-mode-vi: `m`/`n`/`e`/`i`, pane movement: `M-m`/`M-n`/`M-e`/`M-i`
- `.config/ghostty/config` — cmd+`m`/`n`/`e`/`i`/`h`/`o` passthrough to tmux
- `.config/hypr/hyprland.lua` — `M`/`N`/`E`/`I` for movefocus
- `home/.inputrc` — vi-mode bindings: `n`=forward-search, `e`=backward-search

### Shell (bash)
- `.profile` → login shell env (PATH, XDG, platform vars, `fcitx5`/Wayland setup)
  - On Linux tty1: auto-starts Hyprland via `.local/bin/start-graphical-session`
- `.bashrc` → interactive shell (sources `.privrc`, `.priv_env`, shopt settings, aliases)
- `.aliasrc` → sourced by `.bashrc`, contains all aliases/functions/bindings/completions
- `.inputrc` → vi editing mode (`set editing-mode vi`), Colemak search bindings
- Lazy completions: `kubectl`, `helm`, `k6`, `gh`, `orb` use `_lazy_completion` wrapper
- `.privrc` and `.priv_env` are sourced if present — **not tracked in repo**

### Neovim Config
Uses **built-in `vim.pack.add`** (nvim 0.12+), not lazy.nvim.

Load order (inside `.config/nvim/`):
1. `init.lua` — sets `_G.Config`, creates augroup `custom-config`, `_G.Config.new_autocmd()` helper
2. `plugin/*.lua` — loaded alphabetically by `vim.pack`:
   - `10_opts.lua` — general options, UI, editing, diagnostic config, `vim.ui.open` override
   - `20_keymaps.lua` — general keybindings (runs `colemak.setup()`), user commands
   - `30_autocmds.lua` — `FileType`, `TextYankPost`, `VimResized`, `BufWritePre`, cursorline toggles, `shfmt` format-on-save
   - `40_lsp_behavior.lua` — LSP keymaps, diagnostics, highlight references
   - `41_lsp_format.lua` — LSP formatting and format-on-save
   - `70_theme.lua` — colorscheme (kanagawa/tokyonight)
   - `71_treesitter.lua` — nvim-treesitter install + per-FileType highlighting
   - `72_flash.lua` — flash.nvim (navigation)
   - `73_git.lua` — git blame, snacks git pickers
   - `74_sidekick.lua` — sidekick.nvim
   - `75_snacks.lua` — Snacks.nvim (picker, bigfile, input) with Colemak Picker keys
   - `76_mini.lua` — mini.nvim modules
   - `77_blink_cmp.lua` — blink.cmp (completion)
   - `78_lsp.lua` — LSP config (nvim-lspconfig), enables selected LSP servers
   - `79_mason.lua` — mason.nvim (LSP installer)
   - `999_session.lua` — session management
   - `999_vscode.lua` — VS Code-specific keybindings
3. `lua/colemak.lua` — Colemak DH mapping table (also toggled via `:ColemakEnable`/`:ColemakDisable`)
4. `lua/utils.lua` — `M.map()` wrapper, `M.copy_code_block()`
5. `lua/custom/gitgud.lua` — GitHub permalink/open helpers used by git keymaps
6. `after/lsp/{gopls,jsonls,lua_ls,yamlls}.lua` — per-server LSP config

**VS Code mode**: Many plugin files early-return `if vim.g.vscode then return end`. The config works in both nvim and VS Code.

### Claude Code Integration
- `home/.claude/settings.json` — permissions, hooks (permission dialog, destructive cmd blocker, gofmt on write), plugins
- `home/.claude/CLAUDE.md` — communication/coding guidelines for Claude Code agent
- `home/.claude/agents/` — custom agent definitions (critic, risk-reviewer)
- `home/.claude/skills/` — reusable skill files for various tasks
- `home/.claude/status` — status bar script showing tokens/cost/model/duration

### Git Config
- `home/.gitconfig` — delta diff viewer, SSH push, aliases, interactive diffFilter
- `home/.gitalias` — sourced by `.gitconfig` via `!source ~/.gitalias && ...`
- Uses `git@github.com:` insteadOf `https://github.com/`
- Git aliases in `.gitconfig` are Colemak-agnostic but use short single-letter aliases: `g a`, `g c`, `g s`, `g d`, `g f`, `g p`

### CI
- GitHub Actions: ShellCheck on push/PR, Dependabot auto-merge for patch updates

### Submodules
- `.config/mpv/scripts/subs2srs` — https://github.com/Ajatt-Tools/mpvacious

## Conventions
- **Shell**: `#!/usr/bin/env bash` with `set -euo pipefail`
- **Neovim**: `vim.pack.add` for plugins, `_G.Config.new_autocmd()` for autocmds, `utils.map()` for keybindings
- **Lua**: `local` everywhere, no OOP, `local M = {}` return pattern for modules
- **Stow**: `.stowrc` sets `--no-folding`; setup commands use `--restow`

## Gotchas
- `.profile` on Linux auto-launches Hyprland on tty1 — **do not edit blindly on macOS**
- `setupDots` resolves paths from its own location, so it can be run from outside the repo root
- Ghostty cmd-keybindings pass through to tmux (`cmd+a` → `\x1ba`) — this is how Colemak navigation reaches tmux
- nvim `plugin/` files load in **alphanumeric order by filename** — the `10_`/`20_`/`30_` prefixes enforce order
- Go format-on-save in nvim runs `organizeImports` code action BEFORE format (see `41_lsp_format.lua`)
- `vim.pack.add` is neovim 0.12+ built-in — do not confuse with lazy.nvim
