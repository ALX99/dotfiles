local plugins = {
  ['wbthomason/packer.nvim'] = {}, -- Packer can mange itself

  -- Functionality
  ['junegunn/vim-easy-align'] = {},
  ['alx99/qc.lua'] = {
    config = function()
      require('qc').setup {
        shortcut = "<leader>/"
      }
    end
  },
  ['akinsho/toggleterm.nvim'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.toggleterm') end,
  },

  -- Treesitter is able to generate ASTs for almost all languages
  ['nvim-treesitter/nvim-treesitter'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.treesitter') end,
  },

  -- Colorschemes
  ['navarasu/onedark.nvim'] = {
    disable = true,
    config = function() require('onedark').load() end,
  },
  ['folke/tokyonight.nvim'] = {
    disable = true,
  },
  ['rebelot/kanagawa.nvim'] = {
    disable = vim.g.vscode,
    -- config = function() vim.cmd("colorscheme kanagawa") end,
  },
  ['EdenEast/nightfox.nvim'] = {
    disable = vim.g.vscode,
    config = function()
      require('nightfox').setup({
        options = {
          dim_inactive = true, -- Non focused panes set to alternative background
        }
      })
      vim.cmd("colorscheme nightfox")
    end,
  },

  -- Eyecandy for notifications
  ['rcarriga/nvim-notify'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.notify') end,
  },

  -- Autopairs
  ['windwp/nvim-autopairs'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.autopairs') end,
  },

  -- Snippet engine, configured with cmp
  ['L3MON4D3/LuaSnip'] = {
    disable = vim.g.vscode,
  },

  -- Snippet engine support for cmp, configured with cmp
  ['saadparwaiz1/cmp_luasnip'] = {
    disable = vim.g.vscode,
  },

  -- Autocompletion
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

  -- Tree file manager
  ['kyazdani42/nvim-tree.lua'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.nvimtree') end,
  },

  -- Git gutters and blames
  ['lewis6991/gitsigns.nvim'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.gitsigns') end,
  },

  -- Fuzzy finder that does it all
  ['nvim-telescope/telescope.nvim'] = {
    disable = vim.g.vscode,
    config = function() require('plugins.configs.telescope') end,
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
