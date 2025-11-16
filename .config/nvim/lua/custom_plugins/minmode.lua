local M = {
  minmode = false,

  -- saved values
  laststatus = -1,
  cmdheight = -1,
  statusline = ""
}

function M.toggle()
  if M.minmode then
    M.minmode = false
    vim.o.winbar = ""

    -- Restore options
    vim.o.laststatus = M.laststatus
    vim.o.cmdheight = M.cmdheight
    vim.o.statusline = M.statusline
  else
    M.minmode = true
    -- vim.o.winbar = "%<%f %y %h%m%r%=%-14.(%l,%c%V%) %P"

    -- Hide statusline by setting laststatus and cmdheight to 0.
    vim.o.laststatus = 0
    vim.o.cmdheight = 0
    vim.o.statusline = ""
  end
end

function M.setup()
  -- save current values
  M.laststatus = vim.o.laststatus
  M.cmdheight = vim.o.cmdheight
  M.statusline = vim.o.statusline

  vim.api.nvim_create_user_command(
    "MinModeToggle",
    M.toggle,
    { desc = "Toggle minimal mode" }
  )

  if not M.minmode then
    M.toggle()
  end
end

return M
