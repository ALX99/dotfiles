# This is sourced each time fish is spawned

starship init fish | source
bind \el 'lfcd; commandline -f repaint'
bind \ef '__fzf_find_file'
bind \cr '__fzf_reverse_isearch'
bind \eo '__fzf_open'
bind \ed '__cd_dirs'
bind \eD '__cd_dirs --hidden'
