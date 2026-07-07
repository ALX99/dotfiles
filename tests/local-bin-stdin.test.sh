#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

cat >"$tmp_dir/fzf" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp_dir/fzf"

PATH="$tmp_dir:$PATH" printf '{"hello":"world"}\n' | "$repo_dir/.local/bin/ljq"
PATH="$tmp_dir:$PATH" printf 'hello world\n' | "$repo_dir/.local/bin/lawk"
