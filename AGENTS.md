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
- `.config/` — application configuration. The `mpv/scripts/subs2srs`
  directory is the `Ajatt-Tools/mpvacious` submodule; do not edit it as local
  configuration.
- `data_analysis/` — privacy-preserving Pi JSONL efficiency and regression
  reporting; its generated `report.html` is intentionally ignored.
- `misc/` — machine-level Arch, systemd, XKB/keyd, pacman, and Pi compatibility
  assets. The `codex-compat` extension declares the `apply_patch` tool with a
  Lark grammar via `constrainedSampling`; Pi 0.82.0 provides native grammar-tool
  support, so no patched pi-ai build is needed.
- `home/.pi/agent/` — Pi settings, extensions, and Pi-only skills.
  `extensions/*.ts` and `extensions/*/index.ts` are extension entry points;
  `_shared/` is not. The RPC subagent extension separates role prompts
  (`subagents/agents/`) from lifecycle, transport, and state modules; its tests
  are in `subagents/tests/`. Child `ask_question` requests route to the
  immediate spawning agent and resume through `answer_agent`.
- `home/.agents/skills/` — harness-independent skills. Put Pi-only skills in
  `home/.pi/agent/skills/` instead.
- `.github/workflows/` — CI: extension checks run only for extension or patch
  changes; ShellCheck runs for all pushes and pull requests.
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
- `just check` — run Pi compatibility, formatting, type, lint, dead-code, and
  test checks.
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
- Pi, Pi AI, and Pi TUI are pinned to `0.82.0`. Keep `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, the `codex-compat` tool grammar, and the compatibility
  check synchronized when changing compatibility code.
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
