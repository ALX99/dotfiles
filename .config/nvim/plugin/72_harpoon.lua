-- harpoon (file marks) + flash.nvim (jump navigation) + vscode mode setup
if vim.g.vscode then
  require("custom_plugins.vscode").setup()
  return
end

vim.pack.add({
  'https://github.com/nvim-lua/plenary.nvim', -- required by harpoon
  'https://github.com/ThePrimeagen/harpoon',
  'https://github.com/folke/flash.nvim',
})

local map = require('utils').map
local harpoon_ui   = require('harpoon.ui')
local harpoon_mark = require('harpoon.mark')

-- harpoon
map("n", "<leader>1", function() harpoon_ui.nav_file(1) end, { desc = "Harpoon 1" })
map("n", "<leader>2", function() harpoon_ui.nav_file(2) end, { desc = "Harpoon 2" })
map("n", "<leader>3", function() harpoon_ui.nav_file(3) end, { desc = "Harpoon 3" })
map("n", "<leader>4", function() harpoon_ui.nav_file(4) end, { desc = "Harpoon 4" })
map("n", "<leader>h", function() harpoon_mark.add_file() end, { desc = "Harpoon add file" })
map("n", "<leader>H", function() harpoon_ui.toggle_quick_menu() end, { desc = "Harpoon UI" })

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
