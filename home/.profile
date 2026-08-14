#!/bin/sh
# shellcheck disable=SC2034
# Environment variables for login shells

set -a
__kernel_name=$(uname)

# =============================================================================
# PATH
# =============================================================================
PNPM_HOME="$HOME/.local/share/pnpm"
GO_BIN="$HOME/go/bin"
CARGO_BIN="$HOME/.cargo/bin"
PIPX_BIN="$HOME/.local/pipxbin"
ORBSTACK_BIN="$HOME/.orbstack/bin"

PATH="$PATH:$GO_BIN:$CARGO_BIN:$PNPM_HOME:$PIPX_BIN:$ORBSTACK_BIN:$HOME/.local/bin:$HOME/.local/share/nvim/mason/bin"

# =============================================================================
# XDG
# =============================================================================
XDG_CONFIG_HOME="$HOME/.config"

# =============================================================================
# Default programs
# =============================================================================
TERMINAL="ghostty"
if command -v code >/dev/null 2>&1; then
  VISUAL="code --wait"
fi
EDITOR="nvim"

# =============================================================================
# Platform-specific
# =============================================================================
if [ "$__kernel_name" = "Darwin" ]; then
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
  BROWSER="brave"
  FILE="pcmanfm"

  # SSH
  SSH_ASKPASS_REQUIRE="prefer"
  SSH_ASKPASS="/usr/bin/lxqt-openssh-askpass"
  if [ -z "${SSH_CONNECTION:-}" ] &&
    [ -n "${XDG_RUNTIME_DIR:-}" ] &&
    [ -S "$XDG_RUNTIME_DIR/ssh-agent.socket" ]; then
    SSH_AUTH_SOCK="$XDG_RUNTIME_DIR/ssh-agent.socket"
  fi

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
PI_FFF_MODE=override # Replace pi's built-in find/grep with FFF (pi-fff ext)

# Twilight Bloom LS_COLORS uses Ghostty's ANSI palette, so all terminal apps
# get the same vivid semantic colors without a separate xterm-256 palette.
LS_COLORS='di=1;34:ln=4;36:or=1;31:mi=1;31:ex=1;32:su=1;33:sg=1;33:tw=1;35:ow=1;33:st=2;90:pi=33:so=35:bd=36:cd=1;36:do=35:fi=0:no=0'\
':*.zip=32:*.tar=32:*.tgz=32:*.gz=32:*.bz2=32:*.xz=32:*.zst=32:*.rar=32:*.7z=32:*.deb=33:*.rpm=33:*.sh=34:*.bash=34:*.zsh=34:*.fish=34:*.py=34:*.js=34:*.ts=34:*.jsx=34:*.tsx=34:*.go=36:*.rs=36:*.c=36:*.h=36:*.cc=36:*.cpp=36:*.hpp=36:*.lua=34:*.vim=34'\
':*.json=33:*.yaml=33:*.yml=33:*.toml=33:*.ini=90:*.conf=90:*.cfg=90:*.xml=33:*.csv=36:*.sql=35:*.md=33:*.markdown=33:*.txt=90:*.rst=33:*.adoc=33:*.pdf=35:*README=4;33:*README.md=4;33:*LICENSE=33:*CHANGELOG=33:*CLAUDE.md=1;4;35:*AGENTS.md=1;4;35:*claude.md=1;4;35:*agents.md=1;4;35'\
':*.png=35:*.jpg=35:*.jpeg=35:*.gif=35:*.webp=35:*.svg=36:*.mp3=35:*.flac=35:*.wav=35:*.mp4=35:*.mov=35:*.mkv=35:*.webm=35:*Dockerfile=1;32:*Containerfile=1;32:*Makefile=1;32:*Justfile=1;32:*justfile=1;32:*Cargo.toml=36:*Cargo.lock=90:*go.mod=36:*go.sum=90:*package.json=36:*package-lock.json=90:*id_rsa=1;31:*id_ed25519=1;31:*.pem=1;31:*.key=1;31:*.crt=33:*.env=1;31:*.env.*=1;31:*.tmp=2;90:*.temp=2;90:*.swp=2;90:*.swo=2;90:*.o=2;90:*.obj=2;90:*.class=2;90:*.pyc=2;90:*.cache=2;90:*.DS_Store=2;90'

set +a

if [ "$__kernel_name" = "Linux" ] &&
  command -v uwsm >/dev/null 2>&1 &&
  uwsm check may-start; then
  exec uwsm start -e -D Hyprland -- hyprland.desktop >/tmp/hyprland.log 2>&1
fi
unset __kernel_name

# Disable terminal flow control once per login session.
if [ -t 0 ]; then
  stty -ixon
fi

# shellcheck source=/dev/null
[ -n "$BASH_VERSION" ] && [ -f ~/.bashrc ] && . ~/.bashrc
