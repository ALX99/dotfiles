-- themes + markdown preview (kanagawa, tokyonight, markview)
vim.pack.add({
  'https://github.com/rebelot/kanagawa.nvim',
  'https://github.com/folke/tokyonight.nvim',
  {
    src = 'https://github.com/OXY2DEV/markview.nvim',
    version = vim.version.range('*'),
  },
})

require('kanagawa').setup({})
require('tokyonight').setup({})
vim.cmd.colorscheme('kanagawa')
require('markview').setup({})
