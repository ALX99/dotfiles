local plugins = {
  ['wbthomason/packer.nvim'] = {}, -- Packer can manage itself

  -- Functionality
  ['ggandor/leap.nvim'] = {
    commit = 'c19e974cfd9d52dc5070ec7b68183da39702c877'
  },
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
    commit = '3ba683827c623affb4d9aa518e97b34db2623093'
  },

  -- Treesitter is able to generate ASTs for almost all languages
  ['nvim-treesitter/nvim-treesitter'] = {
    config = function() require('plugins.configs.treesitter') end,
    requires = {
      'nvim-treesitter/playground'
    }
  },

  -- Colorschemes
  ['folke/tokyonight.nvim'] = {
    commit = 'ec144d94a8dbd9c8b4f5e50d933d67a37f589ed8'
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
    commit = 'e70c3edabf30c671230371ff941df63ef82ee441'
  },
  --   ['navarasu/onedark.nvim'] = {
  --     disable = true,
  --     config = function() require('onedark').load() end,
  --     commit = 'cad3d983e57f467ba8e8252b0567e96dde9a8f0d'
  --   },
  --   ['rebelot/kanagawa.nvim'] = {
  --     disable = true,
  --     config = function() vim.cmd("colorscheme kanagawa") end,
  --     commit = '52cfa270317121672c1416c725361fa653684de0'
  --   },

  -- Eyecandy for notifications
  --   ['rcarriga/nvim-notify'] = {
  --     disable = true,
  --     config = function() require('plugins.configs.notify') end,
  --   },

  -- Autopairs
  --   ['windwp/nvim-autopairs'] = {
  --     disable = true,
  --     config = function() require('plugins.configs.autopairs') end,
  --   },

  -- Snippet engine, configured with cmp
  ['L3MON4D3/LuaSnip'] = {
    commit = '619796e2477f7233e5fdff456240676a08482684'
  },

  -- Snippet engine support for cmp, configured with cmp
  ['saadparwaiz1/cmp_luasnip'] = {
    commmit = '18095520391186d634a0045dacaa346291096566'
  },

  -- Autocompletion
  ['hrsh7th/nvim-cmp'] = {
    config = function() require('plugins.configs.cmp') end,
    requires = {
      { 'hrsh7th/cmp-buffer', commit = '3022dbc9166796b644a841a02de8dd1cc1d311fa' },
      { 'saadparwaiz1/cmp_luasnip', commit = '18095520391186d634a0045dacaa346291096566' },
      { 'L3MON4D3/LuaSnip', commit = '619796e2477f7233e5fdff456240676a08482684' },
      { 'alx99/lspkind.nvim' }
    },
    commmit = 'c53dd36adcf512611fa7c523fced55447bfdbfa5'
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
    commit = 'e204a7d819a9a065d5b1cdc6f59d2d2777d14a0f'
  },

  -- Git gutters and blames
  ['lewis6991/gitsigns.nvim'] = {
    config = function() require('plugins.configs.gitsigns') end,
    commit = '9ff7dfb051e5104088ff80556203634fc8f8546d'
  },

  -- Fuzzy finder that does it all
  ['nvim-telescope/telescope.nvim'] = {
    config = function() require('plugins.configs.telescope') end,
    tag = '0.1.0',
    requires = { 'nvim-lua/plenary.nvim', commit = '4b7e52044bbb84242158d977a50c4cbcd85070c7' }
  },

  -- Code actions for telescope
  ['nvim-telescope/telescope-ui-select.nvim'] = {
    commit = '62ea5e58c7bbe191297b983a9e7e89420f581369'
  },

  -- Utilities
  ['echasnovski/mini.nvim'] = {
    config = function() require('plugins.configs.mini') end,
    commit = '9061584513afd62ad6a08757b0aacf5d656bdf36'
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
