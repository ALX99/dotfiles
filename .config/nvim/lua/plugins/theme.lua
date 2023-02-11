return {
  {
    "folke/tokyonight.nvim",
    event = "VeryLazy",
    name = "tokyonight"
  },
  { "catppuccin/nvim",
    name = "catppuccin",
    lazy = false,
    opts = {
      flavour = "mocha",
      transparent_background = false,
    },
    config = function(_, opts)
      require('catppuccin').setup(opts)
      vim.cmd.colorscheme("catppuccin")
    end
  },
  {
    "projekt0n/github-nvim-theme",
    version = "0.0.x",
    --     config = function()
    --       require('github-theme').setup()
    --     end
  },
  {
    "EdenEast/nightfox.nvim",
    event = "VeryLazy",
    config = function()
      require('nightfox').setup({
        options = {
          dim_inactive = true, -- Non focused panes set to alternative background
        }
      })
    end,
  },
}
