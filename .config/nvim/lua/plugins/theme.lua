return {
  {
    "folke/tokyonight.nvim",
    lazy = false,
    name = "tokyonight",
    config = function(_, opts)
      require("tokyonight").setup(opts)
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
        dim_inactive = true,
      }
    },
    enabled = function()
      return false
      -- return not require('core.utils').is_vscodevim()
    end
  },
}
