local ok, utils = pcall(require, 'core.utils')
if not ok then
  vim.notify("Could not load utils", vim.log.levels.ERROR)
  return
end

-- Colemak-DH remappings
local colemak_maps = {
  m = 'h', -- Left
  n = 'j', -- Down
  e = 'k', -- Up
  i = 'l', -- Right
}

for k, v in pairs(colemak_maps) do
  utils.map({ "n", "x", "o" }, k, v)
  utils.map({ "n", "x", "o" }, string.upper(k), string.upper(v))
end

-- Additional fixes due to colemak remappings
for k, v in pairs({
  k = 'm', -- k is the new m
  l = 'n', -- l is the new n
  h = 'e', -- h is the new e
  s = 'i', -- s is the new i
}) do
  utils.map({ "n", "x", "o" }, k, v)
  utils.map({ "n", "x", "o" }, string.upper(k), string.upper(v))
end

utils.map({ "n", "x", "o" }, "gh", "ge")
utils.map({ "n", "x", "o" }, "gH", "gE")
utils.map({ "n", "x", "o" }, "ge", "<Nop>")
utils.map({ "n", "x", "o" }, "gE", "<Nop>")

-- Remove some mappings that are bothersome
utils.map({ "n", "x", "o" }, "vi", "<Nop>")

-- Esc is hard to press
utils.map("i", "tn", "<Esc>")

-- Yep, I go backwards quite a lot
utils.map("n", "<leader>b", "<C-o>")
utils.map("n", "<leader>B", "<C-i>")

-------------
-- Plugins --
-------------
utils.map({ "n", "x", "o" }, "<leader>pl", ":Lazy<CR>", { desc = "Lazy" })

------------
-- Visual --
------------
utils.map("x", "<", "<gv") -- Stay in indent mode
utils.map("x", ">", ">gv") -- Stay in indent mode

-----------------
-- WINDOW MODE --
-----------------
utils.map("n", "<leader>w", "<C-w>")
utils.map("n", "<leader>wns", "<cmd>new<CR>")
utils.map("n", "<leader>wnv", "<cmd>vnew<CR>")

for k, v in pairs(colemak_maps) do
  utils.map("n", "<leader>" .. k, "<C-w>" .. v)
  utils.map("n", "<leader>w" .. string.upper(k), "<C-w>" .. string.upper(v))
  utils.map("n", "<C-w>" .. v, "<Nop>")
  utils.map("n", "<C-w>" .. string.upper(v), "<Nop>")
end

-- :only <C-w>f <C-w>F <C-w>gf <C-w>gF <C-w>= <C-w>+ <C-w>- <C-w>> <C-w>< <C-w>_ <C-w>| <C-w>x
-- todo read about tags
-- utils.map("n", "gp", "<C-w>}")

utils.map("n", "<leader>q", ":hide<CR>", { silent = true })

-- Resize with arrows
-- utils.map("n", "<C-Up>", ":resize +2<CR>")
-- utils.map("n", "<C-Down>", ":resize -2<CR>")
-- utils.map("n", "<C-Left>", ":vertical resize -2<CR>")
-- utils.map("n", "<C-Right>", ":vertical resize +2<CR>")

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
