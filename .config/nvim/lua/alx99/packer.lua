-- This file can be loaded by calling `lua require('plugins')` from your init.vim

-- Only required if you have packer configured as `opt`
vim.cmd [[packadd packer.nvim]]

return require('packer').startup(
  function(use)
    use 'wbthomason/packer.nvim' -- Packer can mange itself

    -- Functionality
    use 'junegunn/vim-easy-align'
    use 'numToStr/Comment.nvim'

    if vim.g.vscode then
      return -- The rest of the stuff is not needed for vscode
    end

    -- Colorschemes
    use 'folke/tokyonight.nvim'
    use 'rebelot/kanagawa.nvim'


    -- LSP & IDE features
    use 'windwp/nvim-autopairs'
    use 'neovim/nvim-lspconfig'
    -- Treesitter is able to generate ASTs for almost all languages
    use { "nvim-treesitter/nvim-treesitter", run = ":TSUpdate" }
    use 'hrsh7th/cmp-nvim-lsp'
    use 'hrsh7th/nvim-cmp' -- Better completion menu
    use 'hrsh7th/cmp-buffer' -- Complete from buffer
    use 'hrsh7th/cmp-path' -- Complete from path
    use 'L3MON4D3/LuaSnip' -- Snippet engine
    use 'saadparwaiz1/cmp_luasnip' -- Snippet engine support for autocomplete
    use 'ray-x/lsp_signature.nvim' -- LSP signature popup
    use 'kyazdani42/nvim-tree.lua' -- Tree file manager
    use 'lewis6991/gitsigns.nvim' -- Git gutters and blames
    use 'rcarriga/nvim-notify' -- Eyecandy for notifications
    use {
      "nvim-telescope/telescope.nvim", tag = '0.1.0',
      requires = { { "nvim-lua/plenary.nvim" } }
    }

    -- To check out in future
    -- https://github.com/folke/trouble.nvim
    -- https://github.com/jose-elias-alvarez/null-ls.nvim
    -- https://github.com/junegunn/fzf.vim
    -- https://github.com/L3MON4D3/LuaSnip
    -- https://github.com/folke/twilight.nvim
    -- https://github.com/Pocco81/true-zen.nvim
    -- https://github.com/rcarriga/nvim-notify
    -- https://github.com/glepnir/galaxyline.nvim
    -- use { 'phaazon/hop.nvim', branch = 'v2' }
    -- use "tiagovla/scope.nvim" -- Buffers belong to tabs
  end)
