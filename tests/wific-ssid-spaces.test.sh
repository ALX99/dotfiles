#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

log="$tmp_dir/iwctl.log"
export WIFIC_TEST_LOG="$log"

cat >"$tmp_dir/iwctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$WIFIC_TEST_LOG"

case "$*" in
  "device list")
    cat <<'OUT'
                               Devices
--------------------------------------------------------------------------------
  Name                Address             Powered   Adapter   Mode
--------------------------------------------------------------------------------
  wlan0               00:11:22:33:44:55   on        phy0      station
OUT
    ;;
  "station wlan0 scan")
    ;;
  "station wlan0 get-networks")
    cat <<'OUT'
                               Available networks
--------------------------------------------------------------------------------
  Network name                         Security            Signal
--------------------------------------------------------------------------------
  Office                               psk                 ****
  Cafe WiFi 5G                         psk                 ****
OUT
    ;;
  station\ wlan0\ connect*)
    printf 'connect_arg_count=%s\n' "$#" >>"$WIFIC_TEST_LOG"
    printf 'connect_arg_4=%s\n' "$4" >>"$WIFIC_TEST_LOG"
    ;;
  *)
    echo "unexpected iwctl call: $*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$tmp_dir/iwctl"

cat >"$tmp_dir/fzf" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
prompt=""
while (($#)); do
  case "$1" in
    --prompt=*) prompt="${1#--prompt=}" ;;
    --prompt) shift; prompt="${1:-}" ;;
  esac
  shift || true
done

if [[ "$prompt" == "device > " ]]; then
  cat >/dev/null
  printf 'wlan0\n'
else
  grep -Fx 'Cafe WiFi 5G'
fi
STUB
chmod +x "$tmp_dir/fzf"

PATH="$tmp_dir:$PATH" "$repo_dir/.local/bin/wific" >/dev/null

grep -Fx 'station wlan0 connect Cafe WiFi 5G' "$log" >/dev/null
grep -Fx 'connect_arg_count=4' "$log" >/dev/null
grep -Fx 'connect_arg_4=Cafe WiFi 5G' "$log" >/dev/null
