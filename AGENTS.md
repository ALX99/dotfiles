# dotfiles

Stow-managed personal dotfiles. GitHub: `github.com/alx99/dotfiles`.

## Shape

- **Stow packages:** `home/` → `~`, `.config/` → `~/.config`, `.local/` → `~/.local`. `.stowrc` sets `--no-folding`. `.stow-local-ignore` skips `node_modules`.
- **One Makefile target** (`make user-cfg` → `./init.sh 1`). Full menu in `init.sh`: `1` user config, `2` Linux system (Arch), `3` Mac system.
- **Submodule:** `.config/mpv/scripts/subs2srs` → `Ajatt-Tools/mpvacious` (path name is misleading; it is mpvacious, not subs2srs).
- **182 tracked files.** No test framework, no build system. The only "build" is `make user-cfg`. The only "lint" is shellcheck via CI.

## Symlinks in the repo (not stow-created)

- `CLAUDE.md` (repo root) → `AGENTS.md` — both names resolve to the same file.
- `home/.bash_profile` → `.profile` — login shells source the POSIX profile.
- `home/.codex/AGENTS.md` → `../.claude/CLAUDE.md` — Codex reads Claude's instruction file.

Runtime: `~/.pi/agent/extensions/<name>.ts` (and `agents/*.md`, `supervisor.md`) are symlinks back into the dotfiles. **Pi's extension loader only auto-discovers from `<agentDir>/extensions/`** — placing an extension at `~/.pi/agent/<name>/` (one level up) makes it invisible. See `home/.pi/agent/extensions/` for the canonical set.

## Setup invariants (init.sh 1)

- `init.sh` shares `~/.agents/skills/<skill>` with `~/.claude/skills/<skill>` via per-skill symlinks. Uses `is_stale_dotfile_entry` to avoid clobbering content from `npx agents` or other tools — never `rm -rf` a `~/.claude/skills/<x>` that the script flagged as "not a stale dotfile leftover."
- User config stow order matters: `.local` first, then `home`, then `.config`. `~/.config` and `~/.agents` must exist before stow runs. Broken dotfile repo symlinks are cleaned up before stow via `remove_broken_symlinks`.
- `home/.stow-local-ignore` ignores `node_modules` to avoid stowing npm install dirs.
- Linux: `init.sh 2` requires sudo for XKB/keyd/systemd units, enables `systemctl --user` ssh-agent, links `dash` to `/usr/bin/sh`.
- Mac: `init.sh 3` installs `~/Library/Keyboard Layouts/Colemak-DH-ANSI.keylayout` and prompts the user to enable it manually in System Settings. No auto-reboot.
- After first `make user-cfg`, run `make pi` to install npm deps for pi extensions (`home/.pi/agent/extensions/`).

## pi extensions

Extensions live under `home/.pi/agent/extensions/` (stowed to `~/.pi/agent/extensions/`). Development commands (run from `home/.pi/agent/extensions/`):
- `npm run check` — runs `tsc`, then `eslint`, then `node --test '**/tests/*.test.ts'`
- `make pi` — shortcut for `cd ~/.pi/agent/extensions && npm install`

**Pi's extension loader discovers `.ts` files directly in `extensions/` AND subdirectory entry points `extensions/*/index.ts`** (and `extensions/*/` with a `package.json` `pi` field). `missions/index.ts`, `goals/`-style, `memory/`, and `subagents/` all load via the subdirectory-`index.ts` pattern. `eslint.config.mjs` ends in `.mjs` so pi's loader skips it.

Active extensions (each entry point is a file in `home/.pi/agent/extensions/`):
- **`subagents/index.ts`** — spawn_agent tool. `agents/*.md` define roles (default/scout/reviewer/worker), `process.ts` runs the child. No standalone `supervisor.md` file.
- **`missions/index.ts`** — Evidence-gated mission loop (replaces `goals`). `/mission start|status|freeze|stop|resume|show|list` command plus 11 tools (`mission_status`, `mission_add_acceptance_item`, `mission_create_work_item`, `mission_supersede_work_item`, `mission_set_final_verify`, `mission_claim_item`, `mission_heartbeat`, `mission_record_progress`, `mission_submit_item`, `mission_request_decision`, `mission_finish_candidate`). Controller runs frozen verify commands itself via `pi.exec` and records real exit codes; a claim/attempt lease with expiry is reaped on `session_start` so crashes don't deadlock. SQLite at `$PI_AGENT_DIR/missions.db` (missions/items/attempts/events). zod + neverthrow + typebox. Acceptance items are human-frozen at `/mission freeze` and gate completion; work items are agent-owned (created/superseded while running) and do not grant completion. A frozen mission-level final verifier (`mission_set_final_verify`, set during planning) must also pass. Phase 1: state machine + controller-enforced verification; the `agent_end` auto-re-entry controller is phase 2. Design spec: `docs/superpowers/specs/2026-06-20-mission-loop-design.md`.
- **`memory/index.ts`** — memory_save tool + `/memory` and `/memory-capture` commands. Injects memory block into system prompt on each agent start. User must approve each memory_save via UI confirmation.
- **`caffeinate.ts`** — Prevents macOS sleep during agent runs (spawns `/usr/bin/caffeinate` on agent_start, kills on agent_end).
- **`cost-saver.ts`** — Intercepts read tool calls: blocks full-file reads > 50 KB (forces offset/limit), deduplicates repeated reads of unchanged files via SHA-256 hash.
- **`cost-tracker.ts`** — `/analyze-cost` interactive dashboard (day/week/month breakdown by model and tool count). Reads JSONL session logs.
- **`ask_question.ts`** — ask_question tool (multiple choice with auto-added "Ask AI for pros and cons" and "Something else").
- **`footer.ts`** — Custom footer: left side shows cwd, git branch, model + thinking level; right side shows extension statuses, session tokens (in/out/cache hit rate), context usage bar.

Subagent protocol: `subagents/index.ts` (top-level loader) → `subagents/agents/*.md` (role definitions: default, scout, reviewer, worker) + `subagents/process.ts` (execution). No standalone `supervisor.md` file.

## Two AI ecosystems in parallel

| Tool | Source in repo | Notes |
|------|----------------|-------|
| **pi** | `home/.pi/agent/` | Primary. `settings.json` uses provider `openmodel`, model `deepseek-v4-flash`, packages: `superpowers` + `pi-fff`. `APPEND_SYSTEM.md` injects persona. No local `supervisor.md` — subagent protocol is in the extensions directory. Also configured with `enabledModels` including `tokenrouter/MiniMax-M3` and `openai-codex/gpt-5.5`. |
| **Claude Code** | `home/.claude/` + `home/.agents/skills/` | `settings.json` has hooks (gofmt on .go files, macOS notification on Stop), permissions allowlist, plugins (`superpowers`, `lsp@alx99-personal`). `status` script is the statusline. |
| **Codex** | `home/.codex/` | Just the symlink to Claude's CLAUDE.md. No other config. |

**Skill rules live in two places** by design:
- `home/.pi/agent/skills/` — pi-only skills (currently only `init/`).
- `home/.agents/skills/` — canonical, mirrored to `~/.claude/skills/` for Claude Code by `init.sh`.

The repo is mid-migration to **harness-agnostic skills** under `home/.agents/skills/` (see commits `dda9450`, `252c8ff`, `00d3f68`). Don't write new pi-specific skills — write them under `home/.agents/skills/` and let the mirror propagate.

Most listed skills in the available-skills block (firecrawl/*, codebase-design, domain-modeling, brainstorming, etc.) come from the **superpowers package** (`git:github.com/obra/superpowers`), not from local skill files.

## .profile secrets (not obvious from the file alone)

- `PI_FFF_MODE=override` — replaces pi's built-in find/grep with FFF (`@ff-labs/pi-fff` package).
- `DISABLE_TELEMETRY=1` — disables Claude Code telemetry.
- `NPM_CONFIG_IGNORE_SCRIPTS=true` — npm installs skip lifecycle scripts.

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
- `make check` — typecheck, lint, and test the pi extensions.
