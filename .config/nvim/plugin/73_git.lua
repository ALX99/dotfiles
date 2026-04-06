-- git plugins (blame.nvim, codediff.nvim, custom gitgud utils)
if vim.g.vscode then return end

vim.pack.add({
  'https://github.com/FabijanZulj/blame.nvim',
  'https://github.com/esmuellert/codediff.nvim',
})

local map = require('utils').map
local gitgud = require('custom_plugins.gitgud')

map('n', '<leader>Gl', function() gitgud.copy_github_permalink() end, { desc = "Copy GitHub permalink" })
map('x', '<leader>Gl', function()
  local start_line = vim.fn.line("v")
  local end_line   = vim.fn.line(".")
  if end_line < start_line then start_line, end_line = end_line, start_line end
  gitgud.copy_github_permalink({ start_line = start_line, end_line = end_line })
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
end, { desc = "Copy GitHub permalink (range)" })

map('n', '<leader>Go', function() gitgud.open_github_file() end, { desc = "Open GitHub file" })
map('x', '<leader>Go', function()
  local start_line = vim.fn.line("v")
  local end_line   = vim.fn.line(".")
  if end_line < start_line then start_line, end_line = end_line, start_line end
  gitgud.open_github_file({ start_line = start_line, end_line = end_line })
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
end, { desc = "Open GitHub file (range)" })

-- blame.nvim
require('blame').setup({
  commit_detail_view = function(commit_hash, _, file_path)
    if vim.fn.filereadable(file_path) == 0 then
      vim.notify("File is not readable on disk: " .. file_path, vim.log.levels.ERROR)
      return
    end

    local parent = commit_hash .. "^"
    local buf    = vim.fn.bufadd(file_path)
    vim.fn.bufload(buf)

    local ok, err = pcall(vim.api.nvim_buf_call, buf, function()
      vim.cmd(("CodeDiff file %s %s"):format(parent, commit_hash))
    end)

    if not ok then
      vim.notify("CodeDiff failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end,
})

map('n', '<leader>Gb', ':BlameToggle<CR>', { desc = "Toggle Git blame" })

-- codediff.nvim
map('n', '<leader>Gs', '<cmd>CodeDiff<cr>', { desc = "Show git status" })
