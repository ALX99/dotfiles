return {
  {
    "nvim-mini/mini.nvim",
    version = '*',
    config = function()
      local misc = require('mini.misc')
      misc.setup_restore_cursor()
      -- This breaks when kitty is used and auto updates to the light or dark theme
      -- for some reason
      -- misc.setup_termbg_sync()

      local indentscope_symbol = "│"
      local indentscope_animation = nil
      if vim.g.vscode then
        indentscope_symbol = ""
        indentscope_animation = require('mini.indentscope').gen_animation.none()
      else
        require("mini.notify").setup({})
        require("mini.icons").setup({})
        require('mini.statusline').setup({
          content = {
            active = function()
              local mode, mode_hl = MiniStatusline.section_mode({ trunc_width = 120 })
              local git           = MiniStatusline.section_git({ trunc_width = 40 })
              -- local diff          = MiniStatusline.section_diff({ trunc_width = 75 })
              local diagnostics   = MiniStatusline.section_diagnostics({ trunc_width = 75 })
              local lsp           = MiniStatusline.section_lsp({ trunc_width = 75 })

              -- Copilot/AI status section
              local copilot = ''
              local copilot_hl = 'MiniStatuslineDevinfo'
              local status = require("sidekick.status").get()
              if status then
                local icon = ''
                if status.busy then
                  copilot = icon
                  copilot_hl = 'DiagnosticWarn'
                elseif status.kind == "Error" then
                  copilot = icon
                  copilot_hl = 'DiagnosticError'
                elseif status.kind == "Normal" then
                  copilot = icon
                  copilot_hl = 'Special'
                end
              end

              local filename      = MiniStatusline.section_filename({ trunc_width = 140 })
              local fileinfo      = MiniStatusline.section_fileinfo({ trunc_width = 120 })
              local location      = MiniStatusline.section_location({ trunc_width = 75 })
              local search        = MiniStatusline.section_searchcount({ trunc_width = 75 })

              return MiniStatusline.combine_groups({
                { hl = mode_hl,                  strings = { mode } },
                { hl = copilot_hl,               strings = { copilot } },
                { hl = 'MiniStatuslineDevinfo',  strings = { lsp } },
                '%<',
                { hl = 'MiniStatuslineFilename', strings = { filename } },
                '%=',
                { hl = 'MiniStatuslineFileinfo', strings = { diagnostics, fileinfo } },
                { hl = mode_hl,                  strings = { search, location } },
              })
            end,
          },
        })

        require('mini.diff').setup({
          view = {
            -- style = 'sign',
            signs = { add = '+', change = '~', delete = '-' },
          }
        })

        vim.notify = require('mini.notify').make_notify(
          {
            ERROR = { duration = 5000 },
            WARN  = { duration = 5000 },
            INFO  = { duration = 5000 },
            DEBUG = { duration = 1000 },
            TRACE = { duration = 500 },
          }
        )
      end

      require('mini.indentscope').setup({
        mappings = {
          object_scope = 'o', -- breaks vo mapping
          object_scope_with_border = 'ao',
          goto_top = '[o',
          goto_bottom = ']o',
        },
        draw = {
          -- delay = 100,
          animation = indentscope_animation,
        },
        symbol = indentscope_symbol
      })


      require("mini.ai").setup({
        mappings = {
          -- Main textobject prefixes
          around = 'a',
          inside = 'i',

          -- Next/last textobjects
          around_next = 'an',
          inside_next = 'in',
          around_last = 'al',
          inside_last = 'il',

          -- Move cursor to corresponding edge of `a` textobject
          goto_left = 'g[',
          goto_right = 'g]',
        },
      })

      require('mini.trailspace').setup({})


      require('mini.align').setup({
        mappings = {
          start = '<leader>pa',
          start_with_preview = '<leader>pA'
        },
      })

      -- require('mini.tabline').setup({})
      -- require('mini.cursorword').setup({})
      -- require('mini.pairs').setup({})
      require('mini.hipatterns').setup({
        highlighters = {
          FIXME     = { pattern = 'FIXME', group = 'MiniHipatternsFixme' },
          fixme     = { pattern = 'fixme', group = 'MiniHipatternsFixme' },
          HACK      = { pattern = 'HACK', group = 'MiniHipatternsHack' },
          hack      = { pattern = 'hack', group = 'MiniHipatternsHack' },
          TODO      = { pattern = 'TODO', group = 'MiniHipatternsTodo' },
          todo      = { pattern = 'todo', group = 'MiniHipatternsTodo' },
          NOTE      = { pattern = 'NOTE', group = 'MiniHipatternsNote' },
          note      = { pattern = 'note', group = 'MiniHipatternsNote' },
          hex_color = require('mini.hipatterns').gen_highlighter.hex_color(),
        }
      })

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
    "nvim-mini/mini.files",
    version = '*',
    dependencies = {
      'nvim-mini/mini.nvim'
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
        go_in       = '<Right>',
        go_in_plus  = '<nop>',
        go_out      = '<Left>',
        go_out_plus = '<nop>',
      },
    },
    config = function(_, opts)
      require('mini.files').setup(opts)

      vim.api.nvim_create_autocmd("User", {
        pattern = "MiniFilesActionRename",
        callback = function(event)
          require('snacks').rename.on_rename_file(event.data.from, event.data.to)
        end,
      })
    end,
    cond = function()
      return not vim.g.vscode
    end
  },
  {
    "nvim-mini/mini.clue",
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
    end,
    cond = function()
      return not vim.g.vscode
    end
  },
}
