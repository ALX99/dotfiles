local map = require('core.utils').map

-- Colemak-DH remaps
local colemak_maps = {
  m = 'h', -- Left
  n = 'j', -- Down
  e = 'k', -- Up
  i = 'l', -- Right
}

for k, v in pairs(colemak_maps) do
  map({ "n", "x", "o" }, k, v)
  map({ "n", "x", "o" }, string.upper(k), string.upper(v))
end

-- Fix conflicts caused by the above mappings
for k, v in pairs({
  k = 'm', -- k is the new m
  l = 'n', -- l is the new n
  h = 'e', -- h is the new e
  s = 'i', -- s is the new i
}) do
  map({ "n", "x", "o" }, k, v)
  map({ "n", "x", "o" }, string.upper(k), string.upper(v))
end

-- Additional fixes (h is the new e)
map({ "n", "x", "o" }, "gh", "ge")
map({ "n", "x", "o" }, "gH", "gE")
map({ "n", "x", "o" }, "ge", "<Nop>")
map({ "n", "x", "o" }, "gE", "<Nop>")

map({ "n", "x", "o" }, "vi", "<Nop>") -- I use 'vs' instead
map("i", "tn", "<Esc>")               -- Esc is hard to press

-- Yep, I go backwards quite a lot
map("n", "<leader>b", "<C-o>")
map("n", "<leader>B", "<C-i>")

-------------
-- Plugins --
-------------
map({ "n", "x", "o" }, "<leader>pl", ":Lazy<CR>", { desc = "Lazy" })

------------
-- Visual --
------------
map("x", "<", "<gv") -- Stay in indent mode
map("x", ">", ">gv") -- Stay in indent mode

-----------------
-- WINDOW MODE --
-----------------
map("n", "<leader>w", "<C-w>")
map("n", "<leader>wns", "<cmd>new<CR>")
map("n", "<leader>wnv", "<cmd>vnew<CR>")

for k, v in pairs(colemak_maps) do
  map("n", "<leader>" .. k, "<C-w>" .. v)
  map("n", "<leader>w" .. string.upper(k), "<C-w>" .. string.upper(v))
  map("n", "<C-w>" .. v, "<Nop>")
  map("n", "<C-w>" .. string.upper(v), "<Nop>")
end

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
local function dd()
  if vim.api.nvim_get_current_line():match("^%s*$") then
    return "\"_dd"
  else
    return "dd"
  end
end

map("n", "dd", dd, { noremap = true, expr = true })
