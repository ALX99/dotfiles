_G.Config = {}

local gr = vim.api.nvim_create_augroup('custom-config', { clear = true })
_G.Config.new_autocmd = function(event, opts)
  opts = opts or {}
  opts.group = gr
  vim.api.nvim_create_autocmd(event, opts)
end
