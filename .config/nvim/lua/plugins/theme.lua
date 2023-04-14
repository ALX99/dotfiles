return {
  {
    "folke/tokyonight.nvim",
    event = "VeryLazy",
    name = "tokyonight",
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "rebelot/kanagawa.nvim",
    event = "VeryLazy",
    config = true,
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "catppuccin/nvim",
    name = "catppuccin",
    event = "VeryLazy",
    opts = {
      flavour = "mocha",
      transparent_background = false,
    },
    config = function(_, opts)
      require('catppuccin').setup(opts)
    end,
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "projekt0n/github-nvim-theme",
    version = "0.0.x",
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
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
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
}
