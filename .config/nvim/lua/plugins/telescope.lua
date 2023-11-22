return {
  "nvim-telescope/telescope.nvim",
  version = '^0.1.x',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'nvim-telescope/telescope-ui-select.nvim', -- Code actions for telescope
    -- Fuzzy finder
    {
      'nvim-telescope/telescope-fzf-native.nvim',
      build = 'make'
    }
  },
  cmd = "Telescope",
  keys = {
    {
      "<leader>pt",
      ":Telescope<CR>",
      desc = "Telescope"
    },
    {
      "<leader>?",
      ":Telescope<CR>",
      desc = "Telescope"
    },
    { "<leader>fo", "<cmd>Telescope fd find_command=rg,--files,--hidden<CR>" },
    { "<leader>fO", "<cmd>Telescope fd find_command=rg,--files,<CR>" },
    -- {
    --   "<leader>b",
    --   "<cmd>Telescope current_buffer_fuzzy_find<CR>",
    --   desc = "Fuzzy find"
    -- },
    {
      "<leader>b",
      "<cmd>Telescope buffers<CR>",
      desc = "Fuzzy find"
    },
    {
      "<leader>/",
      "<cmd>Telescope live_grep<CR>",
      desc = "Grep in files"
    },
    {
      "<leader>d",
      "<cmd>Telescope diagnostics<CR>",
      desc = "Diagnostics"
    },
  },
  config = function()
    local telescope = require('telescope')
    local actions = require('telescope.actions')
    --     local pickers = require('telescope.pickers')
    --     local conf = require('telescope.config').values
    --     local previewers = require('telescope.previewers')
    --     local finders = require('telescope.finders')

    telescope.setup {
      defaults = {
        mappings = {
          n = {
            ["n"] = actions.move_selection_next,
            ["j"] = false,
            ["e"] = actions.move_selection_previous,
            ["k"] = false,
            ["<C-t>"] = false,
            ["t"] = actions.select_tab,
            ["<C-v>"] = false,
            ["v"] = actions.select_vertical,
            ["<C-x>"] = false,
            ["s"] = actions.select_horizontal,
            ["q"] = "close", -- This ruins macros in the telescope windows but why would I want that
          },
          i = {
            ["<M-v>"] = actions.select_vertical,
            ["<M-s>"] = actions.select_horizontal,
            ["<M-t>"] = actions.select_tab,
          },
        },
        vimgrep_arguments = {
          "rg",
          "--hidden",
          "--iglob",
          "!.git",
          "--color=never",
          "--no-heading",
          "--with-filename",
          "--line-number",
          "--column",
          "--smart-case"
        }
      },
      pickers = {
        lsp_references = {
          initial_mode = "normal",
        },
        lsp_implementations = {
          initial_mode = "normal",
        },
        colorscheme = {
          enable_preview = true
        }
      }
    }

    -- Load telescope plugins
    telescope.load_extension("fzf")
    telescope.load_extension("ui-select")
  end,
  cond = function()
    return not require('core.utils').is_vscodevim()
  end
}
