local M = {
}

-- Functional wrapper for mapping custom keybindings
function M.map(mode, lhs, rhs, opts)
  local options = { noremap = true }
  if opts then
    options = vim.tbl_extend("force", options, opts)
  end
  vim.keymap.set(mode, lhs, rhs, options)
end

function M.is_vscodevim()
  if vim.g.vscode then
    return true
  else
    return false
  end
end

return M
