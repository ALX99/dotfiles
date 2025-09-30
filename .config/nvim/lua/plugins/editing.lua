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
      return not vim.g.vscode
    end
  },

  -- flash for jumping around the file
  {
    "folke/flash.nvim",
    event = "VeryLazy",
    opts = {
      labels = "arstgmneiofpludh",
      modes = {
        char = { enabled = false },
      },
    },
    config = function(_, cfg)
      vim.api.nvim_set_hl(0, 'FlashLabel', { fg = '#eb6aa3', bg = '#000000', bold = true })
      require("flash").setup(cfg)
      -- FlashBackdrop     Comment      backdrop
      -- FlashMatch        Search       search matches
      -- FlashCurrent      IncSearch    current match
      -- FlashLabel        Substitute   jump label
      -- FlashPrompt       MsgArea      prompt
      -- FlashPromptIcon   Special      prompt icon
      -- FlashCursor       Cursor       cursor
    end,
    keys = {
      {
        "s",
        mode = { "n", "x", "o" },
        function()
          require("flash").jump()
        end,
        desc = "Flash",
      },
      {
        "S",
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
      return not vim.g.vscode
    end
  },
  {
    -- "gh.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    dir = "~/dotfiles/.config/nvim/lua/gh.nvim",
    opts = {},
    cmd = { "GHBrowse", "GHPRs" },
    -- dev = true,
  },
  {
    "windwp/nvim-ts-autotag",
    enabled = false,
    cond = function()
      return not vim.g.vscode
    end,
    opts = {},
    event = { "InsertEnter" },
  },
  {
    dir = "~/dotfiles/.config/nvim/lua/custom_plugins/vscode",
    config = function()
      require("custom_plugins.vscode").setup()
    end,
    cond = function()
      return vim.g.vscode
    end,
  },
}
