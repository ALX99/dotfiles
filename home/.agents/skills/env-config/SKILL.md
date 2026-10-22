---
name: env-config
description: Use when working on this user's dotfiles, mise configuration, installed tools, environment variables, host setup, or agent skill installation. Explains repository location, Stow layout, how the active MISE_ENV profile decides which config file to edit, bootstrap vs runtime configs, and where to make changes.
---

# Environment Configuration

This user's dotfiles live in `~/dotfiles` (on this machine `/Users/dozy/dotfiles`). Run repository commands from its Git root (`git rev-parse --show-toplevel`).

## Stow layout

- `.local/` installs to `~/.local`.
- `home/` installs to `~`.
- `.config/` installs to `~/.config`.
- `.stowrc` uses `--no-folding`, so tracked paths must remain symlinks.
- `mise run install` from the repo root restows all three packages and syncs shared skills. It changes `$HOME`; do not run it for routine verification.

## Mise profiles

`MISE_ENV` selects the machine profile and therefore which config file owns a change. Confirm it before editing.

- It is exported in `~/.privrc` (`export MISE_ENV=personal` on macOS; `linux` on Linux). That file is not tracked and holds secrets; never commit it.
- `echo "$MISE_ENV"`, `mise doctor`, and `mise config ls` report the active profile and the config files that are actually loaded. Prefer `mise config ls`: it lists resolved filenames instead of trusting your own environment.
- Agent shells may not inherit it (`~/.privrc` loads through `~/.bashrc`). When it is missing, read `~/.privrc` for the intended profile and pass `MISE_ENV=<profile>` explicitly to mise commands; without it, profile files are not loaded and their packages look absent.

Profile files are named `mise.<profile>.toml` and sit next to the shared file in each of two layers:

| Layer | Shared (all machines) | `personal` | `linux` |
| --- | --- | --- | --- |
| Runtime tools | `.config/mise/config.toml` | `.config/mise/mise.personal.toml` | (none yet) |
| Bootstrap and host setup | `mise.toml` | `mise.personal.toml` | `mise.linux.toml` |

- `.config/mise/*.toml` stow to `~/.config/mise/` and load in every directory. `[tools]` merges additively: profile entries add to the shared config and never replace it.
- Root `mise.*.toml` files are project configs: they load only from inside the repository working tree, and they carry bootstrap packages, tasks, and generators, not runtime tools.
- `mise.toml` (shared root) also defines repo tooling (`cue`, `jq`, `shfmt`, `shellcheck`) in `[tools]`.

## Common changes

- Add a runtime tool wanted everywhere: edit `.config/mise/config.toml`, then `mise install <tool>`.
- Add a runtime tool for the current machine only: edit `.config/mise/mise.<profile>.toml` (create it if the layer has none for that profile), then `mise install <tool>`. A global-only tool for `linux` needs a new `.config/mise/mise.linux.toml`.
- Add a bootstrap package: edit the shared root `mise.toml` or the profile root `mise.<profile>.toml` (matching the active `MISE_ENV`) under `[bootstrap.packages]`, then run `MISE_ENV=<profile> mise bootstrap` from the repo root.
- Add host files, directories, or services: same root `mise.*.toml` files, in their bootstrap sections.
- Run tasks: `mise run <task>` or `mise tasks`. Generators: edit the source, then `mise run gen:<area>` and the matching `mise run <area>:check`.
- Install dotfiles and skills: `mise run install` from the repo root.

## Environment and shell

- `~/.bash_profile` owns PATH, XDG paths, and default programs.
- `~/.bashrc` activates mise interactively; noninteractive login shells activate shims through `~/.bash_profile`. Never export unattended-command defaults through session-wide `BASH_ENV`: display managers also run noninteractive login shells. `~/.bashrc.d/noninteractive.bash` is explicit opt-in only.
- On macOS, GNU utilities are exposed as private aliases in interactive shells, not through PATH. Child processes and agents may not see them; use `/opt/homebrew/opt/<package>/libexec/gnubin/<tool>` when GNU semantics are required.
- Preferred search tools: `fd` and `rg`.

## Agent skills

- Repo skills live in `home/.agents/skills/<name>/SKILL.md`.
- Installed skills are linked from `~/.agents/skills/` by `mise run install`.
- Claude mirrors them from `~/.claude/skills/`.
- Pi configuration lives in the separate `~/projects/pi-lot` repository and is not managed here.

## Effective config inspection

Verify a change with `mise config ls` (config files loaded), `mise ls` (installed tool versions), and `mise env` (merged variables). Use `mise bootstrap status` or `mise bootstrap plan` before applying host changes.
