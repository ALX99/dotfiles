#!/bin/fish
echo "Setting up fish..."
rm -rf ~/.config/fish/fish_variables

# Set environtment variables
set -Ua fish_user_paths (du "$HOME/.local/bin/" | cut -f2 | paste -sd':')
set -Ux EDITOR nvim
set -Ux VISUAL nvim
#set -U FILE pcmanfm
#set -Ux TERMINAL xterm-256color
set -Ux TERM xterm-256color
set -Ux BROWSER chromium
#set -U SUDO_ASKPASS $HOME/.local/bin/dmenupass
#set -U _JAVA_AWT_WM_NONREPARENTING 1

# XDG
set -Ux XDG_CONFIG_HOME "$HOME/.config"
set -Ux XDG_CACHE_HOME "$HOME/.cache"

# Unset these
set -U fish_greeting
set -U FZF_LEGACY_KEYBINDINGS 0 # disable legacy keybindings

# Downloads fisher if necessary
if not functions -q fisher
    echo "Downloading fisher!"
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
    fisher
end

echo "Updating fisher"
fisher self-update > /dev/null

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

function nnncd --wraps nnn --description 'support nnn quit and change directory'
    # Block nesting of nnn in subshells
    if test -n "$NNNLVL"
        if [ (expr $NNNLVL + 0) -ge 1 ]
            echo "nnn is already running"
            return
        end
    end

    # The default behaviour is to cd on quit (nnn checks if NNN_TMPFILE is set)
    # To cd on quit only on ^G, remove the "-x" as in:
    #    set NNN_TMPFILE "$XDG_CONFIG_HOME/nnn/.lastd"
    # NOTE: NNN_TMPFILE is fixed, should not be modified
    if test -n "$XDG_CONFIG_HOME"
        set -x NNN_TMPFILE "$XDG_CONFIG_HOME/nnn/.lastd"
    else
        set -x NNN_TMPFILE "$HOME/.config/nnn/.lastd"
    end

    # Unmask ^Q (, ^V etc.) (if required, see `stty -a`) to Quit nnn
    # stty start undef
    # stty stop undef
    # stty lwrap undef
    # stty lnext undef

    nnn $argv

    if test -e $NNN_TMPFILE
        source $NNN_TMPFILE
        rm $NNN_TMPFILE
    end
end


funcsave lfcd
funcsave nnncd
funcsave gu
