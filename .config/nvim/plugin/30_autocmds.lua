-- Don't auto-wrap comments and don't insert comment leader after hitting 'o'.
-- Do on `FileType` to always override these changes from filetype plugins.
_G.Config.new_autocmd('FileType', {
  desc = "Proper 'formatoptions' for all filetypes",
  callback = function() vim.cmd('setlocal formatoptions-=c formatoptions-=o') end,
})

-- Skip the rest of the autocommands if we are in VSCode
if vim.g.vscode then
  return
end


-- Check if we need to reload the file when it changed
_G.Config.new_autocmd({ "FocusGained", "TermClose", "TermLeave" }, {
  command = "checktime",
})

-- Highlight on yank
_G.Config.new_autocmd('TextYankPost', {
  callback = function()
    vim.hl.on_yank()
  end,
  pattern = '*',
})

-- resize splits if window got resized
_G.Config.new_autocmd({ "VimResized" }, {
  callback = function()
    local current_tab = vim.fn.tabpagenr()
    vim.cmd("tabdo wincmd =")
    vim.cmd("tabnext " .. current_tab)
  end,
})

-- show cursor line only in active window
_G.Config.new_autocmd({ "InsertLeave", "WinEnter" }, {
  pattern = "*",
  command = "set cursorline",
})
_G.Config.new_autocmd({ "InsertEnter", "WinLeave" }, {
  pattern = "*",
  command = "set nocursorline",
})

_G.Config.new_autocmd('FileType', {
  pattern = { 'css', 'scss', 'html', 'svelte' },
  callback = function()
    vim.opt_local.iskeyword:append('-')
  end,
})
