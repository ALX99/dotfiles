#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/openssl" <<'OPENSSL'
#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == s_client ]]; then
  printf '%s\n' "$*" >"$OPENSSL_ARGS_FILE"
  printf '%s\n' '-----BEGIN CERTIFICATE-----' 'stub' '-----END CERTIFICATE-----'
  exit 0
fi

if [[ ${1:-} == x509 ]]; then
  cat >/dev/null
  printf 'decoded certificate\n'
  exit 0
fi

echo "unexpected openssl invocation: $*" >&2
exit 1
OPENSSL
chmod +x "$tmp/openssl"

OPENSSL_ARGS_FILE="$tmp/openssl.args" PATH="$tmp:$PATH" domain=example.com "$repo_root/.local/bin/dumpcert" >/dev/null

args=$(cat "$tmp/openssl.args")
case "$args" in
  *'-connect example.com:443'*) ;;
  *)
    echo "dumpcert did not add the default HTTPS port: $args" >&2
    exit 1
    ;;
esac