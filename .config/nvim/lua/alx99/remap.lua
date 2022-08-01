-- Functional wrapper for mapping custom keybindings
local function map(mode, lhs, rhs, opts)
    local options = { noremap = true }
    if opts then
        options = vim.tbl_extend("force", options, opts)
    end
    vim.keymap.set(mode, lhs, rhs, options)
end

if (not vim.g.vscode) then
    -- These do not work correctly with vscode
    map("n", "<leader>w", "<cmd>w<CR>")
    map("n", "<leader>q", "<cmd>q<CR>")
end

-- Colemak remappings
-- k -> h, n -> j, e -> k
map({ "n", "v" }, "k", "h")
map({ "n", "v" }, "e", "k")
map({ "n", "v" }, "n", "j")
map({ "n", "v" }, "N", "J")

-- Map h to e
map({ "n", "v" }, "h", "e")
map({ "n", "v" }, "H", "E")

-- Map s to i
map({ "n", "v" }, "s", "i")
map({ "n", "v" }, "S", "I")

-- Map i to l (will be overwritten below)
map({ "n", "v" }, "i", "l")
map({ "n", "v" }, "I", "L")

-- Map n to l
map({ "n", "v" }, "l", "n")
map({ "n", "v" }, "L", "N")

-- Map kk to esc
map("i", "kk", "<Esc>")

-- Yep, I go backwards quite a lot
map("n", "<leader>b", "<C-O>")


-- TODO, need to decide on navigation workflow
-- map("n", "<leader>k", "<C-w>h")
-- map("n", "<leader>n", "<C-w>j")
-- map("n", "<leader>e", "<C-w>k")
-- map("n", "<leader>i", "<C-w>l")
map("n", "<leader>o", "<cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>")
map("n", "<leader>lg", "<cmd>Telescope live_grep<CR>")
map({ "n", "v" }, "ga", "<Plug>(EasyAlign)")

-- Plugin mappings
-- TODO move them somewhere else
vim.keymap.set('n', '<leader>/',
    "v:count == 0 ? '<Plug>(comment_toggle_current_linewise)' : '<Plug>(comment_toggle_linewise_count)'",
    { expr = true, remap = true })
vim.keymap.set('v', '<leader>/', '<Plug>(comment_toggle_linewise_visual)')
