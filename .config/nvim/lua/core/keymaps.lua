local map = require('core.utils').map

-- Colemak-DH remaps
local colemak_maps = {
  m = 'h', -- Left
  n = 'j', -- Down
  e = 'k', -- Up
  i = 'l', -- Right
  M = 'H', -- Top of buffer
  I = 'L', -- End of buffer
}

for k, v in pairs(colemak_maps) do
  map({ "n", "v", "o" }, k, v)
end

-- Fix conflicts caused by the above mappings
for k, v in pairs({
  k = 'm', -- k is the new m
  l = 'n', -- l is the new n
  h = 'e', -- h is the new e
  s = 'i', -- s is the new i
}) do
  -- if k == 'l' then
  --   map({ "n", "v", "o" }, k, v .. "zzzv", { desc = "search next and center" })
  --   map({ "n", "v", "o" }, string.upper(k), string.upper(v) .. "zzzv", { desc = "search prev and center" })
  -- else
  map({ "n", "v", "o" }, k, v)
  map({ "n", "v", "o" }, string.upper(k), string.upper(v))
  -- end
end
vim.cmd("sunmap s") -- otherwise "s" wont' work in select mode

-- Additional fixes (h is the new e)
map({ "n", "x", "o" }, "gh", "ge", { desc = "Previous end of word" })
map({ "n", "x", "o" }, "gH", "gE", { desc = "Previous end of word" })
map({ "n", "x", "o" }, "ge", "<Nop>")
map({ "n", "x", "o" }, "gE", "<Nop>")
map("i", "<C-h>", "<C-W>", { desc = "Delete word backwards" }) -- CTRL+BS = C-h
map({ "n", "o" }, "ci", "c<Right>")
map({ "n", "o" }, "di", "d<Right>")
map({ "n", "o" }, "vi", "v<Right>")

-- QoL
map("n", "U", "<C-r>")  -- Redo
map("x", "<", "<gv")    -- Stay in indent mode
map("x", ">", ">gv")    -- Stay in indent mode
map("i", "tn", "<Esc>") -- Esc is hard to press

map("n", "<leader>bd", "<cmd>bdelete<CR>", { desc = "Close current buffer" })
map("n", "<leader>bD", "<cmd>%bd|e#<CR>", { desc = "Close all buffers except current" })
map("n", "<leader>bn", "<cmd>bnext<CR>", { desc = "Next buffer" })
map("n", "<leader>bp", "<cmd>bprevious<CR>", { desc = "Previous buffer" })

-- Center cursor vertically while <C-d> and <C-u>
map('n', '<C-d>', '<C-d>zz')
map('n', '<C-u>', '<C-u>zz')

-- plugins
map({ "n", "x", "o" }, "<leader>pl", ":Lazy<CR>", { desc = "Lazy" })

-----------------
-- WINDOW MODE --
-----------------
map("n", "<leader>w", "<C-w>")
map("n", "<leader>wcs", "<cmd>new<CR>", { desc = "Open new split" })
map("n", "<leader>wcv", "<cmd>vnew<CR>", { desc = "Open new vertical" })

-- Navigate to window
map("n", "<leader>wm", "<C-w>h", { desc = "Focus left" })
map("n", "<leader>wn", "<C-w>j", { desc = "Focus down" })
map("n", "<leader>we", "<C-w>k", { desc = "Focus up" })
map("n", "<leader>wi", "<C-w>l", { desc = "Focus right" })
map("n", "<leader>wo", "<C-w>o", { desc = "Close all but current" })

map("n", "<leader>ws", "<C-w>s", { desc = "Split horizontally" })
map("n", "<leader>wv", "<C-w>v", { desc = "Split vertically" })
map("n", "<leader>w=", "<C-w>=", { desc = "Make window same dimens" })

-- for k, v in pairs({
--   m = 'h', -- Left
--   n = 'j', -- Down
--   e = 'k', -- Up
--   i = 'l', -- Right
-- }) do
--   -- Navigate to window
--   map("n", "<leader>w" .. k, "<C-w>" .. v)
--   map("n", "<leader>w" .. string.upper(k), "<C-w>" .. string.upper(v))
--   map("n", "<C-w>" .. v, "<Nop>")
--   map("n", "<C-w>" .. string.upper(v), "<Nop>")
-- end

-- :only <C-w>f <C-w>F <C-w>gf <C-w>gF <C-w>= <C-w>+ <C-w>- <C-w>> <C-w>< <C-w>_ <C-w>| <C-w>x
-- todo read about tags
-- map("n", "gp", "<C-w>}")

map("n", "<leader>q", ":hide<CR>")

-- Resize with arrows
-- map("n", "<C-Up>", ":resize +2<CR>")
-- map("n", "<C-Down>", ":resize -2<CR>")
-- map("n", "<C-Left>", ":vertical resize -2<CR>")
-- map("n", "<C-Right>", ":vertical resize +2<CR>")

-- Smarter delete

map("n", "dd", function()
  if vim.api.nvim_get_current_line():match("^%s*$") then
    return "\"_dd"
  else
    return "dd"
  end
end, { noremap = true, expr = true })
