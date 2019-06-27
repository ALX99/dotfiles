#!/bin/sh
[ -f "$HOME/.local/bin/autostart" ] && . ~/.local/bin/autostart

#exec startxfce4
while true; do
    /usr/local/bin/dwm 2> /dev/null
    sleep 1
done
