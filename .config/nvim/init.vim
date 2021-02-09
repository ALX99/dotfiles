hi Normal guibg=NONE ctermbg=NONE

if ! filereadable(expand('~/.config/nvim/autoload/plug.vim'))
	echo "Downloading junegunn/vim-plug to manage plugins..."
	silent !mkdir -p ~/.config/nvim/autoload/
	silent !curl "https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim" > ~/.config/nvim/autoload/plug.vim
endif

call plug#begin('~/.config/nvim/plugged')
Plug 'itchyny/lightline.vim'
Plug 'itchyny/vim-gitbranch'
" https://github.com/junegunn/fzf.vim
Plug 'junegunn/fzf.vim'
Plug 'fatih/vim-go', { 'do': ':GoUpdateBinaries' }
"Plug 'preservim/nerdcommenter' " TODO setup
"Plug 'tpope/vim-surround'
"Plug 'junegunn/vim-easy-align' " https://github.com/junegunn/vim-easy-align
"Plug 'terryma/vim-multiple-cursors' " https://github.com/terryma/vim-multiple-cursors#quick-start
Plug 'dracula/vim', { 'as': 'dracula' }
Plug 'gryf/wombat256grf'
"Plug 'dense-analysis/ale'
Plug 'norcalli/nvim-colorizer.lua'
call plug#end()


let g:completion_confirm_key = "\<C-y>"

let g:ale_enabled = 0
let g:ale_completion_enabled = 0
let g:ale_completion_autoimport = 0
set omnifunc=syntaxcomplete#Complete

source $HOME/.config/nvim/general.vim
source $HOME/.config/nvim/mappings.vim
colorscheme dracula

set completeopt=menuone,noinsert,noselect
"set completeopt=menu,noinsert,noselect,menuone

"----------------
"|   Plugins    |
"----------------
"

let g:lightline = {
      \ 'colorscheme': 'jellybeans',
      \ 'active': {
      \   'left': [ [ 'mode', 'paste' ],
      \             [ 'gitbranch', 'readonly', 'filename', 'modified' ] ]
      \ },
      \ 'component_function': {
      \   'gitbranch': 'gitbranch#name'
      \ },
      \ }


let g:ale_completion_enabled=1
let g:ale_fixers = {
\   '*':        ['remove_trailing_lines', 'trim_whitespace'],
\   'sh':       ['shfmt'],
\   'markdown': ['prettier'],
\   'python': ['black'],
\   'go': ['gofmt'],
\}
let g:ale_fix_on_save = 1
