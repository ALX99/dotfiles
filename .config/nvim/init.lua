_G.Config = {}

vim.g.mapleader      = " "
vim.g.maplocalleader = vim.g.mapleader

local gr = vim.api.nvim_create_augroup('custom-config', { clear = true })
_G.Config.new_autocmd = function(event, opts)
  opts = opts or {}
  opts.group = opts.group or gr
  vim.api.nvim_create_autocmd(event, opts)
end

require('custom.ai').setup()
