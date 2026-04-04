if vim.g.vscode then return end
vim.pack.add({
  {
    src = 'https://github.com/mason-org/mason.nvim',
    version = vim.version.range('*')
  },
})

require('mason').setup({})
