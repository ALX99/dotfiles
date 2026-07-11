# Arch Linux GitHub Codespaces Development Environment

## Goal

Provide this repository with a rolling Arch Linux GitHub Codespaces environment for development. The environment should support the repository's dotfiles, Pi extensions, `pi-web`, and common polyglot tooling while remaining safe in a container without systemd, a GUI, or host-level device access.

## Scope

Add a repository-level devcontainer that:

- Builds from the official rolling `archlinux:base` image.
- Installs Bash, Git, SSH tooling, Just, GNU Stow, Neovim, tmux, ripgrep, fd, fzf, jq, GitHub CLI, ShellCheck, base build tools, Node.js/npm, Python, Go, and Rust.
- Creates a non-root `codespace` user with Bash as its login shell and passwordless sudo.
- Applies the repository's user-space dotfiles automatically after the workspace is mounted.
- Installs dependencies for both Pi extensions and `pi-web`.
- Sets Bash and Neovim as the default shell/editor environment.
- Does not execute GUI, keyboard-layout, power-management, systemd-unit, or other host-only configuration.

The existing Justfile will be adjusted only to skip its user SSH-agent startup when no usable systemd user manager exists. Normal host behavior remains unchanged.

## Components

### `.devcontainer/Dockerfile`

Build the development image as root from `archlinux:base`, synchronize and upgrade the Arch package database, install the requested packages, remove package caches, create the `codespace` user, grant passwordless sudo, set Bash as the login shell, and switch to the non-root user for workspace use.

### `.devcontainer/devcontainer.json`

Describe the container build context and Dockerfile, select `codespace` as the remote user, set the shell/editor environment, and invoke the bootstrap script as a post-create lifecycle command.

### `.devcontainer/bootstrap.sh`

Run from the mounted repository as the `codespace` user. It will:

1. Apply the user-space dotfiles with the existing Justfile installation recipe.
2. Install Pi extension dependencies.
3. Run `npm ci` in `pi-web`.

The script will use strict Bash error handling and remain safe to run repeatedly.

### `Justfile`

Guard the Linux SSH-agent command with checks for both `systemctl` and a functioning systemd user manager. In a Codespace this step will be skipped; on a normal Linux host it will continue to run as before.

## Runtime behavior

Image construction performs the Arch package installation and fails on package errors. Post-create setup runs as the non-root user, so generated Stow links and npm files have the expected ownership. npm and bootstrap failures stop setup rather than leaving a silently incomplete environment. No secrets are baked into the image; Codespaces remains responsible for GitHub authentication.

The rolling base is intentionally refreshed on image rebuilds rather than pinned to a dated snapshot. This favors current packages and a simple configuration over byte-for-byte reproducibility.

## Verification

Where supported, verify the Dockerfile can build. In the repository, run:

- Shell syntax checks and ShellCheck for the bootstrap script.
- `just check` for Pi extensions.
- `cd pi-web && npm run build && npm run typecheck && npm test`.
- Checks that expected dotfile links and both dependency directories are present.

Unrelated existing working-tree changes must not be modified.

## Out of scope

- Host-level Arch setup from `just linux-system`.
- GUI applications, Wayland/compositor configuration, keyboard layout installation, power management, Bluetooth, or system services.
- Secret management or custom GitHub authentication.
- Changes to unrelated dotfiles or the `pi-web` application itself.
