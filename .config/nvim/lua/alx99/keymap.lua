local utils = require('alx99.utils')

if (not vim.g.vscode) then
    -- These do not work correctly with vscode
    utils.map("n", "<leader>w", "<cmd>w<CR>")
    utils.map("n", "<leader>q", "<cmd>q<CR>")
end

-- Colemak remappings
-- k -> h, n -> j, e -> k
utils.map({ "n", "v" }, "k", "h")
utils.map({ "n", "v" }, "e", "k")
utils.map({ "n", "v" }, "n", "j")
utils.map({ "n", "v" }, "N", "J")

-- Map h to e
utils.map({ "n", "v" }, "h", "e")
utils.map({ "n", "v" }, "H", "E")

-- Map s to i
utils.map({ "n", "v" }, "s", "i")
utils.map({ "n", "v" }, "S", "I")

-- Map i to l (will be overwritten below)
utils.map({ "n", "v" }, "i", "l")
utils.map({ "n", "v" }, "I", "L")

-- Map n to l
utils.map({ "n", "v" }, "l", "n")
utils.map({ "n", "v" }, "L", "N")

-- Map kk to esc
utils.map("i", "kk", "<Esc>")

-- Yep, I go backwards quite a lot
utils.map("n", "<leader>b", "<C-O>")


-- TODO, need to decide on navigation workflow
utils.map("n", "<leader>k", "<C-w>h")
utils.map("n", "<leader>n", "<C-w>j")
utils.map("n", "<leader>e", "<C-w>k")
utils.map("n", "<leader>i", "<C-w>l")
utils.map("n", "<leader>o", "<cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>")
utils.map("n", "<leader>lg", "<cmd>Telescope live_grep<CR>")
utils.map({ "n", "v" }, "ga", "<Plug>(EasyAlign)")

-- Plugin mappings
-- TODO move them somewhere else
utils.map('n', '<leader>/', "v:count == 0 ? '<Plug>(comment_toggle_current_linewise)' : '<Plug>(comment_toggle_linewise_count)'", { expr = true, remap = true })
utils.map('v', '<leader>/', '<Plug>(comment_toggle_linewise_visual)')
