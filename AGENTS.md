# dotfiles

Stow-managed personal dotfiles. GitHub: `github.com/alx99/dotfiles`.

## Repo shape

- **Stow packages:** `home/` → `~`, `.config/` → `~/.config`, `.local/` → `~/.local`. `.stowrc` sets `--no-folding`. `home/.stow-local-ignore` skips `node_modules`.
- `make user-cfg` → `./init.sh 1`. Full menu: `1` user config, `2` Linux (Arch), `3` Mac system.
- **Submodule:** `.config/mpv/scripts/subs2srs` → `Ajatt-Tools/mpvacious` (path name is misleading; it IS mpvacious).
- `.gitignore` excludes `.worktrees/` and `worktrees/`.
- **200 tracked files.** No top-level build system — only "build" is `make user-cfg`. CI: shellcheck via reviewdog.
- Layout: `.local/bin/` (scripts), `.config/` (program configs), `home/.claude/`, `home/.agents/skills/`, `home/.pi/agent/`, `pi-web/`, `misc/` (system-level configs: XKB, keyd, systemd, pacman hooks).

## Repo symlinks (not stow-created)

- `CLAUDE.md` → `AGENTS.md` — both names resolve to same file.
- `home/.bash_profile` → `.profile` — login shells source the POSIX profile.
- `home/.codex/AGENTS.md` → `../.claude/CLAUDE.md` — Codex reads Claude's persona file.

`home/.pi/agent/` contains only: `APPEND_SYSTEM.md` (injected into system prompt), `extensions/`, `settings.json`, `skills/init/`. Subagent roles live at `extensions/subagents/agents/{default,scout,worker}.md`; no top-level `agents/` and no `supervisor.md`.

## Setup invariants (init.sh 1)

- `init.sh` shares `~/.agents/skills/<skill>` with `~/.claude/skills/<skill>` via per-skill symlinks. Uses `is_stale_dotfile_entry` to avoid clobbering content from `npx agents` — never `rm -rf` a `~/.claude/skills/<x>` that the script flagged as "not a stale dotfile leftover."
- Stow order matters: `.local` first, then `home`, then `.config`. `~/.config` and `~/.agents` must exist before stow runs. Broken dotfile-repo symlinks are cleaned up first via `remove_broken_symlinks`.
- Linux: `init.sh 2` requires sudo for XKB/keyd/systemd units, enables `systemctl --user` ssh-agent, links `dash` to `/usr/bin/sh`.
- Mac: `init.sh 3` installs `~/Library/Keyboard Layouts/Colemak-DH-ANSI.keylayout`, prompts user to enable manually in System Settings. No auto-reboot.
- After first `make user-cfg`, run `make pi` to install npm deps for pi extensions (stow does not manage `node_modules/`).

## Two AI ecosystems in parallel

| Tool | Source in repo | Notes |
|------|----------------|-------|
| **pi** | `home/.pi/agent/` | Primary. `defaultProvider`: `openmodel`, `defaultModel`: `deepseek-v4-flash`, `defaultThinkingLevel`: `high`. `enabledModels`: `opencode-go/glm-5.2`, `tokenrouter/MiniMax-M3`, `openai-codex/gpt-5.5`, `openmodel/deepseek-v4-flash`. Packages: `git:github.com/obra/superpowers` + `npm:@ff-labs/pi-fff`. `APPEND_SYSTEM.md` injects persona. `retry`: `maxRetries: 10`. `hideThinkingBlock: true`. |
| **pi-web** | `pi-web/` | Localhost browser UI for pi (drop-in TUI replacement, same sessions). **Separate Node project, not part of `home/.pi/agent/extensions/`.** Frontend is Preact + JSX/TypeScript built by Vite to `dist/` (served by the Node server). Dev: `npm run dev` runs Vite (`:5173`, HMR) + API (`:7878`) via `concurrently`, proxying `/ws` to the API; set `PI_WEB_OPEN=false` to skip auto-open. Prod: `npm start` = `vite build && tsx src/server.ts` → `http://127.0.0.1:7878`. See `pi-web/docs/smoke-test.md` for the manual verification checklist. |
| **Claude Code** | `home/.claude/` + `home/.agents/skills/` | Model: `opusplan`, language: `japanese`. **Denies `Bash(find:*)` and `Bash(grep:*)`** — agents must use Glob/Grep tools. `alwaysThinkingEnabled: true`. Hooks: PermissionRequest → `claude-permission-dialog` (macOS), PostToolUse → `gofmt -w` on `.go` (skips `*gen.go`), Stop → macOS notification. Plugins: `superpowers@superpowers-marketplace`, `lsp@alx99-personal`. Agents at `home/.claude/agents/{critic,risk-reviewer}.md`. `status` script is the statusline. |
| **Codex** | `home/.codex/` | Just the symlink to Claude's CLAUDE.md. No other config. |

**Skill rules live in two places** by design:
- `home/.pi/agent/skills/` — pi-only skills (currently only `init/`).
- `home/.agents/skills/` — harness-agnostic skills mirrored to `~/.claude/skills/` for Claude Code by `init.sh`. Current set: `commit`, `create-pr`, `code-guidelines`, `comprehensive-review`, `go-code`, `go-testing`.

New skills go under `home/.agents/skills/` — the mirror to `~/.claude/skills/` propagates via `init.sh`. Most skills listed in the available-skills block (firecrawl/*, codebase-design, domain-modeling, brainstorming, etc.) come from the **superpowers package** (`git:github.com/obra/superpowers`), not from local skill files.

## pi extensions

Extensions live under `home/.pi/agent/extensions/` (stowed to `~/.pi/agent/extensions/`).

- `make pi` — shortcut for `cd ~/.pi/agent/extensions && npm install`. Required after first `make user-cfg` or `package.json` changes.
- `make check` — runs `cd home/.pi/agent/extensions && npm run check` → `tsc` → `eslint` → `node --test '**/tests/*.test.ts'`.

**Pi's extension loader discovers `.ts` files directly in `extensions/` AND subdirectory entry points `extensions/*/index.ts`** (and `extensions/*/` with a `package.json` `pi` field). `memory/` and `subagents/` load via the subdirectory-`index.ts` pattern. `eslint.config.mjs` ends in `.mjs` so pi's loader skips it.

**No tests are checked into `home/.pi/agent/extensions/`** — `node --test '**/tests/*.test.ts'` matches zero files. The `tsc` and `eslint` steps still run; the test step is a no-op. Don't infer "tests passed" from a green `make check`. Tests live in `pi-web/tests/` (5 files: bridge, open-browser, protocol, runtime, server).

Active extensions (each entry point is a file in `home/.pi/agent/extensions/`):
- **`subagents/index.ts`** — `spawn_agent` tool. `agents/{default,scout,worker}.md` define roles, `process.ts` runs the child as `pi --mode json --print --no-session` (depth capped at 3 via `PI_SUBAGENT_DEPTH`).
- **`memory/index.ts`** — `memory_save` tool + `/memory` and `/memory-capture` commands. Injects memory block into system prompt on `before_agent_start`. User must approve each `memory_save` via UI confirmation. Memory files: `global` at `$XDG_STATE_HOME/pi-agent/memory/global.md`, `repo` at `<git-root>/.pi/memory/repo.md`. 32 KB cap per file.
- **`ask_question.ts`** — `ask_question` tool (multiple choice with auto-added "Ask AI for pros and cons" and "Something else"). **Registers only when `ctx.hasUI`** — in non-interactive runs the tool is absent from the agent's tool list.
- **`caffeinate.ts`** — Prevents macOS sleep during agent runs (spawns `/usr/bin/caffeinate` on `agent_start`, kills on `agent_end`).
- **`cost-saver.ts`** — Intercepts read tool calls: blocks full-file reads > 50 KB (forces offset/limit), deduplicates repeated reads of unchanged files via SHA-256 hash.
- **`cost-tracker.ts`** — `/analyze-cost` interactive dashboard (day/week/month breakdown by model and tool count). Reads JSONL session logs.
- **`footer.ts`** — Custom footer: left side shows cwd, git branch, model + thinking level; right side shows extension statuses, session tokens (in/out/cache hit rate), context usage bar.

## .profile secrets (not obvious from the file alone)

- `PI_FFF_MODE=override` — `@ff-labs/pi-fff` replaces pi's built-in `grep`/`find` tools with FFF (same tool names, FFF engine underneath). In non-override mode they register as `ffgrep`/`ffind` instead.
- `DISABLE_TELEMETRY=1` — disables Claude Code telemetry.
- `NPM_CONFIG_IGNORE_SCRIPTS=true` — npm installs skip lifecycle scripts.

## Colemak-DH and theme colors

Colemak-DH is wired into every layer: nvim (`.config/nvim/lua/colemak.lua`), tmux (`.config/tmux/tmux.conf` and copy-mode), sail (`.config/sail/config.yaml`), keyd (`misc/keymaps/keyd.conf`), karabiner (`.config/karabiner/karabiner.json`), ghostty (cmd-h/m/j/n/k/e/l/i keybinds in `.config/ghostty/config` send QWERTY-coded bytes so the OS sees the Colemak intent), **and readline** (`home/.inputrc`: vi mode, `n`=history-search-forward, `e`=history-search-backward, `i`=forward-char, `k`=backward-char). The four swapped keys: `h↔m`, `j↔n`, `k↔e`, `l↔i`.

The xterm-256 color palette is the source of truth in **three** files and must stay in sync: `home/.bashrc` (PS1), `home/.profile` (LS_COLORS via the inline `__ls_colors` function), and `.config/ghostty/config` (palette + status colors). Theme constants: `245 203 114 179 75 141 109` (slate red green yellow blue purple cyan).

## CI

Two GitHub Actions, both on push and PR:
- `automerge.yml` — auto-merges Dependabot PRs for github-actions and gitsubmodules when update-type is `semver-patch`. Has `contents: write` and `pull-requests: write`.
- `linter.yml` — `reviewdog/action-shellcheck` with `check_all_files_with_shebangs: true`. Scans every tracked script with a shebang.

No tests run in CI. No formatter runs in CI.

## Local hooks (Claude Code)

`home/.claude/settings.json` hooks:
- `PermissionRequest` → `~/.local/bin/claude-permission-dialog` (interactive macOS prompt for non-trivial permission requests).
- `PostToolUse` on `Write|Edit|MultiEdit` → `gofmt -w` on edited `.go` files (skips `*gen.go`).
- `Stop` → macOS notification naming the cwd (`osascript -e "display notification …"`).

## Verification gates (when changing things)

No automated tests. Manual gates that catch real breakage:
- `make user-cfg` — full stow restow. If this fails, the change is broken at the symlink level.
- `shellcheck $(git ls-files | xargs file | grep -i 'shell script' | cut -d: -f1)` — CI runs this; mirror it locally before pushing.
- `bash -n home/.bashrc home/.profile` — syntax check the shell init.
- `command -v stow` — `init.sh` hard-requires GNU stow (BSD `find` is patched for macOS compat, but stow itself is the package manager).
- `make check` — typecheck, lint, and (no-op) test for the pi extensions.
- `cd pi-web && npm run build && npm run typecheck && npm test` — verify the pi-web project after changes there (`build` runs Vite to confirm the frontend bundles; `typecheck` covers both `tsconfig.json` + `tsconfig.app.json`). Manual smoke checklist: `pi-web/docs/smoke-test.md`.
