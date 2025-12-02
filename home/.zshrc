#!/bin/zsh
# shellcheck shell=bash

# https://zsh.sourceforge.io/Doc/Release/Options.html
setopt APPEND_HISTORY
setopt EXTENDED_HISTORY # Write the history file in the ":start:elapsed;command" format.
setopt HIST_EXPIRE_DUPS_FIRST # Expire duplicate entries first when trimming history.
setopt HIST_FIND_NO_DUPS
setopt HIST_IGNORE_DUPS # Don't record an entry that was just recorded again.
setopt HIST_IGNORE_ALL_DUPS # Delete old recorded entry if new entry is a duplicate.
setopt HIST_FIND_NO_DUPS # Do not display a line previously found.
setopt HIST_REDUCE_BLANKS # Remove superfluous blanks before recording entry.
setopt INC_APPEND_HISTORY # Write to the history file immediately, not when the shell exits.

autoload -Uz compinit
compinit
_comp_options+=(globdots)

# Load aliases
if [ -f "$HOME/.aliasrc" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.aliasrc"
else
  echo "Could not load aliases"
fi

eval "$(direnv hook zsh)"
