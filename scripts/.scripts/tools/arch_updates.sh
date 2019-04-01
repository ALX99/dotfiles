#!/bin/bash
#https://github.com/ALX99/dotfiles
#This will hopefully get cleaned up if I ever learn bash

if [ "$1" = "--update" ]; then
    /usr/bin/ping -c 1 www.archlinux.org > /dev/null || { echo "archlinux.org is down. Aborting" && exit 1; }
    news=$(curl -s "https://www.archlinux.org/feeds/news/")
    todaysDate=$(date +%s)
    newNews=false
    mapfile -t dates < <(echo "$news" | sed -n 's:.*<pubDate>\(.*\)</pubDate>.*:\1:p')
    mapfile -t titles < <(echo "$news" | sed -n 's:.*<title>\(.*\)</title>.*:\1:p')
    mapfile -t links < <(echo "$news" | sed -n 's:.*<link>\(.*\)</link>.*:\1:p')
    for i in "${!dates[@]}"; do 
        newsDate=$(date -d "${dates[$i]}" +%s)
        diff=$((todaysDate - newsDate))
        if [ $diff -lt 604800 ]; then # News less than a week old
            newNews=true
            read -p "Would you like to read '${titles[$i]}' (Y/n)? " -N 1 -r -s; echo
            if [[ $REPLY =~ ^[Nn]$ ]]; then continue; fi # if no, continue
            $BROWSER ${links[$i]}&> /dev/null & # open link
        fi
    done
if [ "$newNews" = false ] ; then
    echo "There is no new news, Updating :)"
fi
yay -Syu
exit 0 
fi

if [ "$1" = "--status" ]; then
    mapfile -t updates < <(checkupdates && yay -Qum)
    for i in "${updates[@]}"; do
        notify-send "$(echo "$i" | sed 's/\s.*$//')"
    done
fi


if ! updates_arch=$(checkupdates 2> /dev/null | wc -l ); then
    updates_arch=0
fi

if ! updates_aur=$(yay -Qum 2> /dev/null | wc -l); then
    updates_aur=0
fi

updates=$(("$updates_arch" + "$updates_aur"))

if [ "$updates" -gt 0 ]; then
    echo "$updates"
else
    echo "0"
fi
