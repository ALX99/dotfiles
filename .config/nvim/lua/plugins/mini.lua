return {
  "echasnovski/mini.nvim",
  dependencies = {
    'nvim-tree/nvim-web-devicons'
  },
  config = function()
    require('mini.files').setup({
      mappings = {
        go_in       = 'i',
        go_in_plus  = 'I',
        go_out      = 'm',
        go_out_plus = 'M',
        show_help   = 'g?',
      },
    })
    require('core.utils').map({ "n", "x", "o" }, "<leader>ft", ":lua MiniFiles.open()<CR>", { desc = "MiniFiles" })

    require('mini.trailspace').setup({})
    -- require('mini.tabline').setup({ show_icons = false })
    -- require('mini.cursorword').setup({})
    require('mini.comment').setup({
      options = {
        ignore_blank_line = true,
      },
      mappings = {
        comment = 'gc',
        comment_line = 'gcc',
        textobject = 'gc',
      },
    })
    require('mini.statusline').setup({
      use_icons = false,
    })

    require('mini.pairs').setup({})
    require('mini.align').setup({
      mappings = {
        start = '<leader>pa',
        start_with_preview = '<leader>pA'
      },
    })

    require('mini.indentscope').setup({
      mappings = {
        object_scope = 'o',
        object_scope_with_border = 'ao',
        goto_top = '[o',
        goto_bottom = ']o',
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
      pattern  = { 'NvimTree', 'FTerm', 'lazy' },
      callback = function()
        vim.b.miniindentscope_disable = true
      end,
    })
  end,
}
