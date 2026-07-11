#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(git rev-parse --show-toplevel)
cd "$repo_dir"

just install
just install-pi
npm --prefix "$repo_dir/pi-web" ci

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
