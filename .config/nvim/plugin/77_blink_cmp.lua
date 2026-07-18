-- blink.cmp (autocompletion)
if vim.g.vscode then return end

require("blink.cmp").setup({
  keymap = {
    preset = "default",
    ["<CR>"] = { "select_and_accept", "fallback" },
  },

  appearance = {
    nerd_font_variant = "mono",
  },

  completion = {
    documentation = { auto_show = true },
    list = {
      selection = {
        auto_insert = false,
      },
    },
  },

  signature = { enabled = true },

  sources = {
    default = { "lsp", "path", "buffer" },
  },
})
