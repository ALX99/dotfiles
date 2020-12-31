#!/bin/fish
echo "Setting up fish..."
rm -rf ~/.config/fish/fish_variables

# Set environtment variables
set -Ua fish_user_paths (du "$HOME/.local/bin/" | cut -f2 | paste -sd':')
set -Ux EDITOR nvim
set -Ux VISUAL nvim
set -Ux TERMINAL xterm-256color
set -Ux TERM xterm-256color
set -Ux BROWSER brave
set -Ux SUDO_ASKPASS $HOME/.local/bin/dmenupass
set -Ux _JAVA_AWT_WM_NONREPARENTING 1

# XDG
set -Ux XDG_CONFIG_HOME "$HOME/.config"
set -Ux XDG_CACHE_HOME "$HOME/.cache"
set -Ux XDG_DATA_HOME "$HOME/.local/share"
set -Ux XDG_DOWNLOAD_DIR "$HOME/Downloads"

# FZF
set -U FZF_DEFAULT_COMMAND "rg --files --hidden"
set -U FZF_LEGACY_KEYBINDINGS 0 # disable legacy keybindings

# Fish plugins
set -U pisces_only_insert_at_eol 1
set -U FZF_FIND_FILE_COMMAND "fd -H -t f -d 1"
set -U FZF_DISABLE_KEYBINDINGS 1


# Fish
set -U fish_greeting

# Downloads fisher if necessary
if not functions -q fisher
    echo "Downloading fisher!"
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
    fisher
end

echo "Updating fisher"
fisher update >/dev/null

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


echo "Setting up personal config"
. ~/.config/fish/abbr.fish
. ~/.config/fish/theme.fish

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

function __cd_dirs
    if contains -- --hidden $argv
        set -l p (fd -H -t d -E '.git' | fzf)
        if test "$status" -eq 0
            cd "$p"
        end
    else
        set -l p (fd -t d | fzf)
        if test "$status" -eq 0
            cd "$p"
        end
    end
    commandline -f repaint
end

function gu --description 'Open the webpage for the current github repo/branch'
  set -l fetch_url (command git remote --verbose show -n origin ^/dev/null | command grep Fetch | cut -c 14- )

  #did we get an exit status?
  if [ $status -gt 0 ]
    echo 'Not a git repo.'
    return 1
  end

  if [ -z $fetch_url ]
    echo 'Not a git repo.'
    return 1
  end

  if [ -z (echo $fetch_url | grep github ) ]
    echo 'Not a github repo.'
    return 3
  end

  set -l branch (command git rev-parse --abbrev-ref HEAD)

  if [ $branch = 'HEAD' ]
    # we couldn't find a branch or tag, so lets get a sha
    set branch (command git rev-parse HEAD)
  end

  set url (echo "$fetch_url/tree/$branch" | sed 's|git@github.com:\(.*\)\.git|https://github.com/\1|')

  open "$url/$argv"
end

funcsave lfcd
funcsave __cd_dirs
funcsave gu
