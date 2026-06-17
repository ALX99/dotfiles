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

__prompt_is_unmerged_status() {
  case "$1" in
  DD | AU | UD | UA | DU | AA | UU) return 0 ;;
  *) return 1 ;;
  esac
}

__prompt_git_operation() {
  local git_dir=$1

  if [[ -f $git_dir/MERGE_HEAD ]]; then
    printf '%s\n' merge
  elif [[ -d $git_dir/rebase-merge || -d $git_dir/rebase-apply ]]; then
    printf '%s\n' rebase
  elif [[ -f $git_dir/BISECT_LOG ]]; then
    printf '%s\n' bisect
  elif [[ -f $git_dir/CHERRY_PICK_HEAD ]]; then
    printf '%s\n' cherry-pick
  fi
}

__prompt_git_info() {
  local branch_color=$1
  local staged_color=$2
  local unstaged_color=$3
  local untracked_color=$4
  local operation_color=$5
  local conflict_color=$6
  local reset=$7
  local branch git_dir operation line status index_status worktree_status
  local staged=0 unstaged=0 untracked=0 conflicts=0

  git_dir=$(git rev-parse --git-dir 2>/dev/null) || return
  operation=$(__prompt_git_operation "$git_dir")

  while IFS= read -r line; do
    if [[ $line == '## '* ]]; then
      branch=${line#'## '}
      branch=${branch#'No commits yet on '}
      branch=${branch%%...*}
      branch=${branch%% \[*}
      [[ $branch == HEAD\ * ]] && branch=HEAD
      continue
    fi

    status=${line:0:2}
    index_status=${line:0:1}
    worktree_status=${line:1:1}

    if [[ $status == '??' ]]; then
      ((untracked++))
    elif __prompt_is_unmerged_status "$status"; then
      ((conflicts++))
    else
      [[ $index_status != ' ' ]] && ((staged++))
      [[ $worktree_status != ' ' ]] && ((unstaged++))
    fi
  done < <(git --no-optional-locks status --porcelain=v1 --branch 2>/dev/null)

  [[ -n $branch ]] || return

  printf '%s%s%s' "$branch_color" "$branch" "$reset"
  [[ $staged -gt 0 ]] && printf ' %s+%d%s' "$staged_color" "$staged" "$reset"
  [[ $unstaged -gt 0 ]] && printf ' %s~%d%s' "$unstaged_color" "$unstaged" "$reset"
  [[ $untracked -gt 0 ]] && printf ' %s?%d%s' "$untracked_color" "$untracked" "$reset"
  [[ -n $operation ]] && printf ' %s%s%s' "$operation_color" "$operation" "$reset"
  [[ $conflicts -gt 0 ]] && printf ' %sconflict:%d%s' "$conflict_color" "$conflicts" "$reset"
  printf '\n'
}

__prompt_render() {
  local exit_status=$1
  local cwd=${PWD##*/}
  local host git_info segments=()
  local reset='\[\e[0m\]'
  local bold='\[\e[1m\]'
  local dim='\[\e[2m\]'
  local slate='\[\e[38;5;245m\]'
  local red='\[\e[38;5;203m\]'
  local green='\[\e[38;5;114m\]'
  local yellow='\[\e[38;5;179m\]'
  local blue='\[\e[38;5;75m\]'
  local purple='\[\e[38;5;141m\]'
  local cyan='\[\e[38;5;109m\]'

  [[ -n $cwd ]] || cwd=/

  if [[ -n ${SSH_CLIENT:-} ]]; then
    host=$(hostname -s 2>/dev/null || hostname)
    segments+=("${slate}${USER}@${host}${reset}")
  fi

  segments+=("${bold}${blue}${cwd}${reset}")

  git_info=$(__prompt_git_info "$green" "$cyan" "$yellow" "$purple" "$purple" "$red" "$reset")
  [[ -n $git_info ]] && segments+=("$git_info")
  [[ -n ${VIRTUAL_ENV:-} ]] && segments+=("${purple}venv${reset}")
  [[ $exit_status -ne 0 ]] && segments+=("${red}✗$exit_status${reset}")

  local IFS=' '
  PS1="${segments[*]} ${dim}${slate}>${reset} "
}

__prompt_command() {
  local exit_status=$?
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

stty -ixon # Disable ctrl-s and ctrl-q.

# Load aliases
if [ -f "$HOME/.aliasrc" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.aliasrc"
else
  echo "Could not load aliases"
fi
