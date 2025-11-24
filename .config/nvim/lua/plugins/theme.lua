return {
  {
    "folke/tokyonight.nvim",
    version = '*',
    lazy = true,
    priority = 1000,
    name = "tokyonight",
    opts = {
      dim_inactive = true,
      hide_inactive_statusline = true,
      transparent = true,
      styles = {
        sidebars = "transparent",
        floats = "transparent",
      },
    },
    config = function(_, opts)
      require("tokyonight").setup(opts)
      -- vim.cmd.colorscheme("tokyonight-moon")
    end,
    enabled = false,
    cond = function()
      return not vim.g.vscode
    end
  },
  {
    "rebelot/kanagawa.nvim",
    event = "VeryLazy",
    opts = {
      -- dimInactive = true,
      -- transparent = true,
    },
    config = function(_, opts)
      require('kanagawa').setup(opts)
      vim.cmd.colorscheme("kanagawa")
    end,
    cond = function()
      return not vim.g.vscode
    end
  },
  {
    "catppuccin/nvim",
    name = "catppuccin",
    version = '*',
    opts = {
      flavour = "mocha",
      transparent_background = true,
    },
    -- enabled = false,
    cond = function()
      return not vim.g.vscode
    end,
    enabled = false,
    config = function(_, opts)
      require('catppuccin').setup(opts)
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
      return not vim.g.vscode
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
      return not vim.g.vscode
    end
  },
  {
    'OXY2DEV/markview.nvim',
    version = "*",
    opts = {
    },
    ft = { "markdown", "Avante", "yaml" },
    cond = function()
      return not vim.g.vscode
    end,
  },
}
