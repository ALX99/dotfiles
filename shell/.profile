#!/bin/sh
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
MANPAGER="sh -c 'col -bx | bat -l man -p'"

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
if [ -n "$BASH_VERSION" ]; then
	PROMPT_COMMAND='history -a'                     # Record each line as it gets issued
	HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear" # Don't record some commands
	HISTSIZE=-1                                     # Infinite history
	HISTFILESIZE=-1                                 # Infinite history
	HISTCONTROL=ignoreboth                          # Don't record duplicate stuff & stuff that starts with space in history

	# autocd autocd
	# cdspell fix minor spelling mistakes in dirname of a cd command
	# dirspell Bash attempts spelling correction on directory names during word completion if the directory name initially supplied does not exist.
	# histappend append to $HISTFILE instead of overwriting it
	# checkjobs check if there are any stopped or running jobs before exiting an interactive shell
	# checkwinsize check the window size after each external command and, if necessary, updates the values of $LINES and $COLUMNSk
	# cmdhist Ues one command per line

	# We should be running bash in this if condition
	# shellcheck disable=SC3044
	shopt -s autocd cdspell dirspell histappend checkjobs direxpand checkwinsize cmdhist
fi

set +a

