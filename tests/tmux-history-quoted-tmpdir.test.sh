#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT

mkdir -p "$sandbox/bin" "$sandbox/tmp'quote"
export NVIM_PATH_LOG="$sandbox/nvim-path"

cat >"$sandbox/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  display-message)
    printf '0\n'
    ;;
  capture-pane)
    printf 'captured history\n'
    ;;
  new-window)
    bash -c "$4"
    ;;
  *)
    exit 2
    ;;
esac
EOF

cat >"$sandbox/bin/nvim" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${@: -1}" >"$NVIM_PATH_LOG"
EOF

chmod +x "$sandbox/bin/tmux" "$sandbox/bin/nvim"

TMPDIR="$sandbox/tmp'quote" PATH="$sandbox/bin:$PATH" \
  "$repo_root/.local/bin/tmux-history"

opened_path=$(cat "$NVIM_PATH_LOG")
case "$opened_path" in
  "$sandbox/tmp'quote"/tmux-history.*.log) ;;
  *)
    printf 'nvim received corrupted history path: %s\n' "$opened_path" >&2
    exit 1
    ;;
esac

if [[ -e $opened_path ]]; then
  printf 'history file was not removed: %s\n' "$opened_path" >&2
  exit 1
fi

if find "$sandbox/tmp'quote" -maxdepth 1 -type f -name 'tmux-history.*.log' | grep -q .; then
  printf 'tmux-history leaked its temporary capture file\n' >&2
  exit 1
fi
