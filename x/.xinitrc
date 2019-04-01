# Load our .Xresources
xrdb -load ~/.Xresources &
# i3
exec i3
# Used for dunst to help detect display without display manader
systemctl --user import-environment DISPLAY
