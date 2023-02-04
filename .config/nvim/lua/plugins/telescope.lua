return {
  "nvim-telescope/telescope.nvim",
  version = '0.1.x',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'nvim-telescope/telescope-ui-select.nvim', -- Code actions for telescope
    { 'nvim-telescope/telescope-fzf-native.nvim', build = 'make' } -- Fuzzy finder
  },
  cmd = "Telescope",
  keys = {
    { "<leader>Pt", ":Telescope<CR>", desc = "Telescope" },
    { "<leader>o", "<cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>" },
    { "<leader>O", "<cmd>Telescope fd find_command=rg,--files,--iglob,!.git<CR>" },
    { "<leader>wo", "<cmd>vsplit<CR><cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>" },
    { "<leader>wO", "<cmd>split<CR><cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>" },
    { "<leader>ff", "<cmd>Telescope current_buffer_fuzzy_find<CR>", desc = "Fuzzy find" },
    { "<leader>fg", "<cmd>Telescope live_grep<CR>", desc = "Grep in files" },
    { "<leader>fA", "<cmd>Telescope lsp_document_symbols<CR>", desc = "Goto symbol" },
    { "<leader>fM", "<cmd>Telescope lsp_document_symbols symbols=method<CR>", desc = "Goto method" },
    { "<leader>fF", "<cmd>Telescope lsp_document_symbols symbols=function<CR>", desc = "Goto function" },
    { "<leader>M", "<cmd>Telescope man_pages<CR>" },
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
      },
      pickers = {
        lsp_references = {
          initial_mode = "normal",
        }
      }
    }

    -- Load telescope plugins
    telescope.load_extension("fzf")
    telescope.load_extension("ui-select")
  end,
}
