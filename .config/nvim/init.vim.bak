hi Normal guibg=NONE ctermbg=NONE
filetype plugin on
" Omni stuff elow show be removed once I bother to add
" nvim-cpm
set omnifunc=syntaxcomplete#Complete
set completeopt=menuone,noinsert

function! OpenCompletion()
    if !pumvisible() && ((v:char >= 'a' && v:char <= 'z') || (v:char >= 'A' && v:char <= 'Z') || v:char == '.')
        call feedkeys("\<C-x>\<C-o>", "n")
    endif
endfunction
autocmd InsertCharPre * call OpenCompletion()

if ! filereadable(expand('~/.config/nvim/autoload/plug.vim'))
	echo "Downloading junegunn/vim-plug to manage plugins..."
	silent !mkdir -p ~/.config/nvim/autoload/
	silent !curl "https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim" > ~/.config/nvim/autoload/plug.vim
endif

call plug#begin('~/.config/nvim/plugged')
Plug 'itchyny/lightline.vim'       " https://github.com/itchyny/lightline.vim
Plug 'itchyny/vim-gitbranch'       " https://github.com/itchyny/vim-gitbranch
Plug 'junegunn/vim-easy-align'     " https://github.com/junegunn/vim-easy-align
Plug 'norcalli/nvim-colorizer.lua' " https://github.com/norcalli/nvim-colorizer.lua
Plug 'neovim/nvim-lspconfig'       " https://github.com/neovim/nvim-lspconfig

" Themes
Plug 'dracula/vim', { 'as': 'dracula' } " https://github.com/dracula/vim
Plug 'gryf/wombat256grf'                " https://github.com/gryf/wombat256grf

call plug#end()


source $HOME/.config/nvim/general.vim
source $HOME/.config/nvim/mappings.vim

colorscheme wombat256grf


"----------------
"|   Plugins    |
"----------------
lua require("lsp_config")

autocmd BufWritePre *.go lua vim.lsp.buf.formatting()

let g:lightline = {
      \ 'colorscheme': 'wombat',
      \ 'active': {
      \   'left': [ [ 'mode', 'paste' ],
      \             [ 'gitbranch', 'readonly', 'filename', 'modified' ] ],
      \   'right': [ [ 'lineinfo' ],
      \              [ 'percent' ],
      \              [ 'fileformat', 'fileencoding', 'filetype' ] ]
      \ },
      \ 'component_function': {
      \   'gitbranch': 'gitbranch#name'
      \ },
      \ }
