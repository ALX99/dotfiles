hi Normal guibg=NONE ctermbg=NONE

if ! filereadable(expand('~/.config/nvim/autoload/plug.vim'))
	echo "Downloading junegunn/vim-plug to manage plugins..."
	silent !mkdir -p ~/.config/nvim/autoload/
	silent !curl "https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim" > ~/.config/nvim/autoload/plug.vim
endif
 
call plug#begin('~/.config/nvim/plugged')
Plug 'scrooloose/nerdtree'
Plug 'itchyny/lightline.vim'
Plug 'itchyny/vim-gitbranch'
Plug 'tpope/vim-eunuch' " https://github.com/tpope/vim-eunuch
Plug 'terryma/vim-multiple-cursors' " https://github.com/terryma/vim-multiple-cursors#quick-start
Plug 'w0rp/ale'
Plug 'dracula/vim', { 'as': 'dracula' }
call plug#end()

set termguicolors 
colorscheme dracula

"-------------------
"| Spaces and Tabs |
"-------------------
    set tabstop=4                       " number of visual spaces per TAB
    set softtabstop=0                   " number of spaces in tab when editing
    set shiftwidth=4                    " Spaces to use for autoindenting
    set expandtab                       " tabs are spaces
    set autoindent                      " always turn on indentation
    set smartindent
    set breakindent                     " Wrap lines at same indent level
    set backspace=eol,indent,start      " proper backspace behavior

"----------------
"|  UI Config   |
"----------------
    syntax on                           " autodetect syntax
    set title                           " set terminal title to the filename
    set number                          " current line number displayed to the right
    set relativenumber                  " show line numbers relative to cursor
    set showcmd                         " show command in bottom bar
    filetype plugin on                  " enable filetype plugins
    filetype indent on                  " load filetyp-specific intent files
    set wildmenu                        " visual autocomplete for command menu
    set wildmode=longest,full           " Enable file autocomplete in command mode
    set lazyredraw                      " redraw only when we need to.
    set showmatch                       " highlight matching [{()}]
    set mat=3                           " tenths of second to blink matching brackets
    set so=15                           " always leave 15 spaces when scrolling
    set wrap                            " wrap lines
    set linebreak                       " don't wrap words
    set splitbelow                      " horizontal split opens below
    set splitright                      " Vertical split opens to the right
    set incsearch                       " search as characters are entered
    set hlsearch                        " highlight matches<Paste>
    set mouse=a                         " mouse control
    set ruler                           " show current position
    set t_Co=256                        " use 256 colour

"----------------
"|   Plugins    |
"----------------

let g:lightline = {
      \ 'colorscheme': 'seoul256',
      \ 'active': {
      \   'left': [ [ 'mode', 'paste' ],
      \             [ 'gitbranch', 'readonly', 'filename', 'modified' ] ]
      \ },
      \ 'component_function': {
      \   'gitbranch': 'gitbranch#name'
      \ },
      \ }


"----------------
"|    Misc      |
"----------------

" colemak
nnoremap k h
nnoremap e k
vnoremap k h
vnoremap e k

nnoremap h e
nnoremap i l
vnoremap h e
vnoremap i l

nnoremap s i
nnoremap S I
vnoremap s i
vnoremap S I

nnoremap n j
vnoremap n j

nnoremap l n
nnoremap L N
vnoremap l n
vnoremap L N


set clipboard+=unnamedplus              " use system clipboard (requires xclip)
let mapleader = " "                     " set leader to space

" delete without yanking
nnoremap <leader>d "_d
vnoremap <leader>d "_d

" replace currently selected text with default register
" without yanking it
vnoremap <leader>p "_dP

" Relative numbering on and off
nmap <F2> :call NumberToggle()<CR>
" Leader mappings 
nnoremap <leader>t  :NERDTreeToggle<CR> " Nerdtree
nnoremap <leader>w  :w<CR>              " space + w to save
nnoremap <leader>q  :q<CR>              " space + q to quit
nnoremap <leader>Q  :q!<CR>             " space + Q to force quit
nnoremap <leader>s  :wq<CR>             " space + s to save and quit
nnoremap <leader>/  :noh<CR>            " space + / remove highlighed searches

" imap

" vmap
" Pressing * searches for the current selection
vnoremap <silent> * :<C-u>call VisualSelection('', '')<CR>/<C-R>=@/<CR><CR>

" Function for searching
function! VisualSelection(direction, extra_filter) range
    let l:saved_reg = @"
    execute "normal! vgvy"

    let l:pattern = escape(@", "\\/.*'$^~[]")
    let l:pattern = substitute(l:pattern, "\n$", "", "")

    if a:direction == 'gv'
        call CmdLine("Ack '" . l:pattern . "' " )
    elseif a:direction == 'replace'
        call CmdLine("%s" . '/'. l:pattern . '/')
    endif

    let @/ = l:pattern
    let @" = l:saved_reg
endfunction

function! NumberToggle()
  if(&relativenumber == 1)
    set norelativenumber
  else
    set relativenumber
  endif
endfunc
