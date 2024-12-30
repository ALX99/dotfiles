-- vim is a global object that that can be manipulated
local g = vim.g
local o = vim.o
local opt = vim.opt

-- :options
-- :Telescope vim_options

g.mapleader = " "


-- use :h <command> for help info
o.shell                   = 'bash'

g.loaded_python3_provider = 0
g.loaded_node_provider    = 0
g.loaded_perl_provider    = 0
g.loaded_ruby_provider    = 0


o.clipboard      = 'unnamedplus' -- Copy paste between vim and everything else
o.conceallevel   = 0             -- So that I can see `` in markdown files
o.fileencoding   = "UTF-8"       -- The encoding written to file

opt.updatetime   = 1000          -- If this many milliseconds nothing is typed the swap file will be written to disk

-- Appearance
-- o.termguicolors  = true  -- Enabled by default in Neovim >= 0.10 if it detects terminal supports it
o.breakindent    = true  -- Enable break indent
o.cursorline     = true  -- Enable highlighting of the current line
o.cursorlineopt  = "both"
o.linebreak      = false -- Don't wrap words
o.wrap           = false -- Display long lines as just one line
o.number         = true  -- Show line numbers
o.relativenumber = true  -- Relative line numbers
o.numberwidth    = 2
o.splitbelow     = true  -- Horizontal splits (:split) will automatically be below
o.splitright     = true  -- Vertical splits (:vsplit) will automatically be to the right
o.ruler          = true  -- Show the cursor position all the time (bottom bar)
-- o.showmode       = true     -- We don't need to see things like -- INSERT -- due to the status bar plugin
o.signcolumn     = 'yes' -- Always show sign column (otherwise it will shift text)
o.hlsearch       = true  -- highlight matches



-- Editing
o.ignorecase       = true -- Ignore case in the pattern normally
o.title            = true -- set terminal title to the filename
o.showcmd          = true -- show command in bottom bar
-- o.lazyredraw      = true   -- redraw only when we need to
o.showmatch        = true -- highlight matching [{()}]
o.undofile         = true -- save undo history
o.expandtab        = true -- Converts tabs to spaces
o.shiftwidth       = 2    -- Number of spaces to use for each step of (auto)indent
o.tabstop          = 2    -- Number of spaces that a <Tab> in the file counts for
o.softtabstop      = 2    -- Number of spaces that a <Tab> counts for while performing editing operations, like inserting a <Tab> or using <BS>
o.autoindent       = true -- Auto indent
o.infercase        = true -- Infer letter cases for a richer built-in keyword completion
o.smartcase        = true -- Don't ignore case when searching if pattern has upper case
o.smartindent      = true -- Make indenting smart
o.smarttab         = true -- Makes tabbing smarter will realize you have 2 vs 4

o.matchtime        = 3    -- Tenths of a second to show the matching paren, when 'showmatch' is set.
o.scrolloff        = 8    -- Leave x spaces when scrolling
-- o.background       = "light" -- tell vim what the background color looks like
opt.sessionoptions = { "curdir", "folds", "help", "winsize", "terminal", "help" }

-- Folding
opt.foldlevel      = 99
opt.fillchars      = { fold = " " }
vim.o.foldtext     = ''
-- vim.opt.foldtext   = require("modules.foldtext")

opt.spell          = true
opt.spelllang      = 'en_us,en_gb'
o.inccommand       = "split"

-- Show some invisible characters
o.list             = false
opt.listchars      = {
  tab = "⟩ ",
  trail = "+",
  precedes = "<",
  extends = ">",
  space = "·",
  nbsp = "␣",
  leadmultispace = "│ "
}

o.helpheight       = 25


-- Diagnostics
-- Setup some nicer icons for diagnostics in the gutter (emoji)
-- local signs = { Error = "󰅚", Warn = "", Hint = "󰛩", Info = " " }
-- for type, icon in pairs(signs) do
--   local hl = "DiagnosticSign" .. type
--   vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
-- end

vim.diagnostic.config({
  virtual_text = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true, -- Errors first
  float = {
    focusable = true,
    -- style = "minimal",
    -- border = "rounded",
    source = "if_many",
  },
})

-- LSP border
-- vim.lsp.handlers['textDocument/hover'] = vim.lsp.with(
--   vim.lsp.handlers.hover,
--   { focusable = true, style = "minimal", border = "rounded" }
-- )

-- vim.lsp.handlers['textDocument/signatureHelp'] = vim.lsp.with(
--   vim.lsp.handlers.signature_help,
--   { focusable = true, style = "minimal", border = "rounded" }
-- )

vim.ui.open = (function(overridden)
  return function(path)
    vim.validate({
      path = { path, 'string' },
    })
    local is_uri = path:match('%w+:')
    local is_half_url = path:match('%.com$')
    local is_repo = vim.bo.filetype == 'lua' and path:match('%w/%w') and vim.fn.count(path, '/') == 1
    local is_dir = path:match('/%w')
    if not is_uri then
      if is_half_url then
        path = ('https://%s'):format(path)
      elseif is_repo then
        path = ('https://github.com/%s'):format(path)
      elseif not is_dir then
        path = ('https://google.com/search?q=%s'):format(path)
      end
    end
    overridden(path)
  end
end)(vim.ui.open)
