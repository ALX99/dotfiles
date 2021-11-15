#!/bin/bash
# Runs everytime bash shell is launched

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

export PS1="\u@\h \[$(tput sgr0)\]\[\033[38;5;81m\]\W\[$(tput sgr0)\]\[\033[38;5;15m\]->\[$(tput sgr0)\]"
export PROMPT_COMMAND='history -a' # Record each line as it gets issued
export HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear" # Don't record some commands
export HISTSIZE=-1
export HISTFILESIZE=-1
export HISTCONTROL=ignoreboth


shopt -s autocd cdspell dirspell histappend checkjobs direxpand checkwinsize cmdhist
stty -ixon # Disable ctrl-s and ctrl-q.

# Load aliases
[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/shell/aliasrc" ] && source "${XDG_CONFIG_HOME:-$HOME/.config}/shell/aliasrc"

# Git change branch
gcb() {
  result=$(git branch -a --color=always | grep -v '/HEAD\s' | sort |
    fzf --height 50% --border --ansi --tac --preview-window right:70% \
      --preview 'git log --oneline --graph --date=short --pretty="format:%C(auto)%cd %h%d %s" $(sed s/^..// <<< {} | cut -d" " -f1) | head -'$LINES |
    sed 's/^..//' | cut -d' ' -f1)

  if [[ $result != "" ]]; then
    if [[ $result == remotes/* ]]; then
      git checkout --track $(echo $result | sed 's#remotes/##')
    else
      git checkout "$result"
    fi
  fi
}

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

