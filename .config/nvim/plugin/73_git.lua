if vim.g.vscode then return end

vim.pack.add({
  'https://github.com/FabijanZulj/blame.nvim',
})

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

-- blame.nvim
require('blame').setup({
  commit_detail_view = function(commit_hash, _, file_path)
    if vim.fn.filereadable(file_path) == 0 then
      vim.notify("File is not readable on disk: " .. file_path, vim.log.levels.ERROR)
      return
    end

    -- ponytail: scope by path when the file existed at this commit;
    -- fall back to the full commit when it didn't (rename source or
    -- pre-creation), so delta shows the rename via git -M instead of
    -- a blank buffer. Assumes nvim's cwd is the repo root; the
    -- fallback still works if not.
    local rel = vim.fn.fnamemodify(file_path, ":.")
    local scoped = vim.system({ "git", "cat-file", "-e", commit_hash .. ":" .. rel }, { text = true }):wait().code == 0
    local cmd = scoped
        and string.format("git show %s -- %s | delta --paging never", commit_hash, vim.fn.shellescape(rel))
        or string.format("git show %s | delta --paging never", commit_hash)

    -- tabnew gives a fresh unmodified buffer for term=true; q closes
    -- the tab in both t mode (during the pipeline) and n mode (after
    -- delta exits and the buffer becomes terminal-normal)
    vim.cmd('tabnew')
    vim.fn.jobstart(cmd, { term = true })
    vim.keymap.set('t', 'q', '<C-\\><C-n>:tabclose<CR>', { buffer = 0 })
    vim.keymap.set('n', 'q', ':tabclose<CR>', { buffer = 0 })
  end,
})

map('n', '<leader>Gb', ':BlameToggle<CR>', { desc = "Toggle Git blame" })
