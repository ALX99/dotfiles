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
    lazy = false,
    opts = {
      dimInactive = true,
    },
    config = function(_, opts)
      require('kanagawa').setup(opts)
      vim.cmd.colorscheme("kanagawa-dragon")
    end,
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
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "projekt0n/github-nvim-theme",
    version = "0.0.x",
    event = "VeryLazy",
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "EdenEast/nightfox.nvim",
    event = "VeryLazy",
    opts = {
      options = {
        dim_inactive = true, -- Non focused panes set to alternative background
      }
    },
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
}
