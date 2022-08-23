local M = {}

-- Functional wrapper for mapping custom keybindings
function M.map(mode, lhs, rhs, opts)
  local options = { noremap = true }
  if opts then
    options = vim.tbl_extend("force", options, opts)
  end
  vim.keymap.set(mode, lhs, rhs, options)
end

function M.require(modnames)
  local ok, mod = pcall(require, modnames)
  if not ok then
    vim.notify("Could not load " .. modnames, vim.log.levels.ERROR)
    return nil
  end
  return mod
end

return M
