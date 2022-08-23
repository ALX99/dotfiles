-- vim is a global object that that can be manipulated
local g = vim.g
local o = vim.o

-- use :h <command> for help info

g.mapleader = " "
-- o.guicursor = "" -- No GUI cursor
o.clipboard = 'unnamedplus' -- Copy paste between vim and everything else

o.cmdheight = 2 -- More space for displaying messages
o.conceallevel = 0 -- So that I can see `` in markdown files
o.fileencoding = "utf-8" -- The encoding written to file

vim.opt.updatetime = 1000 -- If this many milliseconds nothing is typed the swap file will be written to disk


o.number         = true -- Show line numbers
o.relativenumber = true -- Relative line numbers
o.numberwidth    = 2

-- Tabs
o.showtabline = 2 -- Always show tabs
o.list        = true
o.listchars   = "tab:>-"

-- Indenting
o.expandtab   = true -- Converts tabs to spaces
o.shiftwidth  = 2 -- Number of spaces to use for each step of (auto)indent
o.tabstop     = 2 -- Number of spaces that a <Tab> in the file counts for
o.softtabstop = 2 -- Number of spaces that a <Tab> counts for while performing editing operations, like inserting a <Tab> or using <BS>
o.autoindent  = true -- Auto indent
o.smartindent = true -- Make it smart

o.smarttab = true -- Makes tabbing smarter will realize you have 2 vs 4

o.splitbelow = true -- Horizontal splits (:split) will automatically be below
o.splitright = true -- Vertical splits (:vsplit) will automatically be to the right


o.hlsearch  = true -- highlight matches<Paste>
o.incsearch = true -- search as characters are entered


o.termguicolors = true -- Enables 24-bit RGB color in the TUI
o.cursorline    = true -- Enable highlighting of the current line
o.ruler         = true -- Show the cursor position all the time (bottom bar)
o.smartindent   = true -- Makes indenting smart

o.ignorecase = true -- Ignore case in the pattern normally
o.smartcase  = true -- If the pattern contains a multiline character it is case sensative
o.title      = true -- set terminal title to the filename
o.showcmd    = true -- show command in bottom bar
o.lazyredraw = true -- redraw only when we need to.
o.showmatch  = true -- highlight matching [{()}]

o.linebreak = false -- Don't wrap words
o.wrap      = false -- Display long lines as just one line

o.matchtime = 3 -- Tenths of a second to show the matching paren, when 'showmatch' is set.
o.so = 8 -- Always leave 15 spaces when scrolling
o.background = "dark" -- tell vim what the background color looks like

-- disable some builtin vim plugins
local default_plugins = {
  "2html_plugin",
  "getscript",
  "getscriptPlugin",
  "gzip",
  "logipat",
  "netrw",
  "netrwPlugin",
  "netrwSettings",
  "netrwFileHandlers",
  "matchit",
  "tar",
  "tarPlugin",
  "rrhelper",
  "spellfile_plugin",
  "vimball",
  "vimballPlugin",
  "zip",
  "zipPlugin",
  -- "tutor",
  "rplugin",
  "syntax",
  "synmenu",
  "optwin",
  "compiler",
  "bugreport",
  "ftplugin",
}

for _, plugin in pairs(default_plugins) do
  g["loaded_" .. plugin] = 1
end


-- TODO stuff left over from general.vim
--au! BufWritePost $MYVIMRC source %      " auto source when writing to init.vm alternatively you can run :source $MYVIMRC
-- yntax enable             -- Enables syntax highlighing
-- set hidden                              -- Required to keep multiple buffers open multiple buffers
-- set breakindent                         -- Wrap lines at same indent level
-- set iskeyword+=-          -- treat dash separated words as a word text object--
-- set formatoptions-=cro    -- Stop newline continution of comments
-- set autochdir                           -- Your working directory will always be the same as your working directory
-- Settings configured for plugins
-- o.laststatus = 2 -- Always show statusbar
-- o.showmode = false  -- We don't need to see things like -- INSERT -- due to the statusbar plugin
-- o.mouse = "a"               -- Enable your mouse
