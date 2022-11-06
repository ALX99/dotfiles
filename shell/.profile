#!/bin/bash
# shellcheck disable=SC2034

set -a

PATH="$PATH:$HOME/go/bin:$PATH:$HOME/.cargo/bin:$HOME/.local/bin/"

# XDG
XDG_CACHE_HOME="$HOME/.cache"
XDG_CONFIG_HOME="$HOME/.config"
XDG_DATA_HOME="$HOME/.local/share"
XDG_STATE_HOME="$HOME/.local/state"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
XDG_RUNTIME_DIR="$(ls -d /tmp/runtime-"$USER".???* 2>/dev/null || mktemp -d /tmp/runtime-"$USER".XXX | tee)"

stty -ixon # Disable ctrl-s and ctrl-q.

# Stuff that I want to conditionally set
if true; then
  # Default programs
  TERMINAL="st"
  TERM="st-256color"
  EDITOR="nvim"
  VISUAL="nvim"
  BROWSER="brave"
  FILE="pcmanfm"
fi

# Program settings
FZF_DEFAULT_COMMAND="rg --files --hidden"
FZF_LEGACY_KEYBINDINGS="0"
_JAVA_AWT_WM_NONREPARENTING="1"
DOCKER_BUILDKIT="1"
CGO_ENABLED="0"
LESSKEYIN="$HOME/dotfiles/misc/lesskey"
[ -x "$(command -v bat)" ] && MANPAGER="sh -c 'col -bx | bat -l man -p'"

# Clean up ~/
# https://wiki.archlinux.org/title/XDG_Base_Directory
# The XAUTHORITY line will break some DMs.
ZDOTDIR="$XDG_CONFIG_HOME/.config}/zsh"
LESSHISTFILE="-"
LESSKEY="$XDG_CONFIG_HOME/less/lesskey"
XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority"
WGETRC="$XDG_CONFIG_HOME/wget/wgetrc"
GTK2_RC_FILES="$XDG_CONFIG_HOME/gtk-2.0/gtkrc"

# IM
GTK_IM_MODULE="fcitx"
QT_IM_MODULE="fcitx"
XMODIFIERS="@im=fcitx"

# Bash stuff
PROMPT_COMMAND='history -a'                     # Record each line as it gets issued
HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear" # Don't record some commands
HISTSIZE=-1                                     # Infinite history
HISTFILESIZE=-1                                 # Infinite history
HISTCONTROL=ignoreboth                          # Don't record duplicate stuff & stuff that starts with space in history

set +a
eval "$(dircolors -p | perl -pe 's/^((CAP|S[ET]|O[TR]|M|E)\w+).*/$1 00/' | dircolors -)"

