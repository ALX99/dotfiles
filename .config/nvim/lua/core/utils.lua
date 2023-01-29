local M = {
  winbar = false
}

-- Functional wrapper for mapping custom keybindings
function M.map(mode, lhs, rhs, opts)
  local options = { noremap = true }
  if opts then
    options = vim.tbl_extend("force", options, opts)
  end
  vim.keymap.set(mode, lhs, rhs, options)
end

function M.togglewinbar()
  if M.winbar then
    vim.o.winbar = ""
    M.winbar = false
  else
    vim.o.winbar = "%<%f %y %h%m%r%=%-14.(%l,%c%V%) %P"
    M.winbar = true
  end
end

return M
