-- This file can be loaded by calling `lua require('plugins')` from your init.vim

-- Only required if you have packer configured as `opt`
vim.cmd [[packadd packer.nvim]]

return require("packer").startup(
    function(use)
        use "wbthomason/packer.nvim" -- Packer can mange itself

        -- Functionality
        use "junegunn/vim-easy-align"
        use({
            "numToStr/Comment.nvim",
            config = function()
                require("Comment").setup()
            end
        })

        if vim.g.vscode then
            return -- The rest of the stuff is not needed for vscode
        end

        -- Colorschemes
        use "folke/tokyonight.nvim"
        use "gryf/wombat256grf"

        -- LSP & IDE features
        use "neovim/nvim-lspconfig"
        use { "nvim-treesitter/nvim-treesitter", run = ":TSUpdate" }
        use "hrsh7th/cmp-nvim-lsp"
        use "hrsh7th/nvim-cmp"
        use "hrsh7th/cmp-buffer"
        use "hrsh7th/cmp-path"
        use "hrsh7th/cmp-vsnip"
        use "hrsh7th/vim-vsnip"
        use "ray-x/lsp_signature.nvim"
        use "kyazdani42/nvim-tree.lua"
        use "lewis6991/gitsigns.nvim"

        -- To check out in future
        -- https://github.com/folke/trouble.nvim
        -- https://github.com/jose-elias-alvarez/null-ls.nvim
        -- https://github.com/nvim-telescope/telescope.nvim
        -- https://github.com/junegunn/fzf.vim
        -- https://github.com/L3MON4D3/LuaSnip
        -- https://github.com/folke/twilight.nvim
        -- https://github.com/Pocco81/true-zen.nvim
        -- https://github.com/rcarriga/nvim-notify
        -- https://github.com/glepnir/galaxyline.nvim
    end)
