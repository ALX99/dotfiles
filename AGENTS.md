# Repository Guidelines

## Project Structure

This is a Stow-managed personal dotfiles repository. The `.local/`, `home/`, and
`.config/` packages target `~/.local`, `~`, and `~/.config` respectively;
`.stowrc` deliberately uses `--no-folding`. `misc/` owns machine-level Arch,
systemd, XKB/keyd, pacman, and Pi compatibility files. The
`.config/mpv/scripts/subs2srs` path is the `Ajatt-Tools/mpvacious` submodule.

Pi configuration is under `home/.pi/agent/`. Extensions live in
`home/.pi/agent/extensions/`: top-level `.ts` files and `*/index.ts` are entry
points; `_shared/` is intentionally not. The RPC-backed subagent extension
keeps role prompts in `subagents/agents/` and lifecycle/transport/state in
separate modules. Its tests are colocated in `subagents/tests/`.
Harness-independent skills belong in `home/.agents/skills/`; Pi-only skills
belong in `home/.pi/agent/skills/`.

## Setup and System Changes

Run `just` to list recipes. Use `just install` to restow user configuration,
then `just install-pi` to install extension dependencies. The installer creates
required directories, preserves existing third-party skills, and links only
missing skills. Run it after Stow layout changes.

`just linux-system` requires `sudo` and changes Arch system configuration;
`just mac-system` installs (but does not enable) the macOS Colemak-DH layout.
Do not run either casually. Colemak-DH navigation mappings span nvim, tmux,
sail, keyd, Karabiner, Ghostty, and readline—update every affected layer when
changing navigation intent.

## Pi Extensions and Validation

Node 26+ is required. In `home/.pi/agent/extensions/`, use tabs and let
`oxfmt` format code; TypeScript is strict and uses NodeNext imports. Run
`just check` for the required compatibility, formatting, type, lint, and test
suite. Tests use Node’s built-in runner, for example:
`npm run test:extensions`.

Pi, Pi AI, and Pi TUI are pinned to `0.81.0`. Changes to compatibility code
must keep `misc/pi-patches/`, its manifest, extension behavior, and tests in
sync; run `node misc/pi-patches/apply-pi-ai-0.81.0.mjs --check`.
For shell edits, run `bash -n home/.bashrc home/.profile`; CI also runs
ShellCheck.

## Change Hygiene

Use concise Conventional Commit-style subjects (`fix(nvim): …`,
`refactor(pi): …`) consistent with recent history. Keep unrelated local edits
intact. `CLAUDE.md` and selected files under `home/` are links: edit their
canonical source rather than replacing the link.
