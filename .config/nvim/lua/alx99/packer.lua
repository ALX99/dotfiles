-- This file can be loaded by calling `lua require('plugins')` from your init.vim

-- Only required if you have packer configured as `opt`
vim.cmd [[packadd packer.nvim]]

return require("packer").startup(
    function(use)
        use "wbthomason/packer.nvim" -- Packer can mange itself
        use "junegunn/vim-easy-align" -- https://github.com/junegunn/vim-easy-align


        if vim.g.vscode then
            return -- The rest of the stuff is not needed for vscode
        end

        use "neovim/nvim-lspconfig"
        use "folke/tokyonight.nvim" -- https://github.com/folke/tokyonight.nvim
        use "gryf/wombat256grf" -- https://github.com/junegunn/vim-easy-align
        use "kyazdani42/nvim-tree.lua"
        use(
            {
                "numToStr/Comment.nvim",
                config = function()
                    require("Comment").setup()
                end
            }
        )
end)