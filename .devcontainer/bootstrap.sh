#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(git rev-parse --show-toplevel)
cd "$repo_dir"

just install

if [[ -d "$HOME/.ssh" ]]; then
  chmod 700 "$HOME/.ssh"
  [[ ! -e "$HOME/.ssh/config" ]] || chmod 600 "$HOME/.ssh/config"
fi

just install-pi
npm --prefix "$repo_dir/pi-web" ci

gh config set git_protocol https --host github.com

clone_repo() {
  local repo=$1
  local target="$HOME/projects/$repo"

  if [[ -d "$target/.git" ]]; then
    printf 'Repository already exists: %s\n' "$target"
    return
  fi

  if [[ -e "$target" ]]; then
    printf 'Refusing to clone over existing non-repository path: %s\n' "$target" >&2
    return 1
  fi

  gh repo clone "alx99/$repo" "$target"
}

mkdir -p "$HOME/projects"
clone_repo sail
clone_repo muninn
