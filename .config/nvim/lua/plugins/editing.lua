return {
  -- harpoon for navigating between files
  {
    "ThePrimeagen/harpoon",
    keys = {
      { "<leader>1", "<cmd>lua require('harpoon.ui').nav_file(1)<cr>",         desc = "Harpoon 1" },
      { "<leader>2", "<cmd>lua require('harpoon.ui').nav_file(2)<cr>",         desc = "Harpoon 2" },
      { "<leader>3", "<cmd>lua require('harpoon.ui').nav_file(3)<cr>",         desc = "Harpoon 3" },
      { "<leader>4", "<cmd>lua require('harpoon.ui').nav_file(4)<cr>",         desc = "Harpoon 4" },
      { "<leader>h", "<cmd>lua require('harpoon.mark').add_file()<cr>",        desc = "Harpoon add file" },
      { "<leader>H", "<cmd>lua require('harpoon.ui').toggle_quick_menu()<cr>", desc = "Harpoon UI" },
    },
    dependencies = {
      'nvim-lua/plenary.nvim',
    },
    cond = function()
      return not require('core.utils').is_vscodevim()
    end
  },

  -- flash for jumping around the file
  {
    "folke/flash.nvim",
    event = "VeryLazy",
    opts = {
      modes = {
        search = { enabled = false },
        char = { enabled = false },
      }
    },
    keys = {
      {
        "<leader>s",
        mode = { "n", "x", "o" },
        function()
          require("flash").jump()
        end,
        desc = "Flash",
      },
      {
        "<leader>S",
        mode = { "n", "x", "o" },
        function()
          require("flash").treesitter()
        end,
        desc = "Flash Treesitter",
      },
      {
        "r",
        mode = "o",
        function()
          require("flash").remote()
        end,
        desc = "Remote Flash",
      },
      {
        "R",
        mode = { "o", "x" },
        function()
          require("flash").treesitter_search()
        end,
        desc = "Flash Treesitter Search",
      },
      {
        "<a-s>",
        mode = { "c" },
        function()
          require("flash").toggle()
        end,
        desc = "Toggle Flash Search",
      },
    },
  },
  {
    "abecodes/tabout.nvim",
    event = { "BufReadPost", "BufNewFile" },
    dependencies = { "nvim-treesitter/nvim-treesitter" },
    config = true,
    enabled = false,
    cond = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "github/copilot.vim",
    event = { "VeryLazy" },
    config = function()
      -- vim.g.copilot_assume_mapped = true
      vim.g.copilot_no_tab_map = true

      local map = require('core.utils').map
      map(
        "i",
        "<A-CR>",

        'copilot#Accept("<CR>")',
        {
          silent = true,
          expr = true,
          script = true,
          replace_keycodes = false,
          desc = "Accept copilot suggestion"
        }
      )

      map({ "i", "n" }, "<A-p>", '<Esc>:Copilot panel<CR>', { desc = "Open copilot panel" })
      map("i", "<C-n>", "<Plug>(copilot-next)", { desc = "Next copilot suggestion" })
      map("i", "<C-e>", "<Plug>(copilot-previous)", { desc = "Previous copilot suggestion" })
      -- keymap("i", "<C-o>", "<Plug>(copilot-dismiss)")
      -- keymap("i", "<C-s>", "<Plug>(copilot-suggest)")
    end
  }
}
