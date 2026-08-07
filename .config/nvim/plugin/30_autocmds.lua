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

-- Herdr opens its captured scrollback in $EDITOR. Keep that disposable view
-- anchored at the newest output and make either q key close it without saving.
_G.Config.new_autocmd('VimEnter', {
  callback = function()
    local buffer = vim.api.nvim_get_current_buf()
    if vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buffer), ':t'):match('^herdr%-scrollback%-') then
      vim.keymap.set('n', 'q', '<Cmd>quit!<CR>', { buffer = buffer, nowait = true })
      vim.keymap.set('n', 'Q', '<Cmd>quit!<CR>', { buffer = buffer, nowait = true })
      vim.cmd('normal! Gzb')
    end
  end,
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
