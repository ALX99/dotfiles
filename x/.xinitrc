#!/bin/sh
[ -f ~/.xprofile ] && . ~/.xprofile

#exec startplasma-x11
#exec startxfce4
#exec spectrwm
while true; do
    /usr/local/bin/dwm
    sleep 1
done
