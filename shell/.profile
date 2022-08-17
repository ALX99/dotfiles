#!/bin/sh
# shellcheck disable=SC2034

set -a

PATH="$PATH:$HOME/go/bin:$PATH:$HOME/.cargo/bin:$(command du "$HOME/.local/bin/" | cut -f2 | paste -sd':')"

# XDG
XDG_CACHE_HOME="$HOME/.cache"
XDG_CONFIG_HOME="$HOME/.config"
XDG_DATA_HOME="$HOME/.local/share"
XDG_STATE_HOME="$HOME/.local/state"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
XDG_RUNTIME_DIR="$(ls -d /tmp/runtime-"$USER".???* 2>/dev/null || mktemp -d /tmp/runtime-"$USER".XXX | tee)"

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

# Clean up ~/
# https://wiki.archlinux.org/title/XDG_Base_Directory
# The XAUTHORITY line will break some DMs.
ZDOTDIR="${XDG_CONFIG_HOME:-$HOME/.config}/zsh"
LESSHISTFILE="-"
LESSKEY="$XDG_CONFIG_HOME"/less/lesskey
XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority"
WGETRC="${XDG_CONFIG_HOME:-$HOME/.config}/wget/wgetrc"
GTK2_RC_FILES="${XDG_CONFIG_HOME:-$HOME/.config}"/gtk-2.0/gtkrc

# IM
GTK_IM_MODULE="fcitx"
QT_IM_MODULE="fcitx"
XMODIFIERS="@im=fcitx"

set +a
