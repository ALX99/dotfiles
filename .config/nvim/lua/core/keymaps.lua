local map = require('core.utils').map

require('core.colemak').setup()

-- QoL
map("n", "U", "<C-r>", { desc = "Redo" })
map("x", ">", ">gv", { desc = "Increase indent" })             -- Stay in indent mode
map("x", "<", "<gv", { desc = "Decrease indent" })             -- Stay in indent mode
map("i", "tn", "<Esc>", { desc = "Exit insert mode" })         -- Esc is hard to press
map("i", "<C-h>", "<C-W>", { desc = "Delete word backwards" }) -- CTRL+BS = C-h

map("n", "<leader>bd", "<cmd>bdelete<CR>", { desc = "Close current buffer" })
map("n", "<leader>bD", "<cmd>%bd|e#<CR>", { desc = "Close all buffers except current" })
map("n", "<leader>bn", "<cmd>bnext<CR>", { desc = "Next buffer" })
map("n", "<leader>bp", "<cmd>bprevious<CR>", { desc = "Previous buffer" })

-- Center cursor vertically while <C-d> and <C-u>
map('n', '<C-d>', '<C-d>zz')
map('n', '<C-u>', '<C-u>zz')

-- plugins
map({ "n", "x", "o" }, "<leader>pl", ":Lazy<CR>", { desc = "Lazy" })

-- Windows
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

-- Resize windows
map("n", "<C-Up>", ":resize +2<CR>")
map("n", "<C-Down>", ":resize -2<CR>")
map("n", "<C-Left>", ":vertical resize -2<CR>")
map("n", "<C-Right>", ":vertical resize +2<CR>")

-- Diagnostics
map('n', 'gl', vim.diagnostic.open_float, { desc = "List diagnostics" })

-- :only <C-w>f <C-w>F <C-w>gf <C-w>gF <C-w>= <C-w>+ <C-w>- <C-w>> <C-w>< <C-w>_ <C-w>| <C-w>x
-- todo read about tags
-- map("n", "gp", "<C-w>}")

map("n", "<leader>q", ":q<CR>")
map("n", "<leader>C", function()
  local file_path = vim.fn.expand('%:p')
  local line_number = vim.fn.line('.')
  local column_number = vim.fn.col('.')
  local command = 'code ' .. vim.fn.getcwd() .. ' --goto ' .. file_path .. ':' .. line_number .. ':' .. column_number
  vim.fn.system(command)
end, { desc = "open file in vscode" })

vim.api.nvim_create_user_command("CopyPath", function()
  local path = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd()
  path = path:sub(#cwd + 2) .. ":" .. vim.fn.line(".")
  vim.fn.setreg("+", path)
  vim.notify('Copied "' .. path .. '" to the clipboard!')
end, {})

-- Smarter delete
map("n", "dd", function()
  if vim.api.nvim_get_current_line():match("^%s*$") then
    return "\"_dd"
  else
    return "dd"
  end
end, { noremap = true, expr = true })

-- makes * and # act on whole selection in visual mode ("very nomagic")
-- allows to easily find weird strings like /*foo*/
vim.cmd([[
function! g:VSetSearch(cmdtype)
  let temp = @s
  norm! gv"sy
  let @/ = '\V' . substitute(escape(@s, a:cmdtype.'\'), '\n', '\\n', 'g')
  let @s = temp
endfunction
xnoremap * :<c-u>call g:VSetSearch('/')<cr>/<c-r>=@/<cr><cr>
xnoremap # :<c-u>call g:VSetSearch('?')<cr>?<c-r>=@/<cr><cr>
]])
