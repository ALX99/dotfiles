#!/bin/sh
# shellcheck disable=SC2034
# Environment variables for login shells

set -a

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
TERMINAL="ghostty"
EDITOR="nvim"

# =============================================================================
# History
# =============================================================================
HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear"
HISTSIZE=
HISTFILESIZE=
HISTCONTROL=ignoreboth

# =============================================================================
# Platform-specific
# =============================================================================
if [ "$(uname)" = "Darwin" ]; then
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
  VISUAL="nvim"
  BROWSER="brave"
  FILE="pcmanfm"

  # SSH
  SSH_ASKPASS_REQUIRE="prefer"
  SSH_ASKPASS="/usr/bin/lxqt-openssh-askpass"

  # Clean up ~/ (https://wiki.archlinux.org/title/XDG_Base_Directory)
  LESSHISTFILE="-"
  LESSKEY="$XDG_CONFIG_HOME/less/lesskey"
  XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority"
  WGETRC="$XDG_CONFIG_HOME/wget/wgetrc"
  GTK2_RC_FILES="$XDG_CONFIG_HOME/gtk-2.0/gtkrc"
  NPM_CONFIG_USERCONFIG="$HOME/.config/npm/npmrc"
  npm_config_prefix="$HOME/.local"
fi

# =============================================================================
# Program settings
# =============================================================================

FZF_DEFAULT_COMMAND="rg --files --hidden"
FZF_LEGACY_KEYBINDINGS="0"
# shellcheck disable=SC2016
LESS='-R --use-color -Dd+r$Du+b$'
LESSKEYIN="$XDG_CONFIG_HOME/less/lesskey"
RIPGREP_CONFIG_PATH="$HOME/.config/ripgrep/rgrc"
GH_PAGER="delta"
DOCKER_BUILDKIT="1"
NPM_CONFIG_IGNORE_SCRIPTS=true
DISABLE_TELEMETRY=1 # Disable claude code telemetry

# Compact PS1-themed GNU ls colors.
__ls_colors() (
  slate='38;5;245'
  red='38;5;203'
  green='38;5;114'
  yellow='38;5;179'
  blue='38;5;75'
  purple='38;5;141'
  cyan='38;5;109'
  dir_blue='38;5;69'
  dim_slate="2;${slate}"
  c=""

  # Filesystem state: keep high-risk and unusual entries obvious.
  c="${c}di=1;${dir_blue}:ln=4;${cyan}:or=1;${red}:mi=1;${red}:ex=1;${green}:"
  c="${c}su=1;${yellow}:sg=1;${yellow}:tw=1;${purple}:ow=1;${yellow}:st=${dim_slate}:"
  c="${c}pi=${yellow}:so=${purple}:bd=${cyan}:cd=1;${cyan}:do=${purple}:"
  c="${c}fi=0:no=0:"

  # Archives and packages.
  c="${c}*.zip=${green}:*.tar=${green}:*.tgz=${green}:*.gz=${green}:*.bz2=${green}:"
  c="${c}*.xz=${green}:*.zst=${green}:*.rar=${green}:*.7z=${green}:*.deb=${yellow}:*.rpm=${yellow}:"

  # Source code.
  c="${c}*.sh=${blue}:*.bash=${blue}:*.zsh=${blue}:*.fish=${blue}:*.py=${blue}:"
  c="${c}*.js=${blue}:*.ts=${blue}:*.jsx=${blue}:*.tsx=${blue}:*.go=${cyan}:*.rs=${cyan}:"
  c="${c}*.c=${cyan}:*.h=${cyan}:*.cc=${cyan}:*.cpp=${cyan}:*.hpp=${cyan}:*.lua=${blue}:*.vim=${blue}:"

  # Config and data.
  c="${c}*.json=${yellow}:*.yaml=${yellow}:*.yml=${yellow}:*.toml=${yellow}:*.ini=${slate}:"
  c="${c}*.conf=${slate}:*.cfg=${slate}:*.xml=${yellow}:*.csv=${cyan}:*.sql=${purple}:"

  # Documentation.
  c="${c}*.md=${yellow}:*.markdown=${yellow}:*.txt=${slate}:*.rst=${yellow}:*.adoc=${yellow}:*.pdf=${purple}:"
  c="${c}*README=4;${yellow}:*README.md=4;${yellow}:*LICENSE=${yellow}:*CHANGELOG=${yellow}:"
  c="${c}*CLAUDE.md=1;4;${purple}:*AGENTS.md=1;4;${purple}:*claude.md=1;4;${purple}:*agents.md=1;4;${purple}:"

  # Media.
  c="${c}*.png=${purple}:*.jpg=${purple}:*.jpeg=${purple}:*.gif=${purple}:*.webp=${purple}:*.svg=${cyan}:"
  c="${c}*.mp3=${purple}:*.flac=${purple}:*.wav=${purple}:*.mp4=${purple}:*.mov=${purple}:*.mkv=${purple}:*.webm=${purple}:"

  # Build and project metadata.
  c="${c}*Dockerfile=1;${green}:*Containerfile=1;${green}:*Makefile=1;${green}:*Justfile=1;${green}:*justfile=1;${green}:"
  c="${c}*Cargo.toml=${cyan}:*Cargo.lock=${slate}:*go.mod=${cyan}:*go.sum=${slate}:"
  c="${c}*package.json=${cyan}:*package-lock.json=${slate}:"

  # Sensitive files.
  c="${c}*id_rsa=1;${red}:*id_ed25519=1;${red}:*.pem=1;${red}:*.key=1;${red}:*.crt=${yellow}:"
  c="${c}*.env=1;${red}:*.env.*=1;${red}:"

  # Temporary, cache, and build artifacts.
  c="${c}*.tmp=${dim_slate}:*.temp=${dim_slate}:*.swp=${dim_slate}:*.swo=${dim_slate}:"
  c="${c}*.o=${dim_slate}:*.obj=${dim_slate}:*.class=${dim_slate}:*.pyc=${dim_slate}:"
  c="${c}*.cache=${dim_slate}:*.DS_Store=${dim_slate}:"

  printf '%s\n' "$c"
}
LS_COLORS="$(__ls_colors)"
unset -f __ls_colors

set +a

if [ "$(uname)" = "Linux" ] &&
  command -v uwsm >/dev/null 2>&1 &&
  uwsm check may-start; then
  exec uwsm start -e -D Hyprland -- hyprland.desktop >/tmp/hyprland.log 2>&1
fi

# shellcheck source=/dev/null
[ -n "$BASH_VERSION" ] && [ -f ~/.bashrc ] && . ~/.bashrc
