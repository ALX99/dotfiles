-- plenary.nvim is a dependency of harpoon — both must be registered together
-- custom_plugins/vscode is a flat init.lua at lua/custom_plugins/vscode/init.lua — require('custom_plugins.vscode') works directly
vim.pack.add({
  'https://github.com/nvim-lua/plenary.nvim', -- required by harpoon
  'https://github.com/ThePrimeagen/harpoon',
  'https://github.com/folke/flash.nvim',
})

if vim.g.vscode then
  require("custom_plugins.vscode").setup()
  return
end

local map = require('utils').map

-- harpoon
map("n", "<leader>1", "<cmd>lua require('harpoon.ui').nav_file(1)<cr>", { desc = "Harpoon 1" })
map("n", "<leader>2", "<cmd>lua require('harpoon.ui').nav_file(2)<cr>", { desc = "Harpoon 2" })
map("n", "<leader>3", "<cmd>lua require('harpoon.ui').nav_file(3)<cr>", { desc = "Harpoon 3" })
map("n", "<leader>4", "<cmd>lua require('harpoon.ui').nav_file(4)<cr>", { desc = "Harpoon 4" })
map("n", "<leader>h", "<cmd>lua require('harpoon.mark').add_file()<cr>", { desc = "Harpoon add file" })
map("n", "<leader>H", "<cmd>lua require('harpoon.ui').toggle_quick_menu()<cr>", { desc = "Harpoon UI" })

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
