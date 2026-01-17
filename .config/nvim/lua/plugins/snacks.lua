return {
  {
    "folke/snacks.nvim",
    version = '*',
    priority = 1000, -- according to :checkhealth
    lazy = false,    -- according to :checkhealth

    opts = {
      bigfile = {},
      input = {},
      picker = {
        sources = {
          -- keep smart/recent results scoped to the current root
          smart = { filter = { cwd = true } },
          recent = { filter = { cwd = true } },

          files = { exclude = { "**/vendor/**" }, },
          grep = { exclude = { "**/vendor/**" }, },
        },
        formatters = {
          file = {
            -- filename_first = true, -- display filename before the file path
          },
        },
        win = {
          input = {
            keys = {
              -- Colemak: n=down, e=up (disable j/k defaults)
              ["j"] = false,
              ["k"] = false,
              ["<C-n>"] = { "list_down", mode = { "i", "n" } },
              ["<C-e>"] = { "list_up", mode = { "i", "n" } },
              ["n"] = { "list_down", mode = { "n" } },
              ["e"] = { "list_up", mode = { "n" } },
            },
          },
          list = {
            keys = {
              -- Colemak: n=down, e=up (disable j/k defaults)
              ["j"] = false,
              ["k"] = false,
              ["n"] = "list_down",
              ["e"] = "list_up",
            },
          },
          preview = {
            minimal = true,
          },
        },
      },
      -- scroll = {},
      statuscolumn = {
        enabled = false,
      },
      -- todo enable when it does not have a
      -- bug when referencing something bigger
      -- to something smaller on the same line
      -- words = {  }
    },
    keys = {
      {
        "<leader>fo",
        function()
          Snacks.picker.files({ hidden = true })
        end,
        desc = "Find Files"
      },
      {
        "<leader>fO",
        function()
          Snacks.picker.files({ hidden = true, ignored = true })
        end,
        desc = "Find Hidden and Ignored Files"
      },
      {
        "<leader>fs",
        function()
          Snacks.picker.smart({})
        end,
        desc = "Smart Picker"
      },
      {
        "<leader>ob",
        function()
          Snacks.picker.buffers({})
        end,
        desc = "Buffers"
      },
      {
        "<leader>oC",
        function()
          Snacks.picker.colorschemes({})
        end,
        desc = "Colorschemes"
      },
      {
        "<leader>oc",
        function()
          Snacks.picker.commands({})
        end,
        desc = "Commands"
      },
      {
        "<leader>od",
        function()
          Snacks.picker.diagnostics({})
        end,
        desc = "Diagnostics"
      },
      {
        "<leader>oD",
        function()
          Snacks.picker.diagnostics_buffer({})
        end,
        desc = "Buffer Diagnostics"
      },
      {
        "<leader>ol",
        function()
          Snacks.picker.git_log({})
        end,
        desc = "Git Log"
      },
      {
        "<leader>oL",
        function()
          Snacks.picker.git_log_file({})
        end,
        desc = "Git Log for Current File"
      },
      {
        "<leader>/",
        function()
          Snacks.picker.grep({ hidden = true })
        end,
        desc = "Grep"
      },
      {
        "<leader>*",
        function()
          Snacks.picker.grep_word({ hidden = true })
        end,
        desc = "Grep Word"
      },
      {
        "<leader>oh",
        function()
          Snacks.picker.help({})
        end,
        desc = "Help Pages"
      },
      {
        "<leader><leader>/",
        function()
          Snacks.picker.lines({})
        end,
        desc = "Buffer Lines"
      },
      {
        "<leader>oq",
        function()
          Snacks.picker.qflist({})
        end,
        desc = "Quickfix List"
      },
      {
        "<leader>oS",
        function()
          Snacks.picker.spelling({})
        end,
        desc = "Spelling"
      },
      {
        "<leader>ou",
        function()
          Snacks.picker.undo({})
        end,
        desc = "Undo History"
      },
    },
    cond = function()
      return not vim.g.vscode
    end
  },
}
