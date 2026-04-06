-- blink.cmp (autocompletion)
-- Depends on: sidekick.lua (Tab keymap calls sidekick.nes_jump_or_apply)
if vim.g.vscode then return end

-- Sidekick must be registered before blink.cmp (Tab keymap references it)
vim.pack.add({
  { src = "https://github.com/saghen/blink.cmp", version = vim.version.range("1.*") },
})

require("blink.cmp").setup({
  keymap = {
    preset = "default",
    ["<CR>"] = { "select_and_accept", "fallback" },
    ["<Tab>"] = {
      function()
        return require("sidekick").nes_jump_or_apply()
      end,
      function()
        return vim.lsp.inline_completion.get()
      end,
      "fallback",
    },
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
