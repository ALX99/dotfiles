#!/bin/bash
# Runs everytime bash shell is launched

# If not running interactively, don't do anything
case $- in
*i*) ;;
*) return ;;
esac

function parse_git_dirty {
  [[ -n $(git status -s 2>/dev/null) ]] && echo "*"
}
function parse_git_branch {
  git branch --no-color 2>/dev/null | sed -e '/^[^*]/d' -e "s/* \(.*\)/(\1$(parse_git_dirty))/"
}
export PS1='\[\e[38;5;211m\]\W\[\e[\033[38;5;48m\]$(parse_git_branch)\[\e[\033[00m\] ><> '

# autocd autocd
# cdspell fix minor spelling mistakes in dirname of a cd command
# dirspell Bash attempts spelling correction on directory names during word completion if the directory name initially supplied does not exist.
# histappend append to $HISTFILE instead of overwriting it
# checkjobs check if there are any stopped or running jobs before exiting an interactive shell
# checkwinsize check the window size after each external command and, if necessary, updates the values of $LINES and $COLUMNSk
# cmdhist save multiple-line commands in the same history entry
shopt -s autocd cdspell dirspell histappend checkjobs direxpand checkwinsize cmdhist

# Load aliases
if [ -f "$HOME/.aliasrc" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.aliasrc"
else
  echo "Could not load aliases"
fi

# Private rc file
# shellcheck disable=SC1091
[ -f "$HOME/.privrc" ] && . "$HOME/.privrc"

###########
# For FZF #
###########
_fzf_compgen_path() {
  fd --hidden --follow --exclude ".git" . "$1"
}

# Use fd to generate the list for directory completion
_fzf_compgen_dir() {
  fd --type d --hidden --follow -E ".git" . "$1" -E "Android"
}

