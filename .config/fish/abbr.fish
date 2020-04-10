#########
# Basic #
#########
abbr -a q exit
abbr -a c clear
abbr -a e '$EDITOR'
abbr -a se "sudoedit"
abbr -a ep '$EDITOR ~/.config/fish/config.fish; source ~/.config/fish/config.fish'
abbr -a ea '$EDITOR ~/.config/fish/abbr.fish; source ~/.config/fish/config.fish'
abbr -a h 'cd ~'
abbr -a p paccy
abbr -a sp 'sudo pacman'
abbr -a g 'git'
abbr -a gc 'git clone'
abbr -a gjunk 'git commit -m "(curl http://whatthecommit.com/index.txt)"'
abbr -a please 'sudo !!'
abbr -a cx 'chmod +x'
abbr -a copy 'xclip -selection clipboard <'
abbr -a lg 'lazygit'
# Go install
abbr -a goi 'go install'
# Go produce
abbr -a gop 'CGO_ENABLED=0 go install -v -a -ldflags "-s -w" -gcflags=all=-trimpath=(pwd) -asmflags=all=-trimpath=(pwd)'
abbr -a gob 'CGO_ENABLED=0 go build -v -a -ldflags "-s -w" -gcflags=all=-trimpath=(pwd) -asmflags=all=-trimpath=(pwd)'
abbr -a gor 'go run'

###########
# Listing #
###########
abbr -a cl 'clear;ls'
abbr -a lt 'trash-list'

##############
# Navigation #
##############
abbr -a bin 'cd ~/dotfiles/.local/bin'
abbr -a dl 'cd ~/Downloads'
abbr -a dots 'cd ~/dotfiles'
abbr -a config 'cd ~/dotfiles/.config'

############
# Advanced #
############
# Show why the go modules are needed
abbr -a gmod 'go list -m all | fzf --height 40% --color --preview "go mod why -m \$(echo {} | cut -f 1 -d'"'"' '"'"')"'

########
# Misc #
########
abbr -a t 'trash-put'
abbr -a rt 'trash-restore'
abbr -a ct 'trash-empty'
abbr -a x 'extract'
abbr -a bye 'systemctl hibernate'
# Setting my custom keyboard
abbr -a keyb 'setxkbmap colemak && xmodmap ~/dotfiles/keymaps/xmodColemakCustom && xset r rate 210 30'
# managing suckless patches
abbr -a reset 'make clean && git reset --hard remotes/origin/master && rm -f config.h'
# compile protobuf with grpc included
abbr -a protorpc 'protoc --go_out=plugins=grpc:. *.proto'
# Better cat
abbr -a cat 'bat'
# Compress directory
abbr -a compress 'tar cJf archive.tar.xz'
# Screen Off
abbr -a so 'xset dpms force off'
abbr -a perms "stat -c '%a %n' *"
abbr -a priv "fish -P"

###############
# Better flags#
###############
abbr -a grep 'grep --color=auto'
abbr -a cp 'cp -i'
abbr -a mv 'mv -i'
abbr -a rm 'rm -iv'
abbr -a mkdir 'mkdir -p'
abbr -a free 'free -h'
abbr -a df 'df -h'
abbr -a upower 'upower -i /org/freedesktop/UPower/devices/battery_BAT0'
abbr -a du 'ncdu'
abbr -a dd 'dd bs=512k'

##########
# Hashes #
##########
abbr -a sha1 'openssl sha1'
abbr -a sha256 'openssl sha256'
