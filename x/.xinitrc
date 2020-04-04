#!/bin/sh
[ -f ~/.xprofile ] && . ~/.xprofile

while true; do
    /usr/local/bin/dwm 2> /dev/null
    sleep 1
done
