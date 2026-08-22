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
  local func=${4:-__start_${cmd}}
  eval "_lazy_${cmd}() {
        command -v $cmd >/dev/null 2>&1 || return
        _load_bash_completion || return
        unset -f _lazy_${cmd}
        . <($loader)
        complete -o default -F ${func} ${cmd} ${aliases}
        return 124
    }
    complete -F _lazy_${cmd} ${cmd} ${aliases}"
}
_lazy_completion kubectl "k" "kubectl completion bash"
# mise's generated completion defines _mise instead of the __start_mise
# convention.
_lazy_completion mise "" "mise completion bash" _mise
_lazy_completion mr "" "mise completion bash" _mr
_lazy_completion helm "" "helm completion bash"
_lazy_completion k6 "" "k6 completion bash"
_lazy_completion gh "" "gh completion -s bash"
_lazy_completion orb "" "orb completion bash"
unset -f _lazy_completion

# mr expands to "mise run", so its entry point rewrites the completion state
# before delegating to _mise; without it usage completes mise's top-level
# subcommands instead of task names.
_mr() {
  # The completion framework re-derives the word under the cursor from
  # COMP_LINE/COMP_POINT rather than trusting COMP_WORDS, so rewriting only
  # COMP_WORDS leaves a stale "r" prefix that filters out every candidate.
  # Replace the whole "mr" word with "mise run" in the line state instead.
  local cmd=${COMP_WORDS[0]} off rest point
  [[ $COMP_LINE =~ ^[[:blank:]]* ]] && off=${#BASH_REMATCH}
  rest=${COMP_LINE:off + ${#cmd}}
  point=$((COMP_POINT - off - ${#cmd}))
  ((point < 0)) && point=0
  COMP_LINE="${COMP_LINE:0:off}mise run${rest}"
  COMP_POINT=$((off + 8 + point))
  COMP_WORDS=(mise run "${COMP_WORDS[@]:1}")
  COMP_CWORD=$((COMP_CWORD + 1))
  _mise
}

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
