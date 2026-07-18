# dotfiles

Stow-managed personal dotfiles. GitHub: `github.com/alx99/dotfiles`.

## Repo shape

- **Stow packages:** `home/` → `~`, `.config/` → `~/.config`, `.local/` → `~/.local`. `.stowrc` sets `--no-folding`. `home/.stow-local-ignore` skips `node_modules`.
- **Setup:** `just user-config` for dotfiles, `just linux-system` for Arch system configuration, and `just mac-system` for the macOS keyboard layout. Run `just` to list recipes.
- **Submodule:** `.config/mpv/scripts/subs2srs` → `Ajatt-Tools/mpvacious` (path name is misleading; it IS mpvacious).
- `.gitignore` excludes `.worktrees/` and `worktrees/`.
- Top-level setup and checks are exposed as Justfile recipes. CI runs shellcheck via reviewdog.
- Layout: `.local/bin/` (scripts), `.config/` (program configs), `home/.claude/`, `home/.agents/skills/`, `home/.pi/agent/`, `pi-web/`, `misc/` (system-level configs: XKB, keyd, systemd, pacman hooks).

## Repo symlinks (not stow-created)

- `CLAUDE.md` → `AGENTS.md` — both names resolve to same file.
- `home/.bash_profile` → `.profile` — login shells source the POSIX profile.
- `home/.codex/AGENTS.md` → `../.claude/CLAUDE.md` — Codex reads Claude's persona file.

`home/.pi/agent/` contains only: `APPEND_SYSTEM.md` (injected into system prompt), `extensions/`, `settings.json`, `skills/init/`. Subagent roles live at `extensions/subagents/agents/{general,scout,worker}.md`; no top-level `agents/` and no `supervisor.md`.

## Setup invariants (`just user-config`)

- The `user-config` recipe shares `~/.agents/skills/<skill>` with `~/.claude/skills/<skill>` via per-skill symlinks. It creates only missing links, leaving content from `npx agents` and other tools untouched.
- Stow order matters: `.local` first, then `home`, then `.config`. `~/.config` and `~/.agents` must exist before stow runs. Broken links into this repository and broken Claude-to-agent skill links are cleaned up first.
- `just linux-system` requires sudo for XKB/keyd/systemd units, enables the user ssh-agent, and links `dash` to `/usr/bin/sh`.
- `just mac-system` installs `~/Library/Keyboard Layouts/Colemak-DH-ANSI.keylayout` and prompts the user to enable it manually in System Settings. No auto-reboot.
- After the first dotfile install, run `just install-pi` to install npm deps for Pi extensions (stow does not manage `node_modules/`).

## Two AI ecosystems in parallel

| Tool | Source in repo | Notes |
|------|----------------|-------|
| **pi** | `home/.pi/agent/` | Primary. `defaultProvider`: `openmodel`, `defaultModel`: `deepseek-v4-flash`, `defaultThinkingLevel`: `high`. `enabledModels`: `opencode-go/glm-5.2`, `tokenrouter/MiniMax-M3`, `openai-codex/gpt-5.5`, `openmodel/deepseek-v4-flash`. Packages: `git:github.com/obra/superpowers` + `npm:@ff-labs/pi-fff`. `APPEND_SYSTEM.md` injects persona. `retry`: `maxRetries: 10`. `hideThinkingBlock: true`. |
| **pi-web** | `pi-web/` | Localhost browser UI for pi (drop-in TUI replacement, same sessions). **Separate Node project, not part of `home/.pi/agent/extensions/`.** Frontend is Preact + JSX/TypeScript built by Vite to `dist/` (served by the Node server). Dev: `npm run dev` runs Vite (`:5173`, HMR) + API (`:7878`) via `concurrently`, proxying `/ws` to the API; set `PI_WEB_OPEN=false` to skip auto-open. Prod: `npm start` = `vite build && tsx src/server.ts` → `http://127.0.0.1:7878`. See `pi-web/docs/smoke-test.md` for the manual verification checklist. |
| **Claude Code** | `home/.claude/` + `home/.agents/skills/` | Model: `opusplan`, language: `japanese`. **Denies `Bash(find:*)` and `Bash(grep:*)`** — agents must use Glob/Grep tools. `alwaysThinkingEnabled: true`. Hooks: PostToolUse → `gofmt -w` on `.go` (skips `*gen.go`), Stop → macOS notification. Plugins: `superpowers@superpowers-marketplace`, `lsp@alx99-personal`. Agents at `home/.claude/agents/{critic,risk-reviewer}.md`. `status` script is the statusline. |
| **Codex** | `home/.codex/` | Just the symlink to Claude's CLAUDE.md. No other config. |

**Skill rules live in two places** by design:
- `home/.pi/agent/skills/` — pi-only skills (currently only `init/`).
- `home/.agents/skills/` — harness-agnostic skills mirrored to `~/.claude/skills/` for Claude Code by `just user-config`. Current set: `commit`, `create-pr`, `code-guidelines`, `comprehensive-review`, `go-code`, `go-testing`.

New skills go under `home/.agents/skills/` — the mirror to `~/.claude/skills/` propagates via `just user-config`. Most skills listed in the available-skills block (firecrawl/*, codebase-design, domain-modeling, brainstorming, etc.) come from the **superpowers package** (`git:github.com/obra/superpowers`), not from local skill files.

## pi extensions

Extensions live under `home/.pi/agent/extensions/` (stowed to `~/.pi/agent/extensions/`).

- `just install-pi` — shortcut for `cd ~/.pi/agent/extensions && npm install`. Required after the first dotfile install or `package.json` changes.
- `just check` — runs `cd home/.pi/agent/extensions && npm run check` → Pi/native-patch compatibility check → Oxfmt check → strict `tsc` → type-aware Oxlint (zero warnings) → all Node tests.
- Pi `0.80.10`, Pi AI, and Pi TUI are one pinned compatibility unit. After installing or upgrading the global Pi package, run `node misc/pi-patches/apply-pi-ai-0.80.10.mjs` and then the same command with `--check`; `npm run compatibility:check` verifies package versions and that the local Pi AI tree has a recognized original or patched image.

**Pi's extension loader discovers `.ts` files directly in `extensions/` AND subdirectory entry points `extensions/*/index.ts`** (and `extensions/*/` with a `package.json` `pi` field). `ask-question/`, `codex-compat/`, `cost-tracker/`, and `subagents/` load via the subdirectory-`index.ts` pattern; `_shared/` deliberately has no `index.ts`.

Tests for shared helpers, compatibility, subagents, and other Pi extensions live under `home/.pi/agent/extensions/**/tests/`. `just check` runs all `.test.ts` and `.test.mjs` files. Pi-web has its own tests under `pi-web/tests/`.

Active extensions (top-level `.ts` files and subdirectory `index.ts` files are entry points):
- **`subagents/index.ts`** — persistent RPC-backed subagent tool family: `spawn_agent`, `send_agent`, `followup_agent`, `wait_agent`, `list_agents`, `interrupt_agent`, and `close_agent`. `agents/{general,scout,worker}.md` define roles; `managed-agent.ts` and `agent-registry.ts` own lifecycle, `rpc-transport.ts` owns persistent `pi --mode rpc` children, and `event-schema.ts`/`run-state.ts` validate and fold bounded observational state. `host.ts`, `rpc.ts`, and `process.ts` are compatibility facades (delegation depth capped at 2).
- **`codex-compat/index.ts`** — version-locked OpenAI Codex `apply_patch` filesystem tool. It depends on the reviewed native Pi AI patch under `misc/pi-patches/` and replaces `edit`/`write` only for the `openai-codex` provider.
- **`ask-question/index.ts`** — `ask_question` tool (multiple choice with auto-added "Compare options" and "Something else"). **Registers only when `ctx.hasUI`** — in non-interactive runs the tool is absent from the agent's tool list.
- **`caffeinate.ts`** — Prevents macOS sleep during agent runs (spawns `/usr/bin/caffeinate` on `agent_start`, kills on `agent_end`).
- **`cost-saver.ts`** — Intercepts read tool calls: blocks full-file reads > 50 KB (forces offset/limit), deduplicates repeated reads of unchanged files via SHA-256 hash.
- **`cost-tracker/index.ts`** — `/analyze-cost` interactive dashboard (day/week/month breakdown by model and tool count). Streams JSONL session logs.
- **`footer.ts`** — Custom footer: left side shows cwd, git branch, model + thinking level; right side shows extension statuses, session tokens (in/out/cache hit rate), context usage bar.
- **`model-shortcuts.ts`** — Alt+1/2/3 shortcuts for the configured Luna, Terra, and Sol model presets.

## .profile secrets (not obvious from the file alone)

- `PI_FFF_MODE=override` — `@ff-labs/pi-fff` replaces pi's built-in `grep`/`find` tools with FFF (same tool names, FFF engine underneath). In non-override mode they register as `ffgrep`/`ffind` instead.
- `DISABLE_TELEMETRY=1` — disables Claude Code telemetry.
- `NPM_CONFIG_IGNORE_SCRIPTS=true` — npm installs skip lifecycle scripts.

## Colemak-DH and theme colors

Colemak-DH is wired into every layer: nvim (`.config/nvim/lua/colemak.lua`), tmux (`.config/tmux/tmux.conf` and copy-mode), sail (`.config/sail/config.yaml`), keyd (`misc/keymaps/keyd.conf`), karabiner (`.config/karabiner/karabiner.json`), ghostty (cmd-h/m/j/n/k/e/l/i keybinds in `.config/ghostty/config` send QWERTY-coded bytes so the OS sees the Colemak intent), **and readline** (`home/.inputrc`: vi mode, `n`=history-search-forward, `e`=history-search-backward, `i`=forward-char, `k`=backward-char). The four swapped keys: `h↔m`, `j↔n`, `k↔e`, `l↔i`.

The xterm-256 color palette is the source of truth in **three** files and must stay in sync: `home/.bashrc` (PS1), `home/.profile` (LS_COLORS via the inline `__ls_colors` function), and `.config/ghostty/config` (palette + status colors). Theme constants: `245 203 114 179 75 141 109` (slate red green yellow blue purple cyan).

## CI

Three GitHub Actions run on push and PR:
- `automerge.yml` — auto-merges Dependabot PRs for github-actions and gitsubmodules when update-type is `semver-patch`. Has `contents: write` and `pull-requests: write`.
- `linter.yml` — `reviewdog/action-shellcheck` with `check_all_files_with_shebangs: true`. Scans every tracked script with a shebang.
- `extensions.yml` — path-scoped Pi extension gate on Node 22.19: clean install, Pi/native-patch compatibility, formatting, strict typecheck, type-aware lint with zero warnings, and all extension tests.

The extension workflow runs tests and formatter checks; the general shell workflow does not.

## Local hooks (Claude Code)

`home/.claude/settings.json` hooks:
- `PostToolUse` on `Write|Edit|MultiEdit` → `gofmt -w` on edited `.go` files (skips `*gen.go`).
- `Stop` → macOS notification naming the cwd (`osascript -e "display notification …"`).

## Verification gates (when changing things)

Automated extension tests run through `just check`; manual gates that catch stow, shell, and runtime breakage:
- `just user-config` — full stow restow. If this fails, the change is broken at the symlink level.
- `shellcheck $(git ls-files | xargs file | grep -i 'shell script' | cut -d: -f1)` — CI runs this; mirror it locally before pushing.
- `bash -n home/.bashrc home/.profile` — syntax check the shell init.
- `command -v just stow` — setup requires Just and GNU Stow (the recipe remains compatible with BSD `find` on macOS).
- `just check` — compatibility, formatting, strict typecheck, type-aware lint, and all Pi extension tests.
- `cd pi-web && npm run build && npm run typecheck && npm test` — verify the pi-web project after changes there (`build` runs Vite to confirm the frontend bundles; `typecheck` covers both `tsconfig.json` + `tsconfig.app.json`). Manual smoke checklist: `pi-web/docs/smoke-test.md`.
