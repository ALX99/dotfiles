local utils = require('core.utils')
local jump2d = utils.require('mini.jump2d')

if not jump2d then return end
utils.require('mini.tabline').setup({})
utils.require('mini.trailspace').setup({})
utils.require('mini.pairs').setup({})
utils.require('mini.cursorword').setup({})
utils.require('mini.statusline').setup({})
utils.require('mini.align').setup({})
utils.require('mini.indentscope').setup({
  mappings = {
    object_scope = 's',
    object_scope_with_border = 'as',
  },
})
jump2d.setup({
  allowed_windows = {
    not_current = false,
  },

  mappings = {
    start_jumping = '',
  },
})
local function jumpChar()
  jump2d.start(jump2d.builtin_opts.single_character)
end

utils.map("n", ',', jumpChar, { noremap = true, silent = true })
