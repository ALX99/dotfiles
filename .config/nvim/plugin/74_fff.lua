-- fff.nvim: fast file search and grep (replaces snacks picker for files/grep)
if vim.g.vscode then return end

vim.pack.add({
  {
    src = 'https://github.com/dmtrKovalenko/fff.nvim',
    version = vim.version.range('*'),
  },
})

vim.api.nvim_create_autocmd('PackChanged', {
  callback = function(ev)
    local name, kind = ev.data.spec.name, ev.data.kind
    if name == 'fff.nvim' and (kind == 'install' or kind == 'update') then
      if not ev.data.active then vim.cmd.packadd('fff.nvim') end
      require('fff.download').download_or_build_binary()
    end
  end,
})

require('fff').setup({
  prompt = '❯ ',
  keymaps = {
    -- Insert mode up: <C-e> from snacks, <C-p> + <Up> from fff defaults
    move_up = { '<C-e>', '<Up>', '<C-p>' },
  },
})

local map = require('utils').map
local fff = require('fff')

map('n', '<leader>fo', function() fff.find_files() end, { desc = "Find Files" })
map('n', '<leader>fs', function() fff.find_files() end, { desc = "Find Files (smart)" })
map('n', '<leader>/', function() fff.live_grep() end, { desc = "Grep" })
map('n', '<leader>*', function() fff.live_grep({ query = vim.fn.expand('<cword>') }) end,
  { desc = "Grep Word" })
