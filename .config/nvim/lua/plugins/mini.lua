return {
  "echasnovski/mini.nvim",
  config = function()
    require('mini.trailspace').setup({})

    -- require('mini.pairs').setup({})
    require('mini.tabline').setup({})
    require('mini.cursorword').setup({})
    require('mini.statusline').setup({})
    require('mini.align').setup({})
    require('mini.indentscope').setup({
      mappings = {
        object_scope = 'o',
        object_scope_with_border = 'ao',
      },
    })
  end,
}
