-- https://github.com/windwp/nvim-autopairs
--
local ok, autopairs = pcall(require, 'nvim-autopairs')
if not ok then
  vim.notify("Could not load nvim-autopairs", vim.log.levels.ERROR)
  return
end

autopairs.setup {}
