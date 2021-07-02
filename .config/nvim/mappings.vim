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

" Alternate ways to save and quit
nnoremap <M-w> :w<CR>
nnoremap <M-s> :wq<CR>
nnoremap <M-q> :q<CR>
nnoremap <M-Q> :q!<CR>
" Use control-c instead of escape
nnoremap <C-c> <Esc>


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
