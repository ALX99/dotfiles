# Runs on login

export PATH="$PATH:$HOME/.scripts/tools" 
export EDITOR="nvim"
export FILE="pcmanfm"
export TERMINAL="urxvt"
export BROWSER="chromium"
export SUDO_ASKPASS="$HOME/.scripts/tools/askpass-rofi"

# Start graphical server if i3 not already running.
[ "$(tty)" = "/dev/tty1" ] && ! pgrep -x i3 >/dev/null && exec startx
