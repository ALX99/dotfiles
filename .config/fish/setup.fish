#!/bin/fish
set_color green
echo "Setting up fish..."
rm -rf ~/.config/fish/fish_variables

# Set environtment variables
set -Ua fish_user_paths $HOME/.local/bin
set -Ux EDITOR nvim
set -Ux VISUAL nvim
#set -U FILE pcmanfm
#set -Ux TERMINAL xterm-256color
#set -Ux TERM xterm-256color
set -Ux BROWSER google-chrome-stable
#set -U SUDO_ASKPASS $HOME/.local/bin/dmenupass
#set -U _JAVA_AWT_WM_NONREPARENTING 1

if not functions -q fisher
    echo "Downloading fisher!"
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
end

if command -vq gh
    echo "Github CLI found!"
    gh completion -s fish 1>/dev/null
end

if command -vq go
    echo "Go installation found!"
    set -U GOPATH $HOME/go
    set -U PATH $PATH
    set -Ua fish_user_paths $GOPATH/bin
end

if command -vq flutter
    echo "Flutter installation found!"
    set -U CHROME_EXECUTABLE google-chrome-stable
    set -Ua fish_user_paths $HOME/flutter/bin/
end

set -U fish_greeting
set -U FZF_LEGACY_KEYBINDINGS 0

echo "Setting up abbreviations"
. ~/.config/fish/abbr.fish
echo "Setting up theme"
. ~/.config/fish/theme.fish

echo "Setting up functions"

function lfcd
    set tmp (mktemp)
    lf -last-dir-path=$tmp $argv
    if test -f "$tmp"
        set dir (cat $tmp)
        rm -f $tmp
        if test -d "$dir"
            if test "$dir" != (pwd)
                cd $dir
            end
        end
    end
end

funcsave lfcd
