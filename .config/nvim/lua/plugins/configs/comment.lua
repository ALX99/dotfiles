-- https://github.com/numToStr/Comment.nvim#configuration-optional
local utils_ok, utils = pcall(require, 'alx99.utils')
if not utils_ok then
  vim.notify("Could not load alx99.utils", vim.log.levels.ERROR)
  return
end

local comment_ok, comment = pcall(require, 'Comment')
if not comment_ok then
  vim.notify("Could not load Comment", vim.log.levels.ERROR)
  return
end

comment.setup{}

utils.map('n', '<leader>/',
  "v:count == 0 ? '<Plug>(comment_toggle_current_linewise)' : '<Plug>(comment_toggle_linewise_count)'",
  { expr = true, remap = true })
utils.map('v', '<leader>/', '<Plug>(comment_toggle_linewise_visual)')
