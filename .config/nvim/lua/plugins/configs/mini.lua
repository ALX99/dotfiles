local utils = require('core.utils')
local trailspace = utils.require('mini.trailspace')

if not trailspace then return end
trailspace.setup({})
utils.require('mini.tabline').setup({})
-- utils.require('mini.pairs').setup({})
utils.require('mini.cursorword').setup({})
utils.require('mini.statusline').setup({})
utils.require('mini.align').setup({})
utils.require('mini.indentscope').setup({
  mappings = {
    object_scope = 'o',
    object_scope_with_border = 'ao',
  },
})
