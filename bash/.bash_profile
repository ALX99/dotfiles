# Runs on login

export PATH="$PATH:$HOME/.scripts/tools" 
export EDITOR="nvim"
export VISUAL="nvim"
export FILE="pcmanfm"
export TERMINAL="urxvt"
export BROWSER="firefox"
export SUDO_ASKPASS="$HOME/.scripts/tools/askpass-rofi"
export GTK_IM_MODULE=xim
export QT_IM_MODULE=xim
export XMODIFIERS=@im=fcitx


export LESS_TERMCAP_mb=$(printf '\e[01;31m') # enter blinking mode - red
export LESS_TERMCAP_md=$(printf '\e[01;36m') # enter double-bright mode - bold, cyan
export LESS_TERMCAP_me=$(printf '\e[0m') # turn off all appearance modes (mb, md, so, us)
export LESS_TERMCAP_se=$(printf '\e[0m') # leave standout mode
export LESS_TERMCAP_so=$(printf '\e[01;33m') # enter standout mode - yellow
export LESS_TERMCAP_ue=$(printf '\e[0m') # leave underline mode
export LESS_TERMCAP_us=$(printf '\e[04;32m') # enter underline mode - green

# Start graphical server if i3 not already running.
[ "$(tty)" = "/dev/tty1" ] && ! pgrep -x i3 >/dev/null && exec startx
