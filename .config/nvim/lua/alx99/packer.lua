-- This file can be loaded by calling `lua require('plugins')` from your init.vim

-- Only required if you have packer configured as `opt`
vim.cmd [[packadd packer.nvim]]

return require('packer').startup(function(use)
  -- Packer can manage itself
  use 'wbthomason/packer.nvim'

  -- Simple plugins can be specified as strings
  use 'folke/tokyonight.nvim' -- https://github.com/folke/tokyonight.nvim
  use 'junegunn/vim-easy-align' -- https://github.com/junegunn/vim-easy-align
  use 'gryf/wombat256grf' -- https://github.com/junegunn/vim-easy-align
  use 'kyazdani42/nvim-tree.lua'
  use ({
    'numToStr/Comment.nvim',
    config = function()
        require('Comment').setup()
    end,
  })

end)

