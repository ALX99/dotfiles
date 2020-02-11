# Runs everytime bash shell is launched
# ~/.bashrc

# If not running interactively, don't do anything
[[ $- != *i* ]] && return
export PS1="\u@\h \[$(tput sgr0)\]\[\033[38;5;81m\]\W\[$(tput sgr0)\]\[\033[38;5;15m\]->\[$(tput sgr0)\]"

shopt -s autocd histappend
stty -ixon # Disable ctrl-s and ctrl-q.
source "$HOME/.aliasrc"
source /home/alex/.config/broot/launcher/bash/br
