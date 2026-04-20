if vim.g.vscode then return end

vim.pack.add({
  'https://github.com/folke/flash.nvim',
})

local map = require('utils').map

-- flash.nvim
require("flash").setup({
  labels = "arstgmneiofpludh",
  modes = {
    char = { enabled = false },
  },
})

map({ "n", "x", "o" }, "s", function() require("flash").jump() end, { desc = "Flash" })
map({ "n", "x", "o" }, "S", function() require("flash").treesitter() end, { desc = "Flash Treesitter" })
map("o", "r", function() require("flash").remote() end, { desc = "Remote Flash" })
map({ "o", "x" }, "R", function() require("flash").treesitter_search() end, { desc = "Flash Treesitter Search" })
map("c", "<a-s>", function() require("flash").toggle() end, { desc = "Toggle Flash Search" })
