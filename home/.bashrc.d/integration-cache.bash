# Cache generated shell-integration scripts so tools like direnv and fzf are
# not spawned on every shell start. First use generates the script; later
# shells source the cached copy.
#
# Usage: __cached_integration <name> <tool-path> [command args...]
#
# The entry is invalidated when the tool binary is newer than the cached
# script (upgrade or reinstall). Generation failures leave an existing cache
# entry untouched.

__cached_integration() {
  local name=$1
  shift

  local cache_dir script
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/bash-integrations"
  script="$cache_dir/$name.sh"

  if [[ ! -s $script || $1 -nt $script ]]; then
    mkdir -p "$cache_dir"
    "$@" > "$cache_dir/$name.tmp" &&
      mv "$cache_dir/$name.tmp" "$script"
  fi

  # shellcheck disable=SC1090
  [[ -s $script ]] && . "$script"
}
