local ok, utils = pcall(require, 'core.utils')
if not ok then
  vim.notify("Could not load utils", vim.log.levels.ERROR)
  return
end

-- Colemak remappings
-- k -> h, n -> j, e -> k
utils.map({ "n", "x" }, "k", "h")
utils.map({ "n", "x" }, "e", "k")
utils.map({ "n", "x" }, "n", "j")
utils.map({ "n", "x" }, "N", "J")

-- Map h to e
utils.map({ "n", "x" }, "h", "e")
utils.map({ "n", "x" }, "H", "E")

-- Map s to i
utils.map({ "n", "x" }, "s", "i")
utils.map({ "n", "x" }, "S", "I")

-- Map i to l
utils.map({ "n", "x" }, "i", "l")
utils.map({ "n", "x" }, "I", "L")

-- Map n to l
utils.map({ "n", "x" }, "l", "n")
utils.map({ "n", "x" }, "L", "N")

-- Esc is hard to press
utils.map("i", "kk", "<Esc>")
utils.map("i", "tn", "<Esc>")

-- Yep, I go backwards quite a lot
utils.map("n", "<leader>b", "<C-o>")
utils.map("n", "<leader>B", "<C-i>")


-------------
-- Plugins --
-------------
utils.map({ "n", "x" }, "<leader>Pl", ":Lazy<CR>", { desc = "Lazy" })

------------
-- Visual --
------------
utils.map("x", "<", "<gv") -- Stay in indent mode
utils.map("x", ">", ">gv") -- Stay in indent mode

-----------------
-- WINDOW MODE --
-----------------
utils.map("n", "<leader>ws", "<cmd>split<CR>")
utils.map("n", "<leader>wv", "<cmd>vsplit<CR>")
utils.map("n", "<leader>wns", "<cmd>new<CR>")
utils.map("n", "<leader>wnv", "<cmd>vnew<CR>")
utils.map("n", "<leader>w=", "<C-w>=")
utils.map("n", "<leader>k", "<C-w>h")
utils.map("n", "<leader>n", "<C-w>j")
utils.map("n", "<leader>e", "<C-w>k")
utils.map("n", "<leader>i", "<C-w>l")

utils.map("n", "<leader>q", "<cmd>q<CR>")
utils.map("n", "<leader>Q", "<cmd>q!<CR>")

-- Resize with arrows
-- utils.map("n", "<C-Up>", ":resize +2<CR>")
-- utils.map("n", "<C-Down>", ":resize -2<CR>")
-- utils.map("n", "<C-Left>", ":vertical resize -2<CR>")
-- utils.map("n", "<C-Right>", ":vertical resize +2<CR>")


-- These are used so frequently that I want to
-- have them one keypress away
utils.map("n", "<leader>t", ":ToggleTerm direction=float<CR>")
utils.map("n", "<M-t>", ":ToggleTerm direction=tab<CR>")
utils.map("n", "<leader>t", ":ToggleTerm direction=tab<CR>")
utils.map("n", "<leader>T", ":ToggleTerm direction=float<CR>")

-- Terminal mode mappings
utils.map("t", "<C-\\><C-n>", "<nop>")
utils.map("t", "<C-\\><C-n>i", "<nop>")
utils.map("t", "<Esc>", "<C-\\><C-n>") -- Who needs ESC in the shell anyway lol
utils.map("t", "<M-t>", "<C-\\><C-n>:ToggleTerm<CR>")

-- Smarter delete
local function dd()
  if vim.api.nvim_get_current_line():match("^%s*$") then
    return "\"_dd"
  else
    return "dd"
  end
end

utils.map("n", "dd", dd, { noremap = true, expr = true })
utils.map("n", "<C-b>", utils.togglewinbar)

local opts = { noremap = true, silent = true }
--utils.map('n', '<space>e', vim.diagnostic.open_float, opts)
utils.map('n', 'dN', vim.diagnostic.goto_prev, opts)
utils.map('n', 'dn', vim.diagnostic.goto_next, opts)
utils.map('n', 'do', vim.diagnostic.open_float, opts)
utils.map('n', 'dl', vim.diagnostic.setloclist, opts)
--utils.map('n', '<space>a', vim.diagnostic.setloclist, opts)

--utils.map({ "n", "x" }, "ga", "<Plug>(EasyAlign)")
