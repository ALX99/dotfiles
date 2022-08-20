local plugins = {
  ['wbthomason/packer.nvim'] = {}, -- Packer can mange itself


  -- Functionality
  ['junegunn/vim-easy-align'] = {},
  ['numToStr/Comment.nvim'] = {
    config = function() require('plugins.configs.comment') end
  },
  ['akinsho/toggleterm.nvim'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.toggleterm') end,
  },

  -- Treesitter is able to generate ASTs for almost all languages
  ['nvim-treesitter/nvim-treesitter'] = {
    config = function() require('plugins.configs.treesitter') end,
    disable = vim.g.vscode,
  },

  -- Colorschemes
  ['navarasu/onedark.nvim'] = {
    disable = vim.g.vscode,
    config = function() require('onedark').load() end,
  },
  ['rebelot/kanagawa.nvim'] = {
    disable = vim.g.vscode,
  },
  ['folke/tokyonight.nvim'] = {
    disable = vim.g.vscode,
  },

  ['rcarriga/nvim-notify'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.notify') end,
  }, -- Eyecandy for notifications


  -- LSP & IDE features
  ['windwp/nvim-autopairs'] = {
    config = function() require('plugins.configs.autopairs') end,
    disable = vim.g.vscode,
  },

  -- Completion
  ['L3MON4D3/LuaSnip'] = {
    disable = vim.g.vscode,
  }, -- Snippet engine, configured with cmp
  ['saadparwaiz1/cmp_luasnip'] = {
    disable = vim.g.vscode,
  }, -- Snippet engine support for cmp, configured with cmp
  ['hrsh7th/nvim-cmp'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.cmp') end,
    requires = {
      'hrsh7th/cmp-buffer',
      'saadparwaiz1/cmp_luasnip',
      'L3MON4D3/LuaSnip'
    },
  },

  -- LSP setup
  ['neovim/nvim-lspconfig'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.lsp') end,
    requires = { 'hrsh7th/cmp-nvim-lsp', 'ray-x/lsp_signature.nvim' },
  },

  ['kyazdani42/nvim-tree.lua'] = {
    disable = vim.g.vscode,
  }, -- Tree file manager

  ['lewis6991/gitsigns.nvim'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.gitsigns') end,
  }, -- Git gutters and blames

  ['nvim-telescope/telescope.nvim'] = {
    disable = vim.g.vscode,
    tag = '0.1.0',
    requires = 'nvim-lua/plenary.nvim'
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