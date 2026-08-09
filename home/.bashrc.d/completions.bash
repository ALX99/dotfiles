# Lazy programmable completion setup.
# shellcheck disable=SC1090,SC1091

_load_bash_completion() {
  [[ -n ${BASH_COMPLETION_VERSINFO+x} ]] && return

  local completion
  for completion in \
    /opt/homebrew/etc/profile.d/bash_completion.sh \
    /usr/local/etc/profile.d/bash_completion.sh \
    /usr/share/bash-completion/bash_completion; do
    if [ -r "$completion" ]; then
      . "$completion"
      return 0
    fi
  done

  printf 'bash-completion not found\n' >&2
  return 1
}

_lazy_completion() {
  local cmd=$1 aliases=$2 loader=$3
  eval "_lazy_${cmd}() {
        command -v $cmd >/dev/null 2>&1 || return
        _load_bash_completion || return
        unset -f _lazy_${cmd}
        . <($loader)
        complete -o default -F __start_${cmd} ${cmd} ${aliases}
        return 124
    }
    complete -F _lazy_${cmd} ${cmd} ${aliases}"
}
_lazy_completion kubectl "k" "kubectl completion bash"
_lazy_completion helm "" "helm completion bash"
_lazy_completion k6 "" "k6 completion bash"
_lazy_completion gh "" "gh completion -s bash"
_lazy_completion orb "" "orb completion bash"
unset -f _lazy_completion

# Load the full bash-completion framework on the first command that needs it.
# Returning 124 tells Bash to retry the same completion with the new compspec.
_lazy_bash_completion() {
  if ! _load_bash_completion; then
    complete -r -D
    unset -f _lazy_bash_completion
    return 1
  fi

  unset -f _lazy_bash_completion
  return 124
}

if ((BASH_VERSINFO[0] > 4 || BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 2)) &&
  [[ -z ${BASH_COMPLETION_VERSINFO+x} ]]; then
  complete -o bashdefault -o default -D -F _lazy_bash_completion
fi
