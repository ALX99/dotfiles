return {
  {
    -- which-key for remembering keybindings
    "folke/which-key.nvim",
    event = "VeryLazy",
    config = function()
      local wk = require("which-key")

      vim.o.timeout = true
      vim.o.timeoutlen = 1000
      wk.register({
        mode = { "n", "v" },
        ["<leader>f"] = { name = "+file(s)" },
        ["<leader>g"] = { name = "+git" },
        ["<leader>w"] = { name = "+windows" },
      })
    end,
  },

  -- gitsigns for git gutter
  {
    "lewis6991/gitsigns.nvim",
    config = function()
      local utils = require('core.utils')

      local gitsigns = require('gitsigns')

      -- :h gitsigns.setup
      gitsigns.setup {
        on_attach = function(_)
          local gs = package.loaded.gitsigns
          utils.map({ 'n', 'v' }, '<leader>gs', ':Gitsigns stage_hunk<CR>', { desc = "Stage hunk" })
          utils.map('n', '<leader>gS', gs.stage_buffer, { desc = "Stage file" })
          utils.map('n', '<leader>gU', gs.reset_buffer_index, { desc = "Unstage file" })
          utils.map('n', '<leader>gu', gs.undo_stage_hunk, { desc = "Undo stage hunk" })
          utils.map({ 'n', 'v' }, '<leader>gr', ':Gitsigns reset_hunk<CR>', { desc = "Reset hunk" })
          utils.map('n', '<leader>gR', gs.reset_buffer, { desc = "Reset file" })
          utils.map('n', '<leader>gP', gs.preview_hunk, { desc = "Preview hunk" })
          utils.map('n', '<leader>gb', function() gs.blame_line({ full = true }) end, { desc = "Blame line" })
          utils.map('n', '<leader>gB', gs.toggle_current_line_blame, { desc = "Toggle line blame" })
          utils.map('n', '<leader>gd', gs.diffthis, { desc = "Diff against index" })
          utils.map('n', '<leader>gD', function() gs.diffthis("~1") end, { desc = "Diff against ~1" })
          utils.map('n', '<leader>gx', gs.toggle_deleted, { desc = "Toggle deleted lines" })
        end
      }
    end,
  },

  -- nvim-tree for a file tree
  {
    "kyazdani42/nvim-tree.lua",
    keys = {
      { "<leader>ft", "<cmd>NvimTreeFindFile<CR>", desc = "Open filetree" },
    },
    opts = {
      -- :help nvim-tree-setup
      -- :help nvim-tree.OPTION_NAME
      open_on_setup = false,
      remove_keymaps = true,
      view = {
        width = {
          min = "10%",
          max = "40%"
        },
        mappings = {
          custom_only = true,
          list = {
            { key = "<CR>",  action = "edit" },
            { key = ">",     action = "prev_sibling" },
            { key = "<",     action = "next_sibling" },
            { key = "<BS>",  action = "close_node" },
            { key = "<Tab>", action = "preview" },
            { key = "C",     action = "toggle_git_clean" },
            { key = "I",     action = "toggle_git_ignored" },
            { key = ".",     action = "toggle_dotfiles" },
            { key = "R",     action = "refresh" },
            { key = "E",     action = "expand_all" },
            { key = "a",     action = "create" },
            { key = "d",     action = "remove" },
            { key = "r",     action = "rename" },
            { key = "x",     action = "cut" },
            { key = "c",     action = "copy" },
            { key = "p",     action = "paste" },
            { key = "q",     action = "close" },
            { key = "?",     action = "toggle_help" },
          },
        },
      },
      diagnostics = {
        enable = true,
        show_on_dirs = true,
      },
    }
  },

  -- markdown-previwe for markdown previews
  {
    "iamcco/markdown-preview.nvim",
    cmd = { "MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle" },
    enabled = vim.fn.executable("yarn") == 1,
    build = "cd app && yarn install",
  },

}
