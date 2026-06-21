-- Snacks.nvim (picker, statuscolumn, etc.)
if vim.g.vscode then return end
vim.pack.add({
  {
    src = 'https://github.com/folke/snacks.nvim',
    version = vim.version.range('*')
  },
})

require('snacks').setup({
  bigfile = {},
  input = {},
  picker = {
    sources = {
      smart = { filter = { cwd = true } },
      recent = { filter = { cwd = true } },
    },
    win = {
      input = {
        keys = {
          ["j"] = false,
          ["k"] = false,
          ["<C-n>"] = { "list_down", mode = { "i", "n" } },
          ["<C-e>"] = { "list_up", mode = { "i", "n" } },
          ["n"] = { "list_down", mode = { "n" } },
          ["e"] = { "list_up", mode = { "n" } },
        },
      },
      list = {
        keys = {
          ["j"] = false,
          ["k"] = false,
          ["n"] = "list_down",
          ["e"] = "list_up",
        },
      },
      preview = {
        minimal = true,
      },
    },
  },
  statuscolumn = {
    enabled = false,
  },
  -- todo enable when it does not have a
  -- bug when referencing something bigger
  -- to something smaller on the same line
  -- words = {  }
})

local map = require('utils').map
local Snacks = require('snacks')

-- file finding and grep moved to 74_fff.lua

map('n', '<leader>ob', function() Snacks.picker.buffers({}) end, { desc = "Buffers" })
map('n', '<leader>oC', function() Snacks.picker.colorschemes({}) end, { desc = "Colorschemes" })
map('n', '<leader>oc', function() Snacks.picker.commands({}) end, { desc = "Commands" })
map('n', '<leader>od', function() Snacks.picker.diagnostics({}) end, { desc = "Diagnostics" })
map('n', '<leader>oD', function() Snacks.picker.diagnostics_buffer({}) end, { desc = "Buffer Diagnostics" })
map('n', '<leader>ol', function() Snacks.picker.git_log({}) end, { desc = "Git Log" })
map('n', '<leader>oL', function() Snacks.picker.git_log_file({}) end, { desc = "Git Log for Current File" })
map('n', '<leader>oh', function() Snacks.picker.help({}) end, { desc = "Help Pages" })
map('n', '<leader><leader>/', function() Snacks.picker.lines({}) end, { desc = "Buffer Lines" })
map('n', '<leader>oq', function() Snacks.picker.qflist({}) end, { desc = "Quickfix List" })
map('n', '<leader>oR', function() Snacks.picker.recent({}) end, { desc = "Recent files" })
map('n', '<leader>oS', function() Snacks.picker.spelling({}) end, { desc = "Spelling" })
map('n', '<leader>ou', function() Snacks.picker.undo({}) end, { desc = "Undo History" })

map('n', '<leader>fs', function() Snacks.picker.smart() end, { desc = "Find Files (smart)" })
