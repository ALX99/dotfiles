local telescope = require("telescope")
local builtin = require('telescope.builtin')
local themes = require('telescope.themes')

return {
  "nvim-telescope/telescope.nvim",
  -- version = '^0.1.x',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'nvim-telescope/telescope-ui-select.nvim', -- Code actions for telescope
    'nvim-telescope/telescope-frecency.nvim'
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
    { "<leader>fo", function()
      telescope.extensions.frecency.frecency(themes.get_dropdown({
        previewer = false,
        workspace = 'CWD'
      }
      ))
    end },
    { "<leader>fO", function()
      telescope.extensions.frecency.frecency(themes.get_dropdown({
        previewer = false,
        find_command = { "rg", "--files", "--no-ignore-vcs" }
      }))
    end },
    -- {
    --   "<leader>b",
    --   "<cmd>Telescope current_buffer_fuzzy_find<CR>",
    --   desc = "Fuzzy find"
    -- },
    {
      "<leader>B",
      "<cmd>Telescope buffers<CR>",
      desc = "Fuzzy find"
    },
    {
      "<leader>/",
      "<cmd>Telescope live_grep<CR>",
      desc = "Grep in files"
    },
    { "<leader>/", function()
      builtin.live_grep(
        themes.get_ivy({
          layout_config = {
            height = {
              padding = 0.1,
            },
          },
        })
      )
    end },
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
        path_display = {
          "filename_first",
          -- "shorten",
        },
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
      },
      extensions = {
        frecency = {
          -- This allows frecency to autodelete files that are no longer in the frecency list
          -- without prompting the user to confirm the deletion
          db_safe_mode = false,
        }
      }
    }

    -- Load telescope plugins
    telescope.load_extension("frecency")
    telescope.load_extension("ui-select")
  end,
  cond = function()
    return not require('core.utils').is_vscodevim()
  end
}
