#!/bin/fish
set_color green
echo "Setting up fish..."
rm -rf ~/.config/fish/fish_variables

# Set environtment variables
set -Ua fish_user_paths $HOME/.local/bin
set -U EDITOR nvim
set -U VISUAL nvim
#set -U FILE pcmanfm
#set -U TERMINAL st
#set -U TERM st
set -U BROWSER google-chrome-stable
#set -U SUDO_ASKPASS $HOME/.local/bin/dmenupass
#set -U _JAVA_AWT_WM_NONREPARENTING 1

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

