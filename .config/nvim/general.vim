set termguicolors
syntax enable                           " Enables syntax highlighing
"set hidden                              " Required to keep multiple buffers open multiple buffers
set nowrap                              " Display long lines as just one line
"set wrap                                " Wrap lines
"set linebreak                           " Don't wrap words
"set breakindent                         " Wrap lines at same indent level
set encoding=utf-8                      " The encoding displayed
set fileencoding=utf-8                  " The encoding written to file
set ruler              			            " Show the cursor position all the time
set cmdheight=2                         " More space for displaying messages
set iskeyword+=-                      	" treat dash separated words as a word text object"
set mouse=a                             " Enable your mouse
set splitbelow                          " Horizontal splits will automatically be below
set splitright                          " Vertical splits will automatically be to the right
set t_Co=256                            " Support 256 colors
set conceallevel=0                      " So that I can see `` in markdown files
set tabstop=2                           " Insert 2 spaces for a tab
set shiftwidth=2                        " Change the number of space characters inserted for indentation
set smarttab                            " Makes tabbing smarter will realize you have 2 vs 4
set expandtab                           " Converts tabs to spaces
set smartindent                         " Makes indenting smart
set autoindent                          " Good auto indent
set laststatus=0                        " Always display the status line
set number                              " Line numbers
"set relativenumber                      " Relative line numbers
set cursorline                          " Enable highlighting of the current line
set background=dark                     " tell vim what the background color looks like
set showtabline=2                       " Always show tabs
set noshowmode                          " We don't need to see things like -- INSERT -- anymore
"set nobackup                            " This is recommended by coc
"set nowritebackup                       " This is recommended by coc
"set updatetime=300                      " Faster completion
"set timeoutlen=500                      " By default timeoutlen is 1000 ms
set formatoptions-=cro                  " Stop newline continution of comments
set clipboard=unnamedplus               " Copy paste between vim and everything else
"set autochdir                           " Your working directory will always be the same as your working directory

set ignorecase                          " Ignore case in the pattern normally
set smartcase                           " If the pattern contains a multiline character it is case sensative
set title                               " set terminal title to the filename
set showcmd                             " show command in bottom bar
filetype plugin on                      " enable filetype plugins
filetype indent on                      " load filetyp-specific intent files
set lazyredraw                          " redraw only when we need to.
set showmatch                           " highlight matching [{()}]
set mat=3                               " tenths of second to blink matching brackets
set so=15                               " always leave 15 spaces when scrolling
set incsearch                           " search as characters are entered
set hlsearch                            " highlight matches<Paste>
"set softtabstop=0                       " number of spaces in tab when editing
"set backspace=eol,indent,start          " proper backspace behavior

au! BufWritePost $MYVIMRC source %      " auto source when writing to init.vm alternatively you can run :source $MYVIMRC
