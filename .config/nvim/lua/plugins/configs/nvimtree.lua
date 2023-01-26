local utils = require('core.utils')

local nvim_tree = utils.require('nvim-tree')
if not nvim_tree then return end

-- :help nvim-tree-setup
-- :help nvim-tree.OPTION_NAME
nvim_tree.setup {
  open_on_setup = true,
  remove_keymaps = true,
  view = {
    width = {
      min = "10%",
      max = "40%"
    },
    mappings = {
      custom_only = true,
      list = {
        { key = "<CR>", action = "edit" },
        { key = ">", action = "prev_sibling" },
        { key = "<", action = "next_sibling" },
        { key = "<BS>", action = "close_node" },
        { key = "<Tab>", action = "preview" },
        { key = "C", action = "toggle_git_clean" },
        { key = "I", action = "toggle_git_ignored" },
        { key = ".", action = "toggle_dotfiles" },
        { key = "R", action = "refresh" },
        { key = "E", action = "expand_all" },
        { key = "a", action = "create" },
        { key = "d", action = "remove" },
        { key = "r", action = "rename" },
        { key = "x", action = "cut" },
        { key = "c", action = "copy" },
        { key = "p", action = "paste" },
        { key = "q", action = "close" },
        { key = "?", action = "toggle_help" },
      },
    },
  },
  diagnostics = {
    enable = true,
    show_on_dirs = true,
  },
}
