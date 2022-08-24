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

-- Map i to l (will be overwritten below)
utils.map({ "n", "x" }, "i", "l")
utils.map({ "n", "x" }, "I", "L")

-- Map n to l
utils.map({ "n", "x" }, "l", "n")
utils.map({ "n", "x" }, "L", "N")

-- Esc is hard to press
utils.map("i", "kk", "<Esc>")
utils.map("i", "tn", "<Esc>")

-- Yep, I go backwards quite a lot
utils.map("n", "<leader>b", "<C-O>")

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
utils.map("n", "<leader>wo", "<cmd>vsplit<CR><cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>")
utils.map("n", "<leader>wO", "<cmd>split<CR><cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>")
utils.map("n", "<leader>k", "<C-w>h")
utils.map("n", "<leader>n", "<C-w>j")
utils.map("n", "<leader>e", "<C-w>k")
utils.map("n", "<leader>i", "<C-w>l")

-- TODO, need to decide on navigation workflow
utils.map("n", "<S-i>", ":tabnext<CR>")
utils.map("n", "<S-k>", ":tabprevious<CR>")


---------------
-- FILE MODE --
---------------
utils.map('n', '<leader>ft', '<cmd>NvimTreeFindFile<CR>')
if (not vim.g.vscode) then
  -- These do not work correctly with vscode
  utils.map("n", "<leader>w", "<cmd>close<CR>")
  utils.map("n", "<leader>q", "<cmd>bd<CR>")
end

-- Resize with arrows
-- utils.map("n", "<C-Up>", ":resize +2<CR>")
-- utils.map("n", "<C-Down>", ":resize -2<CR>")
-- utils.map("n", "<C-Left>", ":vertical resize -2<CR>")
-- utils.map("n", "<C-Right>", ":vertical resize +2<CR>")


-- These are used so frequently that I want to
-- have them one keypress away
utils.map("n", "<leader>o", "<cmd>Telescope fd find_command=rg,--files,--iglob,!.git<CR>")
utils.map("n", "<leader>O", "<cmd>Telescope fd find_command=rg,--files,--hidden,--iglob,!.git<CR>")
utils.map("n", "<leader>t", ":ToggleTerm direction=float<CR>")

-- Terminal mode mappings
utils.map("t", "<C-\\><C-n>", "<nop>")
utils.map("t", "<C-\\><C-n>i", "<nop>")
utils.map("t", "<Esc>", "<C-\\><C-n>")

-- Smarter delete
local function dd()
  if vim.api.nvim_get_current_line():match("^%s*$") then
    return "\"_dd"
  else
    return "dd"
  end
end

utils.map("n", "dd", dd, { noremap = true, expr = true })

local opts = { noremap = true, silent = true }
--utils.map('n', '<space>e', vim.diagnostic.open_float, opts)
utils.map('n', '[d', vim.diagnostic.goto_prev, opts)
utils.map('n', ']d', vim.diagnostic.goto_next, opts)
--utils.map('n', '<space>a', vim.diagnostic.setloclist, opts)

utils.map("n", "<leader>lg", "<cmd>Telescope live_grep<CR>")
utils.map({ "n", "x" }, "ga", "<Plug>(EasyAlign)")
