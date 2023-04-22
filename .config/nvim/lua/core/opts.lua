-- vim is a global object that that can be manipulated
local g = vim.g
local o = vim.o

-- :options
-- :Telescope vim_options

g.mapleader = " "


-- use :h <command> for help info
o.shell                   = 'bash'

g.loaded_python3_provider = 0
g.loaded_node_provider    = 0
g.loaded_perl_provider    = 0
g.loaded_ruby_provider    = 0


o.clipboard        = 'unnamedplus' -- Copy paste between vim and everything else
o.conceallevel     = 0             -- So that I can see `` in markdown files
o.fileencoding     = "utf-8"       -- The encoding written to file

vim.opt.updatetime = 1000          -- If this many milliseconds nothing is typed the swap file will be written to disk

-- Appearance
o.termguicolors    = true     -- Enables 24-bit RGB color in the TUI
o.breakindent      = true     -- Enable break indent
o.cursorline       = true     -- Enable highlighting of the current line
o.cursorlineopt    = "number" -- Only highlight number
o.linebreak        = false    -- Don't wrap words
o.wrap             = false    -- Display long lines as just one line
o.number           = true     -- Show line numbers
o.relativenumber   = true     -- Relative line numbers
o.numberwidth      = 2
o.splitbelow       = true     -- Horizontal splits (:split) will automatically be below
o.splitright       = true     -- Vertical splits (:vsplit) will automatically be to the right
o.ruler            = true     -- Show the cursor position all the time (bottom bar)
o.showmode         = false    -- We don't need to see things like -- INSERT -- due to the statusbar plugin
o.signcolumn       = 'yes'    -- Always show sign column (otherwise it will shift text)
o.fillchars        = 'eob: '  -- Don't show `~` outside of buffer
o.hlsearch         = true     -- highlight matches<Paste>



-- Editing
o.ignorecase  = true -- Ignore case in the pattern normally
o.incsearch   = true -- search as characters are entered
o.title       = true -- set terminal title to the filename
o.showcmd     = true -- show command in bottom bar
o.lazyredraw  = true -- redraw only when we need to.
o.showmatch   = true -- highlight matching [{()}]
o.undofile    = true -- save undo history
o.expandtab   = true -- Converts tabs to spaces
o.shiftwidth  = 2    -- Number of spaces to use for each step of (auto)indent
o.tabstop     = 2    -- Number of spaces that a <Tab> in the file counts for
o.softtabstop = 2    -- Number of spaces that a <Tab> counts for while performing editing operations, like inserting a <Tab> or using <BS>
o.autoindent  = true -- Auto indent
o.infercase   = true -- Infer letter cases for a richer built-in keyword completion
o.smartcase   = true -- Don't ignore case when searching if pattern has upper case
o.smartindent = true -- Make indenting smart
o.smarttab    = true -- Makes tabbing smarter will realize you have 2 vs 4


o.matchtime = 3       -- Tenths of a second to show the matching paren, when 'showmatch' is set.
o.so = 8              -- Leave x spaces when scrolling
o.background = "dark" -- tell vim what the background color looks like

vim.opt.spelllang = 'en_us,en_gb'
vim.opt.spell = true

-- Show some invisible characters
o.list = true
vim.opt.backspace = "indent,eol,start"
vim.opt.listchars = { space = "⋅", tab = "▸ ", trail = "·" } -- eol = "↲"

o.helpheight = 25

-- Hide statusline by setting laststatus and cmdheight to 0.
-- o.laststatus = 0
-- o.cmdheight = 0
-- o.statusline = ""