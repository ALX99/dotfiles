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


-- Install gopls
require("lspconfig").gopls.setup{}
-- Install shellcheck and https://github.com/bash-lsp/bash-language-server
require("lspconfig").bashls.setup{}

-- Install https://github.com/rcjsuen/dockerfile-language-server-nodejs (used by the vscode docker extension)
require'lspconfig'.dockerls.setup{}

-- Install https://github.com/redhat-developer/yaml-language-server
require('lspconfig').yamlls.setup{
  settings = {
    yaml = {
      schemas = {
        ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*"
      },
    },
  }
}
