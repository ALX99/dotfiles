#!/bin/bash
# Runs everytime bash shell is launched

# If not running interactively, don't do anything
case $- in
*i*) ;;
*) return ;;
esac

function parse_git_dirty {
	[[ -n $(git status -s 2>/dev/null) ]] && echo "*"
}
function parse_git_branch {
	git branch --no-color 2>/dev/null | sed -e '/^[^*]/d' -e "s/* \(.*\)/(\1$(parse_git_dirty))/"
}
export PS1='\[\e[38;5;211m\]\W\[\e[\033[38;5;48m\]$(parse_git_branch)\[\e[\033[00m\] ><> '

# Load aliases
if [ -f "$HOME/.aliasrc" ]; then
	. "$HOME/.aliasrc"
else
	echo "Could not load aliases"
fi

# Work alises
[ -f "$HOME/.workaliasrc" ] && . "$HOME/.workaliasrc"

###########
# For FZF #
###########
_fzf_compgen_path() {
	fd --hidden --follow --exclude ".git" . "$1"
}

# Use fd to generate the list for directory completion
_fzf_compgen_dir() {
	fd --type d --hidden --follow -E ".git" . "$1" -E "Android"
}

