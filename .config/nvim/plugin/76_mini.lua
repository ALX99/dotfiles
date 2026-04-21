-- mini.nvim suite (depends on: sidekick.lua for statusline, snacks.lua for rename)
-- Load order: must run after sidekick.lua and snacks.lua
vim.pack.add({
  { src = 'https://github.com/nvim-mini/mini.nvim', version = vim.version.range('*') },
})

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
require("mini.notify").setup({ lsp_progress = { enable = false } })
require("mini.icons").setup({})
require('mini.cmdline').setup({})
require('mini.bracketed').setup({})
require('mini.trailspace').setup({})

require('mini.statusline').setup({
  content = {
    active = function()
      local mode, mode_hl = MiniStatusline.section_mode({ trunc_width = 120 })
      local diagnostics   = MiniStatusline.section_diagnostics({ trunc_width = 75 })
      local lsp           = MiniStatusline.section_lsp({ trunc_width = 75 })

      local filename = MiniStatusline.section_filename({ trunc_width = 140 })
      local fileinfo = MiniStatusline.section_fileinfo({ trunc_width = 120 })
      local location = MiniStatusline.section_location({ trunc_width = 75 })
      local search   = MiniStatusline.section_searchcount({ trunc_width = 75 })

      return MiniStatusline.combine_groups({
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

vim.api.nvim_create_autocmd('FileType', {
  pattern  = { 'markdown' },
  callback = function()
    vim.b.minitrailspace_disable = true
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern  = { 'help', 'man' },
  callback = function()
    vim.b.miniindentscope_disable = true
  end,
})

-- mini.files
require('mini.files').setup({
  mappings = {
    go_in       = '<Right>',
    go_in_plus  = '<nop>',
    go_out      = '<Left>',
    go_out_plus = '<nop>',
  },
})

vim.api.nvim_create_autocmd("User", {
  pattern  = "MiniFilesActionRename",
  callback = function(event)
    require('snacks').rename.on_rename_file(event.data.from, event.data.to)
  end,
})

require('utils').map('n', '<leader>ft', function()
  MiniFiles.open(vim.api.nvim_buf_get_name(0))
end, { desc = "MiniFiles" })

-- mini.clue
local miniclue = require('mini.clue')
miniclue.setup({
  triggers = {
    { mode = 'n', keys = '<Leader>' },
    { mode = 'x', keys = '<Leader>' },
    { mode = 'n', keys = '[' },
    { mode = 'n', keys = ']' },
    { mode = 'i', keys = '<C-x>' },
    { mode = 'n', keys = 'g' },
    { mode = 'x', keys = 'g' },
    { mode = 'n', keys = "'" },
    { mode = 'n', keys = '`' },
    { mode = 'x', keys = "'" },
    { mode = 'x', keys = '`' },
    { mode = 'n', keys = '"' },
    { mode = 'x', keys = '"' },
    { mode = 'i', keys = '<C-r>' },
    { mode = 'c', keys = '<C-r>' },
    { mode = 'n', keys = '<C-w>' },
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
