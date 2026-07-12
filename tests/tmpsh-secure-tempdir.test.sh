#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$repo_root/.local/bin/tmpsh"
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT

victim="$sandbox/victim"
mkdir -p "$victim"
touch "$victim/sentinel"

pwd_file="$sandbox/pwd"
helper="$sandbox/shell"
cat >"$helper" <<'EOF'
#!/bin/sh
status=0
if [ -e "$PWD/sentinel" ]; then
  status=1
fi
printf '%s\n' "$PWD" >"$TMPSH_PWD_FILE"
rm -f "/tmp/$PPID.tmpsh"
exit "$status"
EOF
chmod +x "$helper"

sh -c '
  attack_path=/tmp/$$.tmpsh
  ln -s "$1" "$attack_path"
  exec env SHELL="$2" TMPSH_PWD_FILE="$3" "$4"
' sh "$victim" "$helper" "$pwd_file" "$script"

actual_pwd=$(cat "$pwd_file")
if [[ $actual_pwd == "$victim" ]]; then
  echo "tmpsh followed a pre-created temporary-directory symlink" >&2
  exit 1
fi

if [[ -e $actual_pwd ]]; then
  echo "tmpsh did not remove its temporary directory" >&2
  exit 1
fi
