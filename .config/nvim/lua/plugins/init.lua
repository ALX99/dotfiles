local plugins = {
  ['wbthomason/packer.nvim'] = {}, -- Packer can mange itself

  -- Functionality
  ['ggandor/leap.nvim'] = {},
  ['alx99/qc.lua'] = {
    config = function()
      require('qc').setup {
        shortcut = "<leader>/"
      }
    end
  },
  ['alx99/tidy.nvim'] = {
    config = function()
      require("tidy").setup({
        filetype_exclude = { "markdown", "diff" },
      })
    end
  },

  ['akinsho/toggleterm.nvim'] = {
    config = function() require('plugins.configs.toggleterm') end,
  },

  -- Treesitter is able to generate ASTs for almost all languages
  ['nvim-treesitter/nvim-treesitter'] = {
    config = function() require('plugins.configs.treesitter') end,
    requires = {
      'nvim-treesitter/playground'
    }
  },

  -- Colorschemes
  ['navarasu/onedark.nvim'] = {
    disable = true,
    config = function() require('onedark').load() end,
  },
  ['folke/tokyonight.nvim'] = {
    disable = false,
  },
  ['rebelot/kanagawa.nvim'] = {
    disable = false,
    -- config = function() vim.cmd("colorscheme kanagawa") end,
  },
  ['EdenEast/nightfox.nvim'] = {
    config = function()
      require('nightfox').setup({
        options = {
          dim_inactive = true, -- Non focused panes set to alternative background
        }
      })
      vim.cmd("colorscheme carbonfox")
    end,
  },

  -- Eyecandy for notifications
  ['rcarriga/nvim-notify'] = {
    disable = true,
    config = function() require('plugins.configs.notify') end,
  },

  -- Autopairs
  ['windwp/nvim-autopairs'] = {
    disable = true,
    config = function() require('plugins.configs.autopairs') end,
  },

  -- Snippet engine, configured with cmp
  ['L3MON4D3/LuaSnip'] = {},

  -- Snippet engine support for cmp, configured with cmp
  ['saadparwaiz1/cmp_luasnip'] = {},

  -- Autocompletion
  ['hrsh7th/nvim-cmp'] = {
    config = function() require('plugins.configs.cmp') end,
    requires = {
      'hrsh7th/cmp-buffer',
      'saadparwaiz1/cmp_luasnip',
      'L3MON4D3/LuaSnip'
    },
  },

  -- LSP setup
  ['neovim/nvim-lspconfig'] = {
    config = function() require('plugins.configs.lsp') end,
    requires = { 'hrsh7th/cmp-nvim-lsp' },
  },

  ['simrat39/symbols-outline.nvim'] = {
    disable = true,
    config = function() require('symbols-outline').setup({
        auto_close = true
      })
    end,
  },


  -- Tree file manager
  ['kyazdani42/nvim-tree.lua'] = {
    config = function() require('plugins.configs.nvimtree') end,
  },

  -- Git gutters and blames
  ['lewis6991/gitsigns.nvim'] = {
    config = function() require('plugins.configs.gitsigns') end,
  },

  -- Fuzzy finder that does it all
  ['nvim-telescope/telescope.nvim'] = {
    config = function() require('plugins.configs.telescope') end,
    tag = '0.1.0',
    requires = 'nvim-lua/plenary.nvim'
  },

  -- Code actions for telescope
  ['nvim-telescope/telescope-ui-select.nvim'] = {
    requires = 'nvim-telescope/telescope.nvim'
  },

  -- Utilities
  ['echasnovski/mini.nvim'] = {
    config = function() require('plugins.configs.mini') end,
  },
}

local status_ok, packer = pcall(require, "packer")
if status_ok then
  packer.startup {
    function(use)
      for key, plugin in pairs(plugins) do
        if type(key) == "string" and not plugin[1] then plugin[1] = key end
        use(plugin)
      end
    end,
    config = {
      git = {
        clone_timeout = 300,
        subcommands = {
          update = "pull --rebase",
        },
      },
    },
  }
end
