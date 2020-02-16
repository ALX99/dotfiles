# Runs on login

export GOPATH="$HOME/go"
export PATH="$PATH:$HOME/.local/bin/:$GOPATH/bin:$HOME/flutter/bin/:"
export EDITOR="nvim"
export VISUAL="nvim"
export FILE="pcmanfm"
export TERMINAL="st"
export BROWSER="google-chrome-stable"
export SUDO_ASKPASS="$HOME/.local/bin/dmenupass"
export _JAVA_AWT_WM_NONREPARENTING=1
# For flutter
export CHROME_EXECUTABLE="google-chrome-stable"

# ZSH stuff
export ZSH=$HOME/.oh-my-zsh
# Async zsh autocomplete
export ZSH_AUTOSUGGEST_USE_ASYNC="set"

# Used by alias & paccy
# Location to keep track of number of updated/installed packaged
export PKG_UPDATE_COUNTER=$HOME/.pkgUpdateCount
# When the PKG_UPDATE_COUNTER reaches this limit,
# the computer will restart rather than hibernate
export UPDATE_LIMIT=100

# Colour for man pages
export LESS_TERMCAP_mb=$(printf '\e[01;31m') # enter blinking mode - red
export LESS_TERMCAP_md=$(printf '\e[01;36m') # enter double-bright mode - bold, cyan
export LESS_TERMCAP_me=$(printf '\e[0m')     # turn off all appearance modes (mb, md, so, us)
export LESS_TERMCAP_se=$(printf '\e[0m')     # leave standout mode
export LESS_TERMCAP_so=$(printf '\e[01;33m') # enter standout mode - yellow
export LESS_TERMCAP_ue=$(printf '\e[0m')     # leave underline mode
export LESS_TERMCAP_us=$(printf '\e[04;32m') # enter underline mode - green

# LS colors, made with https://geoff.greer.fm/lscolors/
export LSCOLORS="Gxfxcxdxbxegedabagacad"
export LS_COLORS='no=00:fi=00:di=01;34:ln=00;36:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=41;33;01:ex=00;32:*.cmd=00;32:*.exe=01;32:*.com=01;32:*.bat=01;32:*.btm=01;32:*.dll=01;32:*.tar=00;31:*.tbz=00;31:*.tgz=00;31:*.rpm=00;31:*.deb=00;31:*.arj=00;31:*.taz=00;31:*.lzh=00;31:*.lzma=00;31:*.zip=00;31:*.zoo=00;31:*.z=00;31:*.Z=00;31:*.gz=00;31:*.bz2=00;31:*.tb2=00;31:*.tz2=00;31:*.tbz2=00;31:*.avi=01;35:*.bmp=01;35:*.fli=01;35:*.gif=01;35:*.jpg=01;35:*.jpeg=01;35:*.mng=01;35:*.mov=01;35:*.mpg=01;35:*.pcx=01;35:*.pbm=01;35:*.pgm=01;35:*.png=01;35:*.ppm=01;35:*.tga=01;35:*.tif=01;35:*.xbm=01;35:*.xpm=01;35:*.dl=01;35:*.gl=01;35:*.wmv=01;35:*.aiff=00;32:*.au=00;32:*.mid=00;32:*.mp3=00;32:*.ogg=00;32:*.voc=00;32:*.wav=00;32:'

source /home/alex/.config/broot/launcher/bash/br
export GPG_TTY=$(tty)
