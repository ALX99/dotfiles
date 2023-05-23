return {
  {
    "folke/tokyonight.nvim",
    event = "VeryLazy",
    name = "tokyonight",
    opts = {
      transparent = true,
      styles = {
        sidebars = "transparent",
        floats = "transparent",
      }
    },
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "rebelot/kanagawa.nvim",
    lazy = false,
    opts = {
      dimInactive = true,
      transparent = true,
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
    version = "1.x.x",
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
        transparent = true,
      }
    },
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
}
