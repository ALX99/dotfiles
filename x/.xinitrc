#!/bin/sh
[ -f "$HOME/.scripts/system/autostart" ] && . ~/.scripts/system/autostart

while true; do
    /usr/local/bin/dwm 2> /dev/null
    sleep 1
done
