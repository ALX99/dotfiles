# Repository Map

## Repository Purpose

This Stow-managed personal repository holds shell tooling, desktop applications, system setup, and AI-agent configuration. `.local/`, `home/`, and `.config/` are packages installed into `~/.local`, `~`, and `~/.config`; `.stowrc` deliberately disables Stow folding.

## Architecture and Ownership

- `.local/bin/` owns user executables. `home/` owns configuration, including Bash, SSH, Git, and agent files. Start shell changes at `home/.profile`, `home/.bashrc`, and `home/.bashrc.d/`.
- `.config/` owns application configuration. Neovim starts at `.config/nvim/init.lua`; compositor, terminal, and other desktop settings live beside it. Karabiner's installed JSON is generated from `misc/karabiner/karabiner.cue`. Herdr plugins share CLI execution and validated workspace fields through `.config/herdr/plugins/_shared/herdrlib.py`; each plugin owns its Git or installation policy.
- `misc/` owns Arch, systemd, pacman-hook, and keyboard assets. `.devcontainer/` defines the Arch development environment rather than the installed host configuration.
- `home/.agents/skills/` contains harness-independent skills. Pi-specific settings, prompts, themes, and skills belong in `home/.pi/agent/`; do not put Pi-only material in the shared skill tree. `home/.pi/agent/settings.json` owns local Pi defaults and external package registrations.
- `home/.pi/agent/extensions/` is a strict TypeScript/NodeNext package. Root `*.ts` and feature `*/index.ts` files are extension entry points; `_shared/` supplies common support and `**/tests/` owns coverage. `subagents/` owns in-process child conversations, roles, profiles, and result recovery: `ManagedAgent` owns one Pi `AgentSession` and its current generation, `AgentRegistry` owns live/archive visibility, and native child session entries are the durable source for exact results. Children receive normal project resources and role tools but not subagent delegation; one-shot children close after settlement, while retained children permit follow-ups. `process-reaper/` owns session-scoped Bash process-group markers and cleanup for agent-started background descendants. `skills/` owns `/skills` discovery, validation, token accounting, and the pre-first-turn model-visibility overlay while preserving Pi's native `/skill:name` expansion. `ask-question/` and `codex-apply-patch/` own their corresponding tools. `copy-code/` owns code-block clipboard selection; `nested-context.ts` loads subtree instruction files as tools touch files below the session working directory. The root `caffeinate.ts`, `footer.ts`, and `model-shortcuts.ts` entry points own small host-integration features.

## Key Flows and Sources of Truth

`mise run install` restows the three user packages and links shared skills; it can change `$HOME` and enable the user `ssh-agent`. `mise.toml` owns the bootstrap manifest and tools; `.mise/tasks/` owns automation as standalone scripts (entry points flat, subsystem work namespaced like `pi:check`, `karabiner:gen`). Together they are the source for installation and host setup. `mise run check` runs Pi checks, Herdr tests, and shell syntax/behavior tests. GitHub Actions runs those checks for relevant changes and ShellCheck for all changes. Shell behavior tests live in `tests/shell/`; Herdr tests run in separate Python interpreters because plugins reuse module names.

Within Pi extensions, `skills/index.ts` reconciles live and restored skill visibility through one name-to-selection map; native session entries remain the durable source for branch-local selections. `subagents/managed-agent.ts` owns live session transitions, questions, usage, and cleanup of its session's process groups; `subagents/result-store.ts` indexes compact native-entry locators persisted in parent session results or settlement entries, enabling exact reads across restart. `process-reaper/index.ts` owns a process-local group registry; its temporary marker files only hand PIDs from Bash to that registry and are not durable session state. Role prompts in `subagents/agents/` are separate from the runtime.

## Where to Start

- For user commands or shell behavior, inspect `.local/bin/` and the `home/` shell file.
- For an application or desktop change, begin under `.config/`; follow related Colemak-DH mappings across affected applications.
- For Karabiner changes, edit `misc/karabiner/karabiner.cue`, then run `mise run karabiner:gen` and `mise run karabiner:check`.
- For system provisioning or keymaps, begin at `misc/` and `mise.linux.toml`. Do not casually run `MISE_ENV=linux mise bootstrap` or the `linux-system` task; they make privileged host changes.
- For Pi behavior, begin at the relevant extension entry point and its tests. Run `mise run pi:check` for extension changes, `mise run herdr:test` for Herdr plugins, and `mise run shell:test` for shell changes.

## Critical Constraints

Keep tracked links as links: `CLAUDE.md` targets this file, `home/.bash_profile` targets `.profile`, and the Claude/Codex instruction links lead to `home/.pi/agent/APPEND_SYSTEM.md`. Extensions require Node 26+, pnpm, tabs, and `oxfmt`; Pi, Pi AI, and Pi TUI are pinned to `0.84.4`. Keep the package manifest, lockfile, workspace policy, and `codex-apply-patch` grammar synchronized when upgrading those packages. That extension uses Pi's native grammar-tool support and replaces Pi's edit/write tools only for the `openai-codex` provider. Subagent children are one-shot leaves by default; retained children are the follow-up path. Colemak-DH navigation is coordinated across Nvim, tmux, Sail, keyd, Karabiner, Ghostty, and readline.

## Maintenance

Keep this repository map current. When a change adds, removes, or relocates a major subsystem; changes an architectural boundary or source of truth; or introduces a critical repository-wide constraint, update `AGENTS.md` in the same commit. Do not record routine implementation details or file-level churn.
