#!/bin/zsh

# Load aliases
if [ -f "$HOME/.aliasrc" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.aliasrc"
else
  echo "Could not load aliases"
fi


eval "$(direnv hook zsh)"

autoload -Uz compinit
compinit
_comp_options+=(globdots)
