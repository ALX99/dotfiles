local indentscope_symbol = "│"
local indentscope_animation = nil
if vim.g.vscode then
  indentscope_symbol = ""
  indentscope_animation = require('mini.indentscope').gen_animation.none()
end

require('mini.indentscope').setup({
  mappings = {
    object_scope             = 'o',
    object_scope_with_border = 'ao',
    goto_top                 = '[o',
    goto_bottom              = ']o',
  },
  draw = {
    animation = indentscope_animation,
  },
  symbol = indentscope_symbol
})

if vim.g.vscode then return end

require('mini.misc').setup_restore_cursor()
require('mini.input').setup({})
require("mini.notify").setup({ lsp_progress = { enable = false } })
require("mini.icons").setup({})
local completion = require('mini.completion')
completion.setup({
  window = { info = { border = 'none' } },
  lsp_completion = {
    process_items = function(items, base)
      items = completion.default_process_items(items, base)
      for _, item in ipairs(items) do
        item.labelDetails = nil
      end
      return items
    end,
  },
})
Config.new_autocmd('User', {
  pattern = 'MiniCompletionWindowOpen',
  callback = function(args)
    if args.data.kind ~= 'info' then return end
    vim.wo[args.data.win_id].winhighlight = 'Normal:Pmenu,NormalFloat:Pmenu'
    vim.wo[args.data.win_id].winblend = vim.o.pumblend
  end,
})
Config.new_autocmd('FileType', {
  pattern = 'fff_input',
  callback = function(args)
    vim.b[args.buf].minicompletion_disable = true
  end,
})
vim.lsp.config('*', { capabilities = completion.get_lsp_capabilities() })

-- Match Blink's Enter behavior without inserting a candidate while typing.
vim.keymap.set('i', '<CR>', function()
  if vim.fn.pumvisible() == 0 then return '<CR>' end
  return vim.fn.complete_info().selected == -1 and '<C-n><C-y>' or '<C-y>'
end, { expr = true, desc = 'Accept completion or insert newline' })
require('mini.cmdline').setup({})
require('mini.bracketed').setup({
  undo = { suffix = '' },
})
require('mini.trailspace').setup({})

require('mini.extra').setup({})

local statusline = require('mini.statusline')
statusline.setup({
  content = {
    active = function()
      local mode, mode_hl = statusline.section_mode({ trunc_width = 120 })
      local diagnostics   = statusline.section_diagnostics({ trunc_width = 75 })
      local lsp           = statusline.section_lsp({ trunc_width = 75 })

      local filename      = statusline.section_filename({ trunc_width = 140 })
      local fileinfo      = statusline.section_fileinfo({ trunc_width = 120 })
      local location      = statusline.section_location({ trunc_width = 75 })
      local search        = statusline.section_searchcount({ trunc_width = 75 })

      return statusline.combine_groups({
        { hl = mode_hl,                 strings = { mode } },
        { hl = 'MiniStatuslineDevinfo', strings = { lsp } },
        '%<',
        { hl = 'MiniStatuslineFilename', strings = { filename } },
        '%=',
        { hl = 'MiniStatuslineFileinfo', strings = { diagnostics, fileinfo } },
        { hl = mode_hl,                  strings = { search, location } },
      })
    end,
  },
})

require('mini.diff').setup({
  view = {
    signs = { add = '+', change = '~', delete = '-' },
  }
})

vim.notify = require('mini.notify').make_notify({
  ERROR = { duration = 10000 },
  WARN  = { duration = 5000 },
  INFO  = { duration = 5000 },
  DEBUG = { duration = 1000 },
  TRACE = { duration = 0 },
})

require('mini.align').setup({
  mappings = {
    start              = '<leader>pa',
    start_with_preview = '<leader>pA',
  },
})

require('mini.hipatterns').setup({
  highlighters = {
    FIXME     = { pattern = 'FIXME', group = 'MiniHipatternsFixme' },
    fixme     = { pattern = 'fixme', group = 'MiniHipatternsFixme' },
    HACK      = { pattern = 'HACK', group = 'MiniHipatternsHack' },
    hack      = { pattern = 'hack', group = 'MiniHipatternsHack' },
    TODO      = { pattern = 'TODO', group = 'MiniHipatternsTodo' },
    todo      = { pattern = 'todo', group = 'MiniHipatternsTodo' },
    NOTE      = { pattern = 'NOTE', group = 'MiniHipatternsNote' },
    note      = { pattern = 'note', group = 'MiniHipatternsNote' },
    hex_color = require('mini.hipatterns').gen_highlighter.hex_color(),
  }
})

_G.Config.new_autocmd('FileType', {
  pattern  = { 'markdown' },
  callback = function()
    vim.b.minitrailspace_disable = true
  end,
})

_G.Config.new_autocmd('FileType', {
  pattern  = { 'help', 'man' },
  callback = function()
    vim.b.miniindentscope_disable = true
  end,
})

-- mini.files
local files = require('mini.files')
files.setup({
  mappings = {
    go_in       = '<Right>',
    go_in_plus  = '',
    go_out      = '<Left>',
    go_out_plus = '',
  },
})

require('utils').map('n', '<leader>ft', function()
  local dir = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':h')
  files.open(dir ~= '' and dir or nil)
end, { desc = "MiniFiles" })

-- mini.clue
local miniclue = require('mini.clue')
miniclue.setup({
  triggers = {
    -- Leader key
    { mode = 'n', keys = '<Leader>' },
    { mode = 'x', keys = '<Leader>' },

    -- Bracket mappings
    { mode = 'n', keys = '[' },
    { mode = 'n', keys = ']' },

    -- Completion
    { mode = 'i', keys = '<C-x>' },

    -- Go mappings
    { mode = 'n', keys = 'g' },
    { mode = 'x', keys = 'g' },

    -- Marks and registers
    { mode = 'n', keys = "'" },
    { mode = 'n', keys = '`' },
    { mode = 'x', keys = "'" },
    { mode = 'x', keys = '`' },
    { mode = 'n', keys = '"' },
    { mode = 'x', keys = '"' },

    -- Insert mode completion
    { mode = 'i', keys = '<C-r>' },
    { mode = 'c', keys = '<C-r>' },

    -- Window operations
    { mode = 'n', keys = '<C-w>' },

    -- Fold operations
    { mode = 'n', keys = 'z' },
    { mode = 'x', keys = 'z' },
  },
  clues = {
    miniclue.gen_clues.square_brackets(),
    miniclue.gen_clues.builtin_completion(),
    miniclue.gen_clues.g(),
    miniclue.gen_clues.marks(),
    miniclue.gen_clues.registers(),
    miniclue.gen_clues.windows(),
    miniclue.gen_clues.z(),
  },
})
