local utils = require('alx99.utils')

local nvim_tree = utils.require('nvim-tree')
if not nvim_tree then return end

-- :help nvim-tree-setup
-- :help nvim-tree.OPTION_NAME
nvim_tree.setup {
  view = {
    adaptive_size = true,
  },
}
