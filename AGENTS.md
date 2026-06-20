# dotfiles

Stow-managed personal dotfiles. Forked from `alx99/dotfiles` and heavily modified — README and `.gitconfig` still reference ALX99 (deliberate, do not "fix" without asking).

## Shape

- **Stow packages:** `home/` (→ `~`), `.config/` (→ `~/.config`), `.local/` (→ `~/.local`). `.stowrc` sets `--no-folding`.
- **One Makefile target** (`make user-cfg` → `./init.sh 1`). Full menu in `init.sh`: `1` user config, `2` Linux system (Arch), `3` Mac system.
- **Submodule:** `.config/mpv/scripts/subs2srs` → `Ajatt-Tools/mpvacious` (path name is misleading; it is mpvacious, not subs2srs).
- **Scratch dir:** `tmp/` is **untracked** (`.gitignore` and `git status` confirm). Do not put real work there.
- **170 tracked files.** No test framework, no build system. The only "build" is `make user-cfg`. The only "lint" is shellcheck via CI.

## Symlinks in the repo (not stow-created)

- `CLAUDE.md` (repo root) → `AGENTS.md` — both names resolve to the same file.
- `home/.bash_profile` → `.profile` — login shells source the POSIX profile.
- `home/.codex/AGENTS.md` → `../.claude/CLAUDE.md` — Codex reads Claude's instruction file.

Runtime: `~/.pi/agent/extensions/<name>.ts` (and `agents/*.md`, `supervisor.md`) are symlinks back into the dotfiles. **Pi's extension loader only auto-discovers from `<agentDir>/extensions/`** — placing an extension at `~/.pi/agent/<name>/` (one level up) makes it invisible. Same for `agents/`, `prompts/`, `skills/`. See `home/.pi/agent/extensions/subagents/` and the deleted-then-moved history in `git status`.

## Setup invariants

- `init.sh` shares `~/.agents/skills/<skill>` with `~/.claude/skills/<skill>` via per-skill symlinks. It uses `is_stale_dotfile_entry` to avoid clobbering content from `npx agents` or other tools — never `rm -rf` a `~/.claude/skills/<x>` that the script flagged as "not a stale dotfile leftover."
- Linux: `init.sh 2` requires sudo for XKB/keyd/systemd units, enables `systemctl --user` ssh-agent, links `dash` to `/usr/bin/sh`.
- Mac: `init.sh 3` installs `~/Library/Keyboard Layouts/Colemak-DH-ANSI.keylayout` and prompts the user to enable it manually in System Settings. No auto-reboot.
- `home/.privrc` is **tracked** and is sourced from `~/.bashrc`. It holds private env vars (e.g., `TOKENROUTER_API_KEY`). Treat as secret.

## Two AI ecosystems in parallel

| Tool | Source in repo | Notes |
|------|----------------|-------|
| **pi** | `home/.pi/agent/` | Primary. `settings.json` (provider tokenrouter, model `MiniMax-M3`, ponytail full, packages: ponytail, superpowers, pi-fff). `APPEND_SYSTEM.md` injects persona. `supervisor.md` is the goal-driven subagent protocol. |
| **Claude Code** | `home/.claude/` + `home/.agents/skills/` | `settings.json` has hooks (gofmt on .go, macOS notification on Stop), permissions allowlist, plugins (`superpowers@superpowers-marketplace`, `lsp@alx99-personal`). `status` script is the statusline. |
| **Codex** | `home/.codex/` | Just the symlink to Claude's CLAUDE.md. No other config. |

**Skill rules live in two places** by design:
- `home/.pi/agent/skills/` — pi-only skills.
- `home/.agents/skills/` — canonical, mirrored to `~/.claude/skills/` for Claude Code by `init.sh`.

The repo is mid-migration to **harness-agnostic skills** under `home/.agents/skills/` (see commits `dda9450`, `252c8ff`, `00d3f68`). Don't write new pi-specific skills — write them under `home/.agents/skills/` and let the mirror propagate.

## Active git state (worktree is dirty)

Staged deletions, untracked additions — the worktree is mid-restructure. Don't run `git checkout` or `git stash` blindly:
- Deleted from `home/.pi/agent/agents/`: `reviewer.md`, `scout.md`, `worker.md`. Replaced (untracked) by `home/.pi/agent/extensions/subagents/agents/{default,reviewer,scout,worker}.md`.
- Deleted from `home/.pi/agent/extensions/`: `ask-user-question.ts`, `brainstorm.ts`, `btw.ts`, `subagent/`, `tokenrouter/`. Replaced (untracked) by `ask_question.ts`, `subagents/`, plus new `goals/{storage,validation,templates,templates}.ts`.
- Modified: `home/.pi/agent/extensions/{footer,goals/index}.ts`, `home/.pi/agent/settings.json`, `home/.profile`, `home/.pi/agent/skills/init/SKILL.md`, `.config/git/ignore`, `misc/keymaps/Colemak-DH-ANSI.keylayout`.
- Untracked: `Dockerfile.cbm` (builds `DeusData/codebase-memory-mcp`), `reboot.py` (Buffalo router reboot — hardcoded creds, **don't commit**), `tmp/soulforge/` (3rd-party scratch), `symbol-layer-proposal.md`.

## Colemak-DH and theme colors

Colemak-DH keymaps are wired into every layer: nvim (`.config/nvim/lua/colemak.lua`), tmux (`.config/tmux/tmux.conf` and copy-mode), sail (`.config/sail/config.yaml`), keyd (`misc/keymaps/keyd.conf`), karabiner, ghostty passthroughs. The four swapped keys: `h↔m`, `j↔n`, `k↔e`, `l↔i`.

The xterm-256 color palette is the source of truth in **three** files and must stay in sync: `home/.bashrc` (PS1), `home/.profile` (LS_COLORS via the inline `__ls_colors` function), and `.config/ghostty/config` (palette + status colors). Theme constants: `245 203 114 179 75 141 109` (slate red green yellow blue purple cyan).

## CI

Two GitHub Actions, both on push and PR:
- `automerge.yml` — auto-merges Dependabot PRs for github-actions and gitsubmodules when update-type is `semver-patch`. Has `contents: write` and `pull-requests: write`.
- `linter.yml` — `reviewdog/action-shellcheck` with `check_all_files_with_shebangs: true`. Scans every tracked script with a shebang.

No tests run in CI. No formatter runs in CI.

## Local hooks (Claude Code)

`home/.claude/settings.json` PostToolUse hook runs `gofmt -w` on edited `.go` files (skips `*gen.go`). Stop hook fires a macOS notification naming the cwd. PreToolUse/PermissionRequest hooks run `~/.local/bin/claude-permission-dialog`.

## Verification gates (when changing things)

No automated tests. Manual gates that catch real breakage:
- `make user-cfg` — full stow restow. If this fails, the change is broken at the symlink level.
- `shellcheck $(git ls-files | xargs file | grep -i 'shell script' | cut -d: -f1)` — CI runs this; mirror it locally before pushing.
- `bash -n home/.bashrc home/.profile` — syntax check the shell init.
- `command -v stow` — `init.sh` hard-requires GNU stow (BSD `find` is patched for macOS compat, but stow itself is the package manager).
