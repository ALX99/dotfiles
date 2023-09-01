return {
  {
    "echasnovski/mini.nvim",
    dependencies = {
      'nvim-tree/nvim-web-devicons'
    },
    config = function()
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
      require('mini.statusline').setup()

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
        pattern  = { 'markdown', 'lazy' },
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
  },
  {
    "echasnovski/mini.files",
    event = "VeryLazy",
    dependencies = {
      'nvim-tree/nvim-web-devicons'
    },
    opts = {
      mappings = {
        go_in       = 'i',
        go_in_plus  = 'I',
        go_out      = 'm',
        go_out_plus = 'M',
        show_help   = 'g?',
      },
    }
  },
  {
    "echasnovski/mini.clue",
    event = "VeryLazy",
    config = function(_, _)
      local miniclue = require('mini.clue')
      miniclue.setup({
        triggers = {
          -- Leader triggers
          { mode = 'n', keys = '<Leader>' },
          { mode = 'x', keys = '<Leader>' },

          -- Built-in completion
          { mode = 'i', keys = '<C-x>' },

          -- `g` key
          { mode = 'n', keys = 'g' },
          { mode = 'x', keys = 'g' },

          -- Marks
          { mode = 'n', keys = "'" },
          { mode = 'n', keys = '`' },
          { mode = 'x', keys = "'" },
          { mode = 'x', keys = '`' },

          -- Registers
          { mode = 'n', keys = '"' },
          { mode = 'x', keys = '"' },
          { mode = 'i', keys = '<C-r>' },
          { mode = 'c', keys = '<C-r>' },

          -- Window commands
          { mode = 'n', keys = '<C-w>' },

          -- `z` key
          { mode = 'n', keys = 'z' },
          { mode = 'x', keys = 'z' },
        },
        clues = {
          -- Enhance this by adding descriptions for <Leader> mapping groups
          miniclue.gen_clues.builtin_completion(),
          miniclue.gen_clues.g(),
          miniclue.gen_clues.marks(),
          miniclue.gen_clues.registers(),
          miniclue.gen_clues.windows(),
          miniclue.gen_clues.z(),
        },
      })
    end
  },
}
