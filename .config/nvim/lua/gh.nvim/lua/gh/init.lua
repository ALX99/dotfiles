local job = require('plenary.job')

local M = {}

function M.setup(opts)
  vim.api.nvim_create_user_command(
    "GHBrowse",
    M.browse_file,
    { desc = "Browse file on Github" }
  )
end

local function gh(args)
  job:new({
    command = 'gh',
    args = args,
    on_exit = function(j, return_val)
      print(vim.inspect(j:result()))
    end,
  }):start()
end

function M.browse_file()
  local relative_file = vim.fn.fnamemodify(vim.fn.expand('%'), ':.')
  local line = vim.fn.line('.')
  gh({ "browse", relative_file .. ':' .. line })
end

return M
