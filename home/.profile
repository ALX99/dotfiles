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

# Compact PS1-themed GNU ls colors. Keep this synchronized with the palette
# documented in Ghostty, tmux, and home/.bashrc.
LS_COLORS='di=1;38;5;69:ln=4;38;5;109:or=1;38;5;203:mi=1;38;5;203:ex=1;38;5;114:su=1;38;5;179:sg=1;38;5;179:tw=1;38;5;141'\
':ow=1;38;5;179:st=2;38;5;245:pi=38;5;179:so=38;5;141:bd=38;5;109:cd=1;38;5;109:do=38;5;141:fi=0:no=0:*.zip=38;'\
'5;114:*.tar=38;5;114:*.tgz=38;5;114:*.gz=38;5;114:*.bz2=38;5;114:*.xz=38;5;114:*.zst=38;5;114:*.rar=38;5;114:*'\
'.7z=38;5;114:*.deb=38;5;179:*.rpm=38;5;179:*.sh=38;5;75:*.bash=38;5;75:*.zsh=38;5;75:*.fish=38;5;75:*.py=38;5;'\
'75:*.js=38;5;75:*.ts=38;5;75:*.jsx=38;5;75:*.tsx=38;5;75:*.go=38;5;109:*.rs=38;5;109:*.c=38;5;109:*.h=38;5;109'\
':*.cc=38;5;109:*.cpp=38;5;109:*.hpp=38;5;109:*.lua=38;5;75:*.vim=38;5;75:*.json=38;5;179:*.yaml=38;5;179:*.yml'\
'=38;5;179:*.toml=38;5;179:*.ini=38;5;245:*.conf=38;5;245:*.cfg=38;5;245:*.xml=38;5;179:*.csv=38;5;109:*.sql=38'\
';5;141:*.md=38;5;179:*.markdown=38;5;179:*.txt=38;5;245:*.rst=38;5;179:*.adoc=38;5;179:*.pdf=38;5;141:*README='\
'4;38;5;179:*README.md=4;38;5;179:*LICENSE=38;5;179:*CHANGELOG=38;5;179:*CLAUDE.md=1;4;38;5;141:*AGENTS.md=1;4;'\
'38;5;141:*claude.md=1;4;38;5;141:*agents.md=1;4;38;5;141:*.png=38;5;141:*.jpg=38;5;141:*.jpeg=38;5;141:*.gif=3'\
'8;5;141:*.webp=38;5;141:*.svg=38;5;109:*.mp3=38;5;141:*.flac=38;5;141:*.wav=38;5;141:*.mp4=38;5;141:*.mov=38;5'\
';141:*.mkv=38;5;141:*.webm=38;5;141:*Dockerfile=1;38;5;114:*Containerfile=1;38;5;114:*Makefile=1;38;5;114:*Jus'\
'tfile=1;38;5;114:*justfile=1;38;5;114:*Cargo.toml=38;5;109:*Cargo.lock=38;5;245:*go.mod=38;5;109:*go.sum=38;5;'\
'245:*package.json=38;5;109:*package-lock.json=38;5;245:*id_rsa=1;38;5;203:*id_ed25519=1;38;5;203:*.pem=1;38;5;'\
'203:*.key=1;38;5;203:*.crt=38;5;179:*.env=1;38;5;203:*.env.*=1;38;5;203:*.tmp=2;38;5;245:*.temp=2;38;5;245:*.s'\
'wp=2;38;5;245:*.swo=2;38;5;245:*.o=2;38;5;245:*.obj=2;38;5;245:*.class=2;38;5;245:*.pyc=2;38;5;245:*.cache=2;3'\
'8;5;245:*.DS_Store=2;38;5;245:'

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
