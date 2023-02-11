#!/bin/sh
#
# shellcheck disable=SC1091
[ -r ~/.xprofile ] && . "$HOME/.xprofile"

#exec startplasma-x11
#exec startxfce4
#exec spectrwm
while true; do
  /usr/local/bin/dwm
  sleep 1
done

