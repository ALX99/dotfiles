local utils = require('utils')
local map = utils.map

require('colemak').setup()

-- QoL
map("x", ">", ">gv", { desc = "Increase indent" })              -- Stay in indent mode
map("x", "<", "<gv", { desc = "Decrease indent" })              -- Stay in indent mode
map("i", "tn", "<Esc>", { desc = "Exit insert mode" })          -- Esc is hard to press
map("i", "<C-h>", "<C-W>", { desc = "Delete word backwards" })  -- CTRL+BS = C-h
map("i", "<M-BS>", "<C-W>", { desc = "Delete word backwards" }) -- For macOS


map("n", "<leader>bn", "<cmd>bnext<CR>", { desc = "Next buffer" })
map("n", "<leader>bp", "<cmd>bprevious<CR>", { desc = "Previous buffer" })

-- Center cursor vertically while <C-d> and <C-u>
map('n', '<C-d>', '<C-d>zz')
map('n', '<C-u>', '<C-u>zz')

-- Center search results when navigating
map("n", "l", "nzzzv", { silent = true })
map("n", "L", "Nzzzv", { silent = true })

-- pack
map("n", "<leader>Pu", function() vim.pack.update() end, { desc = "vimpack update - code action to skip some" })
map("n", "<leader>Pr", function() vim.pack.update(nil, { target = "lockfile", force = true }) end,
  { desc = "vimpack update to lockfile versions" })
map("n", "<leader>Pi", function() vim.pack.update(nil, { offline = true }) end, { desc = "vimpack info" })

-- Windows
if not vim.g.vscode then
  map("n", "<leader>w", "<C-w>")
  map("n", "<leader>wcs", "<cmd>new<CR>", { desc = "Open new split" })
  map("n", "<leader>wcv", "<cmd>vnew<CR>", { desc = "Open new vertical" })
  map("n", "<leader>ws", "<C-w>s", { desc = "Split horizontally" })
  map("n", "<leader>wv", "<C-w>v", { desc = "Split vertically" })
  map("n", "<leader>w=", "<C-w>=", { desc = "Make window same dimens" })

  -- Navigate to window
  map("n", "<leader>wm", "<C-w>h", { desc = "Focus left" })
  map("n", "<leader>wn", "<C-w>j", { desc = "Focus down" })
  map("n", "<leader>we", "<C-w>k", { desc = "Focus up" })
  map("n", "<leader>wi", "<C-w>l", { desc = "Focus right" })
  map("n", "<leader>wo", "<C-w>o", { desc = "Close all but current" })


  -- Diagnostics
  map('n', 'gl', vim.diagnostic.open_float, { desc = "List diagnostics" })

  -- :only <C-w>f <C-w>F <C-w>gf <C-w>gF <C-w>= <C-w>+ <C-w>- <C-w>> <C-w>< <C-w>_ <C-w>| <C-w>x

  map("n", "<leader>q", ":q<CR>", { silent = true })
  map("n", "<leader>C", function()
    local file_path = vim.api.nvim_buf_get_name(0)
    local line_number = vim.fn.line('.')
    local column_number = vim.fn.col('.')
    local goto_arg = string.format("%s:%d:%d", file_path, line_number, column_number)
    vim.fn.system({ 'code', vim.fn.getcwd(), '--goto', goto_arg })
  end, { desc = "open file in vscode" })
end

vim.api.nvim_create_user_command("CopyPath", function()
  local file = vim.api.nvim_buf_get_name(0)
  local cwd = vim.fn.getcwd()
  local rel = vim.fs.relpath(cwd, file)
  local display = (rel and rel ~= "") and rel or file
  vim.fn.setreg("+", display .. ":" .. vim.fn.line("."))
end, {})

-- Copy text to clipboard using codeblock format ```{ft}{content}```
vim.api.nvim_create_user_command('CopyCodeBlock', utils.copy_code_block, { range = true })


-- Smarter delete
map("n", "dd", function()
  if vim.api.nvim_get_current_line():match("^%s*$") then
    return "\"_dd"
  else
    return "dd"
  end
end, { noremap = true, expr = true })

-- Visual-mode "very nomagic" search: yank selection into /, then re-run * or #.
-- Makes * and # search the literal selection (handles /*foo*/ cleanly).
local function vset_search()
  local temp = vim.fn.getreg('s')
  vim.cmd('normal! gv"sy')
  local s = vim.fn.getreg('s'):gsub('\n', '\\n')
  s = vim.fn.escape(s, [[/\?]])
  vim.fn.setreg('/', [[\V]] .. s)
  vim.fn.setreg('s', temp)
end

local function vsearch(direction)
  vset_search()
  return direction .. vim.fn.getreg('/') .. '<CR>'
end

map('x', '*', function() return vsearch('/') end, { expr = true })
map('x', '#', function() return vsearch('?') end, { expr = true })

-- Search inside visual selection
-- https://www.reddit.com/r/neovim/comments/1mxeghf/using_as_a_multipurpose_search_tool/
map("x", "/", "<ESC>/\\%V") -- `:h /\%V`

if not vim.g.vscode then
  vim.cmd.packadd('nvim.undotree')
  map("n", "<leader>u", "<cmd>Undotree<CR>", { desc = "Undo tree" })
end
