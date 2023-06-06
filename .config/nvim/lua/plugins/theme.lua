return {
  {
    "folke/tokyonight.nvim",
    lazy = false,
    name = "tokyonight",
    opts = {
      transparent = true,
      styles = {
        sidebars = "transparent",
        floats = "transparent",
      }
    },
    config = function(_, opts)
      require('tokyonight').setup(opts)
      vim.cmd.colorscheme("tokyonight-moon")
    end,
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "rebelot/kanagawa.nvim",
    event = "VeryLazy",
    opts = {
      dimInactive = true,
      transparent = true,
    },
    config = function(_, opts)
      require('kanagawa').setup(opts)
      -- vim.cmd.colorscheme("kanagawa-dragon")
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
