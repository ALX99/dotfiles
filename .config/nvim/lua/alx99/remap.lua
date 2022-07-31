-- Functional wrapper for mapping custom keybindings
function map(mode, lhs, rhs, opts)
    local options = { noremap = true }
    if opts then
        options = vim.tbl_extend("force", options, opts)
    end
    vim.api.nvim_set_keymap(mode, lhs, rhs, options)
end

map("n", "<leader>w", "<cmd>w<CR>")
map("n", "<leader>q", "<cmd>q<CR>")

-- Colemak remappings
map("n", "k", "h")
map("n", "e", "k")
map("v", "k", "h")
map("v", "e", "k")
map("n", "n", "j")
map("v", "n", "j")

-- Map h to e
map("n", "h", "e")
map("n", "H", "E")
map("v", "h", "e")
map("v", "H", "E")

-- Map s to i
map("n", "s", "i")
map("n", "S", "I")
map("v", "s", "i")
map("v", "S", "I")

-- Map i to l (will be overwritten below)
map("n", "i", "l")
map("n", "I", "L")
map("v", "i", "l")
map("v", "I", "L")

-- Map n to l
map("n", "l", "n")
map("n", "L", "N")
map("v", "l", "n")
map("v", "L", "N")

-- Map kk to esc
map("i", "kk", "<Esc>")



-- Plugin mappings
-- TODO move them somewhere else
vim.keymap.set('n', '<leader>/', "v:count == 0 ? '<Plug>(comment_toggle_current_linewise)' : '<Plug>(comment_toggle_linewise_count)'", { expr = true, remap = true })
vim.keymap.set('v', '<leader>/', '<Plug>(comment_toggle_linewise_visual)')
