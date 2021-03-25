let g:mapleader = "\<space>"

" colemak
nnoremap k h
nnoremap e k
vnoremap k h
vnoremap e k


nnoremap h e
nnoremap H E
nnoremap i l
vnoremap h e
vnoremap H E
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

" kk to esc
inoremap kk <Esc>

" TAB in general mode will move to text buffer
nnoremap <TAB>   :bnext<CR>
" SHIFT-TAB will go back
nnoremap <S-TAB> :bprevious<CR>
" Alternate ways to save and quit
nnoremap <M-w> :w<CR>
nnoremap <M-s> :wq<CR>
nnoremap <M-q> :q<CR>
nnoremap <M-Q> :q!<CR>
" Use control-c instead of escape
nnoremap <C-c> <Esc>

" <TAB>: completion.
inoremap <expr><Down> pumvisible() ? "\<C-n>" : "\<Down>"
inoremap <expr><Up> pumvisible() ? "\<C-p>" : "\<Up>"

" Use alt + knei to move windows
nnoremap <M-k> <C-w>h
nnoremap <M-n> <C-w>j
nnoremap <M-e> <C-w>k
nnoremap <M-i> <C-w>l

" Use ctrl + knei to resize windows
nnoremap <C-n>    :resize -2<CR>
nnoremap <C-e>    :resize +2<CR>
nnoremap <C-k>    :vertical resize -2<CR>
" Ahhh this is sending the TAB key
" https://stackoverflow.com/questions/14641942/how-to-unmap-tab-and-do-not-make-ctrl-i-invalid-in-vim
"nnoremap <C-i>    :vertical resize +2<CR>


" Replace currently selected text with default register
" without yanking it in visual mode
vnoremap <leader>p "_dP

" Relative numbering on and off
nmap <F2> :call NumberToggle()<CR>

" Leader mappings
nnoremap <leader>/  :noh<CR>            " space + / remove highlighed searches

" Start interactive EasyAlign in visual mode (e.g. vipga)
xmap ga <Plug>(EasyAlign)
" Start interactive EasyAlign for a motion/text object (e.g. gaip)
nmap ga <Plug>(EasyAlign)


function! NumberToggle()
  if(&relativenumber == 1)
    set norelativenumber
  else
    set relativenumber
  endif
endfunc
