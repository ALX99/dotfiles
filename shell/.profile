#!/bin/sh

# Set environtment variables
export PATH="$PATH:$HOME/go/bin:$(command du "$HOME/.local/bin/" | cut -f2 | paste -sd':')"

# Default programs
export TERMINAL="st" \
    TERM="st-256color" \
    EDITOR="nvim" \
    VISUAL="nvim" \
    BROWSER="brave" \
    FILE="pcmanfm"

# XDG
export XDG_CACHE_HOME="$HOME/.cache" \
    XDG_CONFIG_HOME="$HOME/.config" \
    XDG_DATA_HOME="$HOME/.local/share" \
    XDG_DOWNLOAD_DIR="$HOME/Downloads"

# Program settings
export FZF_DEFAULT_COMMAND="rg --files --hidden" \
    FZF_LEGACY_KEYBINDINGS="0" \
    SUDO_ASKPASS="dmenupass" \
    _JAVA_AWT_WM_NONREPARENTING="1" \
    DOCKER_BUILDKIT="1" \
    CGO_ENABLED="0" \
    LESSKEYIN="$HOME/dotfiles/misc/lesskey"

# Clean up ~/
# The XAUTHORITY line will break some DMs.
export ZDOTDIR="${XDG_CONFIG_HOME:-$HOME/.config}/zsh" \
    LESSHISTFILE="-" \
    LESSKEY="$XDG_CONFIG_HOME"/less/lesskey \
    XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority" \
    WGETRC="${XDG_CONFIG_HOME:-$HOME/.config}/wget/wgetrc" \
    GTK2_RC_FILES="${XDG_CONFIG_HOME:-$HOME/.config}"/gtk-2.0/gtkrc
