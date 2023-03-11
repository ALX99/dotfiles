return {
  "echasnovski/mini.nvim",
  version = "^0.7.0",
  config = function()
    require('mini.trailspace').setup({})

    -- require('mini.pairs').setup({})
    require('mini.tabline').setup({ show_icons = false })
    require('mini.cursorword').setup({})
    require('mini.statusline').setup({})
    require('mini.align').setup({
      mappings = {
        start = '<leader>Pa',
        start_with_preview = '<leader>PA'
      },
    })
    require('mini.indentscope').setup({
      mappings = {
        object_scope = 'o',
        object_scope_with_border = 'ao',
      },
    })


    -- disable trailspace on markdown files
    vim.api.nvim_create_autocmd('FileType', {
      pattern  = 'markdown',
      callback = function()
        vim.b.minitrailspace_disable = true
      end,
    })

    vim.api.nvim_create_autocmd('FileType', {
      pattern  = { "NvimTree", "FTerm", "lazy" },
      callback = function()
        vim.b.miniindentscope_disable = true
      end,
    })
  end,
}
