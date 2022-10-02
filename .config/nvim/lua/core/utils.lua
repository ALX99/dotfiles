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

-- Wrapper for the pcall function with errors being written with vim.notify
function M.require(modnames)
  local ok, mod = pcall(require, modnames)
  if not ok then
    vim.notify("Could not load " .. modnames, vim.log.levels.ERROR)
    return nil
  end
  return mod
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
