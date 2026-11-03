if vim.g.vscode then return end

local map = require('utils').map
local gitgud = require('custom.gitgud')

local function with_visual_range(callback)
  return function()
    local start_line = vim.fn.line("v")
    local end_line = vim.fn.line(".")
    if end_line < start_line then start_line, end_line = end_line, start_line end
    callback({ start_line = start_line, end_line = end_line })
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
  end
end

map('n', '<leader>Gl', function() gitgud.copy_github_permalink() end, { desc = "Copy GitHub permalink" })
map('x', '<leader>Gl', with_visual_range(gitgud.copy_github_permalink), { desc = "Copy GitHub permalink (range)" })

map('n', '<leader>Go', function() gitgud.open_github_file() end, { desc = "Open GitHub file" })
map('x', '<leader>Go', with_visual_range(gitgud.open_github_file), { desc = "Open GitHub file (range)" })

vim.api.nvim_create_user_command('BlameToggle', function()
  require('custom.blame').toggle()
end, { desc = 'Toggle left-side Git blame' })
map('n', '<leader>Gb', '<cmd>BlameToggle<CR>', { desc = "Toggle Git blame" })
map('n', '<leader>GB', '<cmd>BlameToggle<CR>', { desc = "Toggle Git blame" })
