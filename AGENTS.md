# Repository Guidelines

This is a Stow-managed personal dotfiles repository. The `.local/`, `home/`,
and `.config/` packages target `~/.local`, `~`, and `~/.config`; `.stowrc`
deliberately disables folding.

## Repository Map

- `.local/` — user-local executables and shared data; add command-line helpers
  under `.local/bin/`.
- `home/` — home-directory dotfiles, including shell configuration and agent
  configuration. Keep tracked symlinks as symlinks: `.bash_profile` points to
  `.profile`, and the Claude/Codex instruction links lead to
  `.pi/agent/APPEND_SYSTEM.md`.
- `.config/` — application configuration for desktop applications.
- `.devcontainer/` — DevContainer setup (Dockerfile, devcontainer.json,
  bootstrap script) plus the multi-architecture Alpine `sandbox.Dockerfile`
  used by `sbx`.
- `data_analysis/` — privacy-preserving Pi JSONL efficiency/regression
  reporting and the controlled RPC subagent evaluator in `subagent_eval/`;
  generated reports, sessions, and evaluation runs are not committed.
- `misc/` — machine-level Arch, systemd, XKB/keyd, and pacman assets.
- The `codex-apply-patch` extension declares the `apply_patch` tool with a Lark
  grammar via `constrainedSampling`; Pi 0.84.2 provides native grammar-tool
  support, so no patched pi-ai build is needed.
- `.pkgList` — Arch package manifest used to provision a fresh system; see
  `misc/pacman-hooks` and `just linux-system` for related setup.
- `home/.pi/agent/` — Pi settings, extensions, and Pi-only skills.
  `extensions/*.ts` and `extensions/*/index.ts` are extension entry points;
  `_shared/` is not. The RPC subagent extension separates role prompts
  (`subagents/agents/`) from lifecycle, bounded direct-RPC transport, generation
  capture, a single `ResultCatalog` for native session-checkpoint and legacy
  result locators, and state modules; its tests are in `subagents/tests/`.
  Children are leaves and one-shot by default. Ordinary assignment, follow-up,
  steer, and fallback context is direct bounded RPC text. Native append/leaf
  checkpoints delimit each logical generation; ordinary terminal assistant
  entries provide exact results, and settlement records retain every generation
  locator so `read_agent_result` survives restart while carrying child-only
  usage. Legacy custom result pages are read-only compatibility data.
  Retained children support follow-ups; child `ask_question` requests route to
  the immediate spawning agent and resume through `answer_agent`.
- `home/.agents/skills/` — harness-independent skills. Put Pi-only skills in
  `home/.pi/agent/skills/` instead.
- `.github/workflows/` — CI: extension checks run only for extension changes;
  ShellCheck runs for all pushes and pull requests.
- `Justfile` — installation, formatting, and validation recipes; inspect it
  before changing setup or system configuration.
- `CLAUDE.md` — symlink to this file. `home/.claude/CLAUDE.md` and
  `home/.codex/AGENTS.md` are separate downstream instruction links.

## Essential Commands

Run these from the repository root unless noted otherwise.

- `just` — list available recipes.
- `just install` — restow user configuration and link shared skills; run after
  Stow-layout changes. It changes paths in `$HOME` and enables the user
  `ssh-agent` service when its bus is available.
- `just install-pi` — install locked Pi extension dependencies with pnpm in
  `$HOME/.pi/agent/extensions`.
- `just fmt` — format Pi extensions with `oxfmt`.
- `just check` — run Pi dependency, formatting, type, lint, dead-code, and test
  checks.
- `pnpm run test:extensions` — focused extension tests; run from
  `home/.pi/agent/extensions/`.
- `bash -n home/.bashrc home/.profile` — syntax-check the primary shell files.
- `just linux-system` — privileged Arch system configuration; do not run
  casually. `just mac-system` installs, but does not enable, the macOS
  Colemak-DH layout.

## Architecture & Working Agreements

- Pi extensions require Node 26+ and use strict TypeScript with NodeNext
  imports. Their package manager is pnpm; keep `pnpm-lock.yaml`,
  `pnpm-workspace.yaml` synchronized. Use tabs and let `oxfmt` format them.
- Pi, Pi AI, and Pi TUI are pinned to `0.84.2`. Keep `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, and the `codex-apply-patch` tool grammar synchronized
  when upgrading Pi packages.
- Colemak-DH navigation mappings span nvim, tmux, sail, keyd, Karabiner,
  Ghostty, and readline; update every affected layer when changing navigation
  intent.
- Keep unrelated local edits intact. Use concise Conventional Commit-style
  subjects consistent with recent history.

## Keeping This File Accurate

This file must stay accurate. Before finishing any change, check whether it
alters a mapped path or responsibility, or a documented command, workflow,
dependency, or architectural rule. If so, update `AGENTS.md` in the same
change. When creating, deleting, moving, renaming, or repurposing files or
directories, always review the repository map; do not add entries for ordinary
files already covered by an existing responsibility.
