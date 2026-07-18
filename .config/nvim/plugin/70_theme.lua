if vim.g.vscode then return end

require('kanagawa').setup({})
vim.cmd.colorscheme('kanagawa')
require('markview').setup({})
