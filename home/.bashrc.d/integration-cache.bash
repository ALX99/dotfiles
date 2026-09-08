# Cache generated shell-integration scripts so tools like direnv and fzf are
# not spawned on every shell start. First use generates the script; later
# shells source the cached copy.
#
# Usage: __cached_integration <name> <tool-path> [command args...]
#
# The entry is invalidated when the tool binary is newer than the cached
# script (upgrade or reinstall). Publish only complete, valid scripts. Each
# shell owns its temporary file so concurrent startups cannot clobber it.

__cached_integration() {
  local name=$1
  shift

  local cache_dir script
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/bash-integrations"
  script="$cache_dir/$name.sh"

  if [[ ! -s $script || $1 -nt $script ]]; then
    (
      mkdir -p "$cache_dir" || exit
      temporary=$(mktemp "$cache_dir/$name.XXXXXX") || exit
      trap 'rm -f "$temporary"' EXIT
      "$@" >"$temporary" &&
        [[ -s $temporary ]] &&
        bash -n "$temporary" &&
        mv "$temporary" "$script"
    )
  fi

  # shellcheck disable=SC1090
  [[ -s $script ]] && . "$script"
}
