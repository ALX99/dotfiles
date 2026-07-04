#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/input"
printf 'sentinel\n' >"$tmp/archive.tar"
printf 'payload\n' >"$tmp/input/file.txt"

cat >"$tmp/bin/zstd" <<'ZSTD'
#!/usr/bin/env bash
set -euo pipefail

remove=false
input=
output=

while (($#)); do
  case "$1" in
    --rm)
      remove=true
      shift
      ;;
    -o)
      output=$2
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      input=$1
      shift
      ;;
  esac
done

if [[ -z $input || -z $output ]]; then
  echo 'zstd stub missing input or output' >&2
  exit 1
fi

cp "$input" "$output"
if [[ $remove == true ]]; then
  rm -f "$input"
fi
ZSTD
chmod +x "$tmp/bin/zstd"

(
  cd "$tmp"
  PATH="$tmp/bin:$PATH" "$repo_root/.local/bin/compress" input >/dev/null
)

actual=$(cat "$tmp/archive.tar")
if [[ $actual != 'sentinel' ]]; then
  echo 'compress modified an existing archive.tar in the working directory' >&2
  exit 1
fi

[[ -s "$tmp/archive.tar.zst" ]]