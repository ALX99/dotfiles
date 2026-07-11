#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(git rev-parse --show-toplevel)
cd "$repo_dir"

just install
just install-pi
npm --prefix "$repo_dir/pi-web" ci
