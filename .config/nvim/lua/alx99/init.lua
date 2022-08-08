require('alx99.packer')

require('alx99.set')
require('alx99.plugins.comment')
if (not vim.g.vscode) then
  require('alx99.plugins.notify') -- Notifications
  require('alx99.plugins.autopairs') -- Autopairs
  require('alx99.plugins.treesitter') -- Generate ASTs
  require('alx99.plugins.cmp') -- Completion
  require('alx99.plugins.gitsigns') -- Gitgutter
  require('alx99.plugins.nvimtree') -- Filetree
  require('alx99.plugins.lsp') -- LSP
end
require('alx99.keymap')
require('alx99.autocmds')
