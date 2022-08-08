local utils_ok, utils = pcall(require, 'alx99.utils')
if not utils_ok then
  vim.notify("Could not load utils", vim.log.levels.ERROR)
  return
end

local nvim_tree_ok, nvim_tree = pcall(require, 'nvim-tree')
if not nvim_tree_ok then
  vim.notify("Could not load nvim-tree", vim.log.levels.ERROR)
  return
end

-- :help nvim-tree-setup
-- :help nvim-tree.OPTION_NAME
nvim_tree.setup {
  view = {
    adaptive_size = true,
  },
}
utils.map('n', '<leader>ft', '<cmd>NvimTreeFindFile<CR>', { noremap = true })
