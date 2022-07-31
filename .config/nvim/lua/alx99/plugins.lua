if vim.g.vscode then
  return -- Currently we have nothing we want to configure when using vscode
end

-- :help nvim-tree-setup
-- :help nvim-tree.OPTION_NAME
require("nvim-tree").setup({
view = {
    adaptive_size = true,
  },
})

vim.api.nvim_set_keymap('n', '<leader>b', '<cmd>NvimTreeFindFile<CR>', { noremap = true })

