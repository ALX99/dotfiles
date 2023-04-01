return {
  {
    "folke/tokyonight.nvim",
    event = "VeryLazy",
    name = "tokyonight",
    enabled = os.getenv("USER") ~= "root",
  },
  {
    "rebelot/kanagawa.nvim",
    event = "VeryLazy",
    config = true,
    enabled = os.getenv("USER") ~= "root",
  },
  {
    "catppuccin/nvim",
    name = "catppuccin",
    event = "VeryLazy",
    enabled = os.getenv("USER") ~= "root",
    opts = {
      flavour = "mocha",
      transparent_background = false,
    },
    config = function(_, opts)
      require('catppuccin').setup(opts)
    end
  },
  {
    "projekt0n/github-nvim-theme",
    version = "0.0.x",
    enabled = os.getenv("USER") ~= "root",
    --     config = function()
    --       require('github-theme').setup()
    --     end
  },
  {
    "EdenEast/nightfox.nvim",
    lazy = false,
    config = function()
      require('nightfox').setup({
        options = {
          dim_inactive = true, -- Non focused panes set to alternative background
        }
      })
      vim.cmd.colorscheme("carbonfox")
    end,
  },
}
