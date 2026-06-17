-- sidekick.nvim (NES only)
if vim.g.vscode then return end

vim.pack.add({
  { src = 'https://github.com/folke/sidekick.nvim', version = vim.version.range('*') },
})

local map = require('utils').map

require('sidekick').setup({
  cli = {
    mux = {
      backend = "tmux",
      enabled = false,
    },
  },
})

map("n", "<tab>", function()
  if require('sidekick').nes_jump_or_apply() then
    return ""
  end
  return "<Tab>"
end, { expr = true, desc = "Goto/Apply Next Edit Suggestion" })

-- Custom AI helpers (file send)
require("custom.ai").setup()
