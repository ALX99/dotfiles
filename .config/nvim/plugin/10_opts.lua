-- :options

if vim.g.vscode then
  return
end

-- General ====================================================================
vim.o.winborder               = 'rounded'     -- Consistent borders on all floats (0.11+)
vim.o.mousescroll             = 'ver:6,hor:6' -- Customize mouse scroll
vim.o.undofile                = true          -- Enable persistent undo
vim.o.clipboard               = 'unnamedplus' -- Copy paste between vim and everything else
vim.opt.updatetime            = 250           -- Faster CursorHold triggers (diagnostics, references)
vim.opt.sessionoptions        = { "curdir", "help", "winsize" }
vim.opt.spelllang             = 'en,cjk'

-- UI =========================================================================
vim.o.title                   = true       -- Set terminal title to the filename
vim.o.showmatch               = true       -- highlight matching [{()}]
vim.o.colorcolumn             = '+1'
vim.o.cursorline              = true       -- Enable current line highlighting
vim.o.list                    = false      -- Show helpful text indicators
vim.o.number                  = true       -- Show line numbers
vim.o.pumheight               = 10         -- Make popup menu smaller
vim.o.pumborder               = 'none'     -- Border around completion popup (0.12+)
vim.o.ruler                   = false      -- Don't show cursor coordinates
vim.o.showcmd                 = false      -- Don't briefly echo expanded Colemak mapping RHS keys
vim.opt.shortmess:append('CFOSW')
vim.o.showmode                = false      -- Don't show mode in command line
vim.o.signcolumn              = 'yes'      -- Always show signcolumn (less flicker)
vim.o.splitbelow              = true       -- Horizontal splits will be below
vim.o.splitkeep               = 'screen'   -- Reduce scroll during window split
vim.o.splitright              = true       -- Vertical splits will be to the right
vim.o.wrap                    = false      -- Don't visually wrap lines (toggle with \w)
vim.o.numberwidth             = 2
vim.o.scrolloff               = 2          -- Leave x spaces when scrolling
vim.o.helpheight              = 25

vim.o.cursorlineopt           = 'screenline,number' -- Show cursor line per screen line

-- Special UI symbols. More is set via 'mini.basics' later.
vim.opt.fillchars             = { fold = "╌", foldopen = "▾", foldclose = "▸", foldsep = "│", eob = " " }
vim.opt.listchars             = {
  extends = "…",
  nbsp = "␣",
  precedes = "…",
  tab = "> ",

  -- trail = "+",
  -- space = "·",
  -- leadmultispace = "│ ",
}

-- Folds (see `:h fold-commands`, `:h zM`, `:h zR`, `:h zA`, `:h zj`)
vim.o.foldlevel               = 10       -- Fold nothing by default; set to 0 or 1 to fold
vim.o.foldmethod              = 'indent' -- Fold based on indent level
vim.o.foldnestmax             = 10       -- Limit number of fold levels
vim.o.foldtext                = ''       -- Show text under fold with its highlighting


-- Editing ====================================================================
vim.o.expandtab     = true                  -- Convert tabs to spaces
vim.o.formatoptions = 'rqnl1j'              -- Improve comment editing
vim.o.ignorecase    = true                  -- Ignore case during search
vim.o.infercase     = true                  -- Infer case in built-in completion
vim.o.textwidth     = 80                    -- Soft wrap target
vim.o.shiftwidth    = 2                     -- Use this number of spaces for indentation
vim.o.smartcase     = true                  -- Respect case if search pattern has upper case
vim.o.spelloptions  = 'camel'               -- Treat camelCase word parts as separate words
vim.o.tabstop       = 2                     -- Show tab as this number of spaces
vim.o.virtualedit   = 'block'               -- Allow going past end of line in blockwise mode

-- Pattern for a start of numbered list (used in `gw`). This reads as
-- "Start of list item is: at least one special character (digit, -, +, *)
-- possibly followed by punctuation (. or `)`) followed by at least one space".
vim.o.formatlistpat = [[^\s*[0-9\-\+\*]\+[\.\)]*\s\+]]

-- Built-in completion
vim.o.complete      = '.,w,b,kspell'                  -- Use less sources
vim.o.completeopt   = 'menuone,noselect,fuzzy,nosort' -- Use custom behavior


vim.diagnostic.config({
  severity_sort = true, -- Errors first
  underline = true,     -- Show all diagnostics as underline

  virtual_text = {
    current_line = true,
    severity = { min = vim.diagnostic.INFO, max = vim.diagnostic.WARN }
  },

  virtual_lines = {
    current_line = true,
    severity = { min = vim.diagnostic.ERROR }
  },


  float = {
    focusable = true,
    -- style = "minimal",
    -- border = "rounded",
    source = "if_many",
  },
})
