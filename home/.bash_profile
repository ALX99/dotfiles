#!/usr/bin/env bash
# Environment variables for Bash login shells

# =============================================================================
# PATH
# =============================================================================
export PNPM_HOME="$HOME/.local/share/pnpm"

# Login shells inherit PATH from their parent, so add each directory only when
# it is missing. Nested login shells (agents, `bash -lc`) would otherwise
# append the same directories again at every level.
__path_add() {
  local mode=$1 dir
  shift
  for dir in "$@"; do
    case ":$PATH:" in
    *":$dir:"*) continue ;;
    esac
    if [[ $mode == prepend ]]; then
      PATH="$dir${PATH:+:$PATH}"
    else
      PATH="${PATH:+$PATH:}$dir"
    fi
  done
}

if [[ $OSTYPE == darwin* ]]; then
  __path_add prepend /opt/homebrew/bin
fi
__path_add append \
  "$HOME/go/bin" "$HOME/.cargo/bin" "$PNPM_HOME" "$PNPM_HOME/bin" \
  "$HOME/.local/pipxbin" "$HOME/.orbstack/bin" "$HOME/.local/bin"
unset -f __path_add

# =============================================================================
# XDG
# =============================================================================
export XDG_CONFIG_HOME="$HOME/.config"

# =============================================================================
# Default programs
# =============================================================================
unset VISUAL
export EDITOR="nvim"

# =============================================================================
# Platform-specific
# =============================================================================
if [[ $OSTYPE == darwin* ]]; then
  export CGO_LDFLAGS="-w"
  export XDG_CACHE_HOME="$HOME/Library/Caches"
else
  # XDG
  export XDG_CACHE_HOME="$HOME/.cache"
  export XDG_DATA_HOME="$HOME/.local/share"
  export XDG_STATE_HOME="$HOME/.local/state"
  export XDG_DOWNLOAD_DIR="$HOME/Downloads"

  # Clean up ~/ (https://wiki.archlinux.org/title/XDG_Base_Directory)
  export LESSHISTFILE="-"
  export WGETRC="$XDG_CONFIG_HOME/wget/wgetrc"
  export GTK2_RC_FILES="$XDG_CONFIG_HOME/gtk-2.0/gtkrc"
  export NPM_CONFIG_USERCONFIG="$HOME/.config/npm/npmrc"
  export npm_config_prefix="$HOME/.local"
fi

# =============================================================================
# Program settings
# =============================================================================
export BUN_INSTALL_CACHE_DIR="$XDG_CACHE_HOME/bun"
export FZF_DEFAULT_COMMAND="rg --files --hidden"
# shellcheck disable=SC2016
export LESS='-R --use-color -Dd+r$Du+b$'
export LESSKEYIN="$XDG_CONFIG_HOME/less/lesskey"
export RIPGREP_CONFIG_PATH="$HOME/.config/ripgrep/rgrc"
export GH_PAGER="delta"
export DISABLE_TELEMETRY=1 # Disable claude code telemetry

# Twilight Bloom LS_COLORS uses Ghostty's ANSI palette, so all terminal apps
# get the same vivid semantic colors without a separate xterm-256 palette.
export LS_COLORS='di=1;34:ln=4;36:or=1;31:mi=1;31:ex=1;32:su=1;33:sg=1;33:tw=1;35:ow=1;33:st=2;90:pi=33:so=35:bd=36:cd=1;36:do=35:fi=0:no=0:*.zip=32:*.tar=32:*.tgz=32:*.gz=32:*.bz2=32:*.xz=32:*.zst=32:*.rar=32:*.7z=32:*.deb=33:*.rpm=33:*.sh=34:*.bash=34:*.zsh=34:*.fish=34:*.py=34:*.js=34:*.ts=34:*.jsx=34:*.tsx=34:*.go=36:*.rs=36:*.c=36:*.h=36:*.cc=36:*.cpp=36:*.hpp=36:*.lua=34:*.vim=34:*.json=33:*.yaml=33:*.yml=33:*.toml=33:*.ini=90:*.conf=90:*.cfg=90:*.xml=33:*.csv=36:*.sql=35:*.md=33:*.markdown=33:*.txt=90:*.rst=33:*.adoc=33:*.pdf=35:*README=4;33:*README.md=4;33:*LICENSE=33:*CHANGELOG=33:*CLAUDE.md=1;4;35:*AGENTS.md=1;4;35:*claude.md=1;4;35:*agents.md=1;4;35:*.png=35:*.jpg=35:*.jpeg=35:*.gif=35:*.webp=35:*.svg=36:*.mp3=35:*.flac=35:*.wav=35:*.mp4=35:*.mov=35:*.mkv=35:*.webm=35:*Dockerfile=1;32:*Containerfile=1;32:*Makefile=1;32:*Justfile=1;32:*justfile=1;32:*Cargo.toml=36:*Cargo.lock=90:*go.mod=36:*go.sum=90:*package.json=36:*package-lock.json=90:*id_rsa=1;31:*id_ed25519=1;31:*.pem=1;31:*.key=1;31:*.crt=33:*.env=1;31:*.env.*=1;31:*.tmp=2;90:*.temp=2;90:*.swp=2;90:*.swo=2;90:*.o=2;90:*.obj=2;90:*.class=2;90:*.pyc=2;90:*.cache=2;90:*.DS_Store=2;90'

# Disable terminal flow control once per login session.
if [ -t 0 ]; then
  stty -ixon
fi

# Noninteractive login Bash needs shims; interactive Bash gets full activation.
case $- in
*i*) ;;
*)
  if command -v mise >/dev/null 2>&1; then
    eval "$(mise activate bash --shims)"
  fi
  ;;
esac

# shellcheck source=/dev/null
[ -f ~/.bashrc ] && . ~/.bashrc
