#!/usr/bin/env bash
# Runs every time bash shell is launched

# Private rc file
# shellcheck disable=SC1091
[ -f "$HOME/.privrc" ] && . "$HOME/.privrc"

# If not running interactively, don't do anything
case $- in
*i*) ;;
*) return ;;
esac

# History
HISTIGNORE="&:exit:ls:bg:fg:history:clear"
HISTSIZE=-1
HISTFILESIZE=-1
HISTCONTROL=ignoredups

__prompt_git_operation() {
  local git_dir=$1

  if [[ -f $git_dir/MERGE_HEAD ]]; then
    __prompt_git_operation_result=merge
  elif [[ -d $git_dir/rebase-merge || -d $git_dir/rebase-apply ]]; then
    __prompt_git_operation_result=rebase
  elif [[ -f $git_dir/BISECT_LOG ]]; then
    __prompt_git_operation_result=bisect
  elif [[ -f $git_dir/CHERRY_PICK_HEAD ]]; then
    __prompt_git_operation_result=cherry-pick
  else
    __prompt_git_operation_result=
  fi
}

__prompt_git_cache_key=
__prompt_git_dir=

__prompt_find_git_dir() {
  local cache_key candidate dir git_file parent target

  cache_key="${PWD}"$'\034'"${GIT_DIR-}"$'\034'"${GIT_WORK_TREE-}"$'\034'"${GIT_COMMON_DIR-}"
  [[ $cache_key == "$__prompt_git_cache_key" ]] && return

  __prompt_git_cache_key=$cache_key
  __prompt_git_dir=

  if [[ -n ${GIT_DIR:-} ]]; then
    if [[ $GIT_DIR == /* ]]; then
      candidate=$GIT_DIR
    else
      candidate=$PWD/$GIT_DIR
    fi
    [[ -f $candidate/HEAD ]] && __prompt_git_dir=$candidate
    return
  fi

  dir=$PWD
  while :; do
    candidate=$dir/.git
    if [[ -d $candidate ]]; then
      __prompt_git_dir=$candidate
      return
    elif [[ -f $candidate ]]; then
      IFS= read -r git_file < "$candidate" || return
      git_file=${git_file%$'\r'}
      if [[ $git_file == gitdir:* ]]; then
        target=${git_file#gitdir:}
        target="${target#"${target%%[![:space:]]*}"}"
        if [[ $target == /* ]]; then
          candidate=$target
        else
          candidate=$dir/$target
        fi
        [[ -f $candidate/HEAD ]] && __prompt_git_dir=$candidate
      fi
      return
    elif [[ -f $dir/HEAD && -d $dir/objects && -d $dir/refs ]]; then
      __prompt_git_dir=$dir
      return
    fi

    [[ $dir == / ]] && return
    parent=${dir%/*}
    dir=${parent:-/}
  done
}

__prompt_git_info() {
  local branch_color=$1
  local operation_color=$2
  local reset=$3
  local branch head

  __prompt_git_segment=
  __prompt_find_git_dir
  [[ -n $__prompt_git_dir ]] || return
  IFS= read -r head < "$__prompt_git_dir/HEAD" || return
  head=${head%$'\r'}

  if [[ $head == 'ref: refs/heads/'* ]]; then
    branch=${head#'ref: refs/heads/'}
  elif [[ $head == 'ref: '* ]]; then
    branch=${head#'ref: '}
  else
    branch=HEAD
  fi
  [[ -n $branch ]] || return

  __prompt_git_segment="${branch_color}${branch}${reset}"
  __prompt_git_operation "$__prompt_git_dir"
  if [[ -n $__prompt_git_operation_result ]]; then
    __prompt_git_segment+=" ${operation_color}${__prompt_git_operation_result}${reset}"
  fi
}

__prompt_render() {
  local exit_status=$1
  local cwd=${PWD##*/}
  local host segments=()
  local reset='\[\e[0m\]'
  local bold='\[\e[1m\]'
  local dim='\[\e[2m\]'
  local slate='\[\e[38;5;245m\]'
  local red='\[\e[38;5;203m\]'
  local green='\[\e[38;5;114m\]'
  local blue='\[\e[38;5;75m\]'
  local purple='\[\e[38;5;141m\]'

  [[ -n $cwd ]] || cwd=/

  if [[ -n ${SSH_CLIENT:-} ]]; then
    host=${HOSTNAME%%.*}
    segments+=("${slate}${USER}@${host}${reset}")
  fi

  segments+=("${bold}${blue}${cwd}${reset}")

  __prompt_git_info "$green" "$purple" "$reset"
  [[ -n $__prompt_git_segment ]] && segments+=("$__prompt_git_segment")
  [[ -n ${VIRTUAL_ENV:-} ]] && segments+=("${purple}venv${reset}")
  [[ $exit_status -ne 0 ]] && segments+=("${red}✗$exit_status${reset}")

  local IFS=' '
  PS1="${segments[*]} ${dim}${slate}>${reset} "
}

# Use direnv when installed; otherwise provide the lightweight .env loader.
if ! command -v direnv >/dev/null 2>&1 && [[ -r $HOME/.bashrc.d/envload.bash ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.bashrc.d/envload.bash"
fi

__prompt_command() {
  local exit_status=$?
  [[ -n ${__dotenv_active_file+x} ]] && __dotenv_update
  history -a
  __prompt_render "$exit_status"
}

PROMPT_COMMAND=__prompt_command

# autocd autocd
# cdspell fix minor spelling mistakes in dirname of a cd command
# dirspell Bash attempts spelling correction on directory names during word completion if the directory name initially supplied does not exist.
# histappend append to $HISTFILE instead of overwriting it
# checkjobs check if there are any stopped or running jobs before exiting an interactive shell
# checkwinsize check the window size after each external command and, if necessary, updates the values of $LINES and $COLUMNSk
# cmdhist save multiple-line commands in the same history entry
# huponexit send SIGHUP to all jobs when an interactive login shell exits
shopt -s autocd cdspell dirspell histappend checkjobs direxpand checkwinsize cmdhist huponexit

# Load aliases
if [ -f "$HOME/.aliasrc" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.aliasrc"
else
  echo "Could not load aliases"
fi
