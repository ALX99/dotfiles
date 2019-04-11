# Runs everytime bash shell is launched
# ~/.bashrc

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

export PS1="[^.^] \[$(tput sgr0)\]\[\033[38;5;81m\]\W\[$(tput sgr0)\]\[\033[38;5;15m\]> \[$(tput sgr0)\]"

shopt -s autocd histappend 
stty -ixon # Disable ctrl-s and ctrl-q.
#(cat ~/.cache/wal/sequences &) # pywal
[ -f "$HOME/.aliasrc" ] && source ".aliasrc"
