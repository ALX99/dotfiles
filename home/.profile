#!/usr/bin/env bash
# shellcheck disable=SC2034
# Environment variables for login shells

set -a

# UWSM sources this file with /bin/sh while preparing the graphical session.
# The rest of this profile intentionally uses bash syntax, and the login
# environment has already been captured by `uwsm start`, so skip it here.
if [ "${IN_UWSM_ENV_PRELOADER:-}" = "true" ]; then
  return 0
fi

# =============================================================================
# PATH
# =============================================================================
PNPM_HOME="$HOME/.local/share/pnpm"
GO_BIN="$HOME/go/bin"
CARGO_BIN="$HOME/.cargo/bin"
PIPX_BIN="$HOME/.local/pipxbin"
ORBSTACK_BIN="$HOME/.orbstack/bin"

PATH="$PATH:$GO_BIN:$CARGO_BIN:$PNPM_HOME:$PIPX_BIN:$ORBSTACK_BIN:$HOME/.local/bin"

# =============================================================================
# XDG
# =============================================================================
XDG_CONFIG_HOME="$HOME/.config"

# =============================================================================
# Default programs
# =============================================================================
EDITOR="nvim"

# =============================================================================
# History
# =============================================================================
HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear"
HISTSIZE=
HISTFILESIZE=
SAVEHIST=
HISTCONTROL=ignoreboth

# =============================================================================
# Platform-specific
# =============================================================================
if [[ $OSTYPE == darwin* ]]; then
  PATH="/opt/homebrew/bin:$PATH:$HOME/.gem/ruby/2.6.0/bin"
  USE_BUILTIN_RIPGREP=0
  CGO_LDFLAGS="-w"
  XDG_CACHE_HOME="$HOME/Library/Caches"
  BUN_INSTALL_CACHE_DIR="$XDG_CACHE_HOME/bun"
else
  # XDG
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
  XDG_DOWNLOAD_DIR="$HOME/Downloads"
  BUN_INSTALL_CACHE_DIR="$XDG_CACHE_HOME/bun"

  # Default programs
  TERMINAL="ghostty"
  VISUAL="nvim"
  BROWSER="brave"
  FILE="pcmanfm"

  # SSH
  SSH_ASKPASS_REQUIRE="prefer"
  SSH_ASKPASS="/usr/bin/lxqt-openssh-askpass"

  # Clean up ~/ (https://wiki.archlinux.org/title/XDG_Base_Directory)
  ZDOTDIR="$XDG_CONFIG_HOME/.config}/zsh"
  LESSHISTFILE="-"
  LESSKEY="$XDG_CONFIG_HOME/less/lesskey"
  XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority"
  WGETRC="$XDG_CONFIG_HOME/wget/wgetrc"
  GTK2_RC_FILES="$XDG_CONFIG_HOME/gtk-2.0/gtkrc"
  NPM_CONFIG_USERCONFIG="$HOME/.config/npm/npmrc"
  npm_config_prefix="$HOME/.local"

  # Input method (https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland)
  QT_IM_MODULE="fcitx"
  QT_IM_MODULES="wayland;fcitx;ibus"

fi

# =============================================================================
# Program settings
# =============================================================================

FZF_DEFAULT_COMMAND="rg --files --hidden"
FZF_LEGACY_KEYBINDINGS="0"
# shellcheck disable=SC2016
LESS='-R --use-color -Dd+r$Du+b$'
LESSKEYIN="$HOME/dotfiles/misc/lesskey"
RIPGREP_CONFIG_PATH="$HOME/.config/ripgrep/rgrc"
GH_PAGER="delta"
DOCKER_BUILDKIT="1"
TASK_TEMP_DIR="/tmp/.task"
CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"
MINIKUBE_IN_STYLE="false"
NPM_CONFIG_IGNORE_SCRIPTS=true
DISABLE_TELEMETRY=1 # Disable claude code telemetry

# Compact PS1-themed GNU ls colors.
__ls_colors() {
  local slate='38;5;245'
  local red='38;5;203'
  local green='38;5;114'
  local yellow='38;5;179'
  local blue='38;5;75'
  local purple='38;5;141'
  local cyan='38;5;109'
  local dir_blue='38;5;69'
  local dim_slate="2;${slate}"
  local entries=(
    # Filesystem state: keep high-risk and unusual entries obvious.
    "di=1;${dir_blue}" "ln=4;${cyan}" "or=1;${red}" "mi=1;${red}" "ex=1;${green}"
    "su=1;${yellow}" "sg=1;${yellow}" "tw=1;${purple}" "ow=1;${yellow}" "st=${dim_slate}"
    "pi=${yellow}" "so=${purple}" "bd=${cyan}" "cd=1;${cyan}" "do=${purple}"
    "fi=0" "no=0"

    # Archives and packages.
    "*.zip=${green}" "*.tar=${green}" "*.tgz=${green}" "*.gz=${green}" "*.bz2=${green}"
    "*.xz=${green}" "*.zst=${green}" "*.rar=${green}" "*.7z=${green}" "*.deb=${yellow}" "*.rpm=${yellow}"

    # Source code.
    "*.sh=${blue}" "*.bash=${blue}" "*.zsh=${blue}" "*.fish=${blue}" "*.py=${blue}"
    "*.js=${blue}" "*.ts=${blue}" "*.jsx=${blue}" "*.tsx=${blue}" "*.go=${cyan}" "*.rs=${cyan}"
    "*.c=${cyan}" "*.h=${cyan}" "*.cc=${cyan}" "*.cpp=${cyan}" "*.hpp=${cyan}" "*.lua=${blue}" "*.vim=${blue}"

    # Config and data.
    "*.json=${yellow}" "*.yaml=${yellow}" "*.yml=${yellow}" "*.toml=${yellow}" "*.ini=${slate}"
    "*.conf=${slate}" "*.cfg=${slate}" "*.xml=${yellow}" "*.csv=${cyan}" "*.sql=${purple}"

    # Documentation.
    "*.md=${yellow}" "*.markdown=${yellow}" "*.txt=${slate}" "*.rst=${yellow}" "*.adoc=${yellow}" "*.pdf=${purple}"
    "*README=4;${yellow}" "*README.md=4;${yellow}" "*LICENSE=${yellow}" "*CHANGELOG=${yellow}"
    "*CLAUDE.md=1;4;${purple}" "*AGENTS.md=1;4;${purple}" "*claude.md=1;4;${purple}" "*agents.md=1;4;${purple}"

    # Media.
    "*.png=${purple}" "*.jpg=${purple}" "*.jpeg=${purple}" "*.gif=${purple}" "*.webp=${purple}" "*.svg=${cyan}"
    "*.mp3=${purple}" "*.flac=${purple}" "*.wav=${purple}" "*.mp4=${purple}" "*.mov=${purple}" "*.mkv=${purple}" "*.webm=${purple}"

    # Build and project metadata.
    "*Dockerfile=1;${green}" "*Containerfile=1;${green}" "*Makefile=1;${green}" "*Justfile=1;${green}" "*justfile=1;${green}"
    "*Cargo.toml=${cyan}" "*Cargo.lock=${slate}" "*go.mod=${cyan}" "*go.sum=${slate}"
    "*package.json=${cyan}" "*package-lock.json=${slate}"

    # Sensitive files.
    "*id_rsa=1;${red}" "*id_ed25519=1;${red}" "*.pem=1;${red}" "*.key=1;${red}" "*.crt=${yellow}"
    "*.env=1;${red}" "*.env.*=1;${red}"

    # Temporary, cache, and build artifacts.
    "*.tmp=${dim_slate}" "*.temp=${dim_slate}" "*.swp=${dim_slate}" "*.swo=${dim_slate}"
    "*.o=${dim_slate}" "*.obj=${dim_slate}" "*.class=${dim_slate}" "*.pyc=${dim_slate}"
    "*.cache=${dim_slate}" "*.DS_Store=${dim_slate}"
  )

  local IFS=:
  printf '%s\n' "${entries[*]}"
}
LS_COLORS="$(__ls_colors)"
unset -f __ls_colors

# Wayland (Linux only)
if [ "$(uname)" = "Linux" ]; then
  _JAVA_AWT_WM_NONREPARENTING="1"
  QT_QPA_PLATFORMTHEME=qt6ct
  QT_QPA_PLATFORM="wayland"
  ANKI_WAYLAND=1
  MOZ_ENABLE_WAYLAND=1
fi

set +a

if [ "$(uname)" = "Linux" ] && \
  [ -x "$HOME/.local/bin/start-graphical-session" ] && \
  "$HOME/.local/bin/start-graphical-session" --may-start
then
  exec "$HOME/.local/bin/start-graphical-session"
fi

# shellcheck source=/dev/null
[ -f ~/.bashrc ] && . ~/.bashrc
