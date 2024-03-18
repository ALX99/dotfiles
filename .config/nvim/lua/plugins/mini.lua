return {
  {
    "echasnovski/mini.nvim",
    version = '*',
    dependencies = {
      'nvim-tree/nvim-web-devicons'
    },
    config = function()
      require("mini.notify").setup({})
      vim.notify = require('mini.notify').make_notify(
        {
          ERROR = { duration = 5000 },
          WARN  = { duration = 5000 },
          INFO  = { duration = 5000 },
          DEBUG = { duration = 1000 },
          TRACE = { duration = 500 },
        }
      )
      require('mini.statusline').setup({})

      require('mini.indentscope').setup({
        mappings = {
          object_scope = 'o',
          object_scope_with_border = 'ao',
          goto_top = '[o',
          goto_bottom = ']o',
        },
        -- draw = {
        --   delay = 100,
        --   animation = require('mini.indentscope').gen_animation.none(),
        -- },
        symbol = "│"
      })

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


      require('mini.align').setup({
        mappings = {
          start = '<leader>pa',
          start_with_preview = '<leader>pA'
        },
      })


      -- require('mini.tabline').setup({})
      -- require('mini.cursorword').setup({})
      require('mini.trailspace').setup({})
      -- require('mini.pairs').setup({})

      -- disable trailspace on markdown files
      vim.api.nvim_create_autocmd('FileType', {
        pattern  = { 'markdown', 'lazy', 'chatgpt-input' },
        callback = function()
          vim.b.minitrailspace_disable = true
        end,
      })

      vim.api.nvim_create_autocmd('FileType', {
        pattern  = { 'NvimTree', 'FTerm', 'lazy', 'chatgpt-input', 'help', 'man' },
        callback = function()
          vim.b.miniindentscope_disable = true
        end,
      })
    end,
  },
  {
    "echasnovski/mini.files",
    version = '*',
    dependencies = {
      'nvim-tree/nvim-web-devicons'
    },
    keys = {
      {
        "<leader>ft",
        ":lua MiniFiles.open(vim.api.nvim_buf_get_name(0))<CR>",
        mode = { "n", "x", "o" },
        desc = "MiniFiles"
      },
    },
    opts = {
      mappings = {
        go_in       = 'I',
        go_in_plus  = 'i',
        go_out      = 'm',
        go_out_plus = 'M',
        show_help   = 'g?',
      },
    }
  },
  {
    "echasnovski/mini.clue",
    version = '*',
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
