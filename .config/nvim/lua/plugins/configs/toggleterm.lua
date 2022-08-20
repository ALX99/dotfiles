local ok, toggle_term = pcall(require, 'toggleterm')
if not ok then
  vim.notify("Could not load toggleterm", vim.log.levels.ERROR)
  return
end
toggle_term.setup {}
