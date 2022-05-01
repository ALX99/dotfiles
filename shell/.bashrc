#!/bin/bash
# Runs everytime bash shell is launched

# If not running interactively, don't do anything
case $- in
*i*) ;;
*) return ;;
esac
if [ $EUID -ne 0 ]; then
  export PS1='\[\e[0;38;5;141m\]\W \[\e[0;38;5;153m\]>\[\e[0;38;5;153m\]<\[\e[0;38;5;153m\]> \[\e[0m\]'
else
  export PS1='\[\e[0;38;5;141m\]\W \[\e[0;91m\]>\[\e[0;91m\]<\[\e[0;91m\]> \[\e[0m\]'
fi

export PROMPT_COMMAND='history -a'                     # Record each line as it gets issued
export HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear" # Don't record some commands
export HISTSIZE=-1
export HISTFILESIZE=-1
export HISTCONTROL=ignoreboth

# autocd autocd
# cdspell fix minor spelling mistakes in dirname of a cd command
# dirspell Bash attempts spelling correction on directory names during word completion if the directory name initially supplied does not exist.
# histappend append to $HISTFILE instead of overwriting it
# checkjobs check if there are any stopped or running jobs before exiting an interactive shell
# checkwinsize check the window size after each external command and, if necessary, updates the values of $LINES and $COLUMNSk
# cmdhist Save all lines of a multiplefline command in the same entry
shopt -s autocd cdspell dirspell histappend checkjobs direxpand checkwinsize cmdhist
stty -ixon # Disable ctrl-s and ctrl-q.

# Load aliases
[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/shell/aliasrc" ] && source "${XDG_CONFIG_HOME:-$HOME/.config}/shell/aliasrc"

# Git change branch
# gcb() {
#   result=$(git branch -a --color=always | grep -v '/HEAD\s' | sort |
#     fzf --height 50% --border --ansi --tac --preview-window right:70% \
#       --preview 'git log --oneline --graph --date=short --pretty="format:%C(auto)%cd %h%d %s" $(sed s/^..// <<< {} | cut -d" " -f1) | head -'$LINES |
#     sed 's/^..//' | cut -d' ' -f1)

#   if [[ $result != "" ]]; then
#     if [[ $result == remotes/* ]]; then
#       git checkout --track $(echo $result | sed 's#remotes/##')
#     else
#       git checkout "$result"
#     fi
#   fi
# }

# Bring aliases to SSH target
sshs() {
  ssh "$@" "cat > /tmp/.bashrc_temp" <~/.aliasrc
  ssh -t "$@" "bash --rcfile /tmp/.bashrc_temp ; rm /tmp/.bashrc_temp"
}

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
