return {
  {
    "folke/tokyonight.nvim",
    version = '*',
    lazy = false,
    priority = 1000,
    name = "tokyonight",
    opts = {
      dim_inactive = true,
      transparent = "transparent",
      hide_inactive_statusline = true,
      styles = {
        sidebars = "transparent",
        floats = "transparent",
      },
    },
    config = function(_, opts)
      require("tokyonight").setup(opts)
      vim.cmd.colorscheme("tokyonight-moon")
    end,
    cond = function()
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
    enabled = false,
    cond = function()
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
    enabled = false,
    cond = function()
      return not require('core.utils').is_vscodevim()
    end,
    config = function(_, opts)
      -- require('catppuccin').setup(opts)
      -- vim.cmd.colorscheme("catppuccin-mocha")
    end,
  },
  {
    "projekt0n/github-nvim-theme",
    version = "1.x.x",
    event = "VeryLazy",
    enabled = false,
    config = function(_, opts)
      -- require("github-theme").setup(opts)
      -- vim.cmd.colorscheme("github_dark")
    end,
    cond = function()
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
    enabled = false,
    cond = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    'MeanderingProgrammer/render-markdown.nvim',
    version = "*",
    opts = {
      file_types = { "markdown", "Avante" },
    },
    ft = { "markdown", "Avante" },
  },
}
