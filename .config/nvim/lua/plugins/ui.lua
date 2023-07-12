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
        ["<leader>g"] = { name = "+git" },
        ["<leader>w"] = { name = "+windows" },
      })
    end,
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },

  -- gitsigns for git gutter
  {
    "lewis6991/gitsigns.nvim",
    event = "VeryLazy",
    config = function()
      local map = require('core.utils').map

      local gitsigns = require('gitsigns')

      -- :h gitsigns.setup
      gitsigns.setup {
        on_attach = function(_)
          local gs = package.loaded.gitsigns
          map({ 'n', 'v' }, '<leader>gs', ':Gitsigns stage_hunk<CR>', { desc = "Stage hunk" })
          map('n', '<leader>gS', gs.stage_buffer, { desc = "Stage file" })
          map('n', '<leader>gU', gs.reset_buffer_index, { desc = "Unstage file" })
          map('n', '<leader>gu', gs.undo_stage_hunk, { desc = "Undo stage hunk" })
          map({ 'n', 'v' }, '<leader>gr', ':Gitsigns reset_hunk<CR>', { desc = "Reset hunk" })
          map('n', '<leader>gR', gs.reset_buffer, { desc = "Reset file" })
          map('n', '<leader>gP', gs.preview_hunk, { desc = "Preview hunk" })
          map('n', '<leader>gb', function() gs.blame_line({ full = true }) end, { desc = "Blame line" })
          map('n', '<leader>gB', gs.toggle_current_line_blame, { desc = "Toggle line blame" })
          map('n', '<leader>gd', gs.diffthis, { desc = "Diff against index" })
          map('n', '<leader>gD', function() gs.diffthis("~1") end, { desc = "Diff against ~1" })
          map('n', '<leader>gx', gs.toggle_deleted, { desc = "Toggle deleted lines" })
        end
      }
    end,
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },

  -- markdown-preview for markdown previews
  {
    "iamcco/markdown-preview.nvim",
    cmd = { "MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle" },
    build = "cd app && yarn install",
    enabled = function()
      return not require('core.utils').is_vscodevim()
          or vim.fn.executable("yarn") == 1
    end
  },

  -- alternative https://github.com/ecthelionvi/NeoColumn.nvim
  -- smartcolumn for automatically showing/hiding the smartcolumn
  {
    "m4xshen/smartcolumn.nvim",
    event = "VeryLazy",
    opts = {
      disabled_filetypes = { "help", "text", "NvimTree", "lazy" },
      colorcolumn = "100",
    },
    enabled = function()
      return false
      -- return not require('core.utils').is_vscodevim()
    end
  },
}
