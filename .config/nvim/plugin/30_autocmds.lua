-- Don't auto-wrap comments and don't insert comment leader after hitting 'o'.
-- Do on `FileType` to always override these changes from filetype plugins.
local f = function() vim.cmd('setlocal formatoptions-=c formatoptions-=o') end
_G.Config.new_autocmd('FileType',
  {
    callback = f,
    desc = "Proper 'formatoptions' for all filetypes",
  })

-- Skip the rest of the autocommands if we are in VSCode
if vim.g.vscode then
  return
end


-- Check if we need to reload the file when it changed
_G.Config.new_autocmd({ "FocusGained", "TermClose", "TermLeave", "CursorHold" }, {
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


-- Format shell scripts on save without re-triggering write
local function shfmt_on_save(buf)
  if vim.fn.executable('shfmt') ~= 1 then return end

  local input = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, true), "\n")
  local output = vim.fn.systemlist({ "shfmt", "-i", "2", "-s" }, input)
  if vim.v.shell_error ~= 0 then
    vim.notify("shfmt failed: " .. table.concat(output, "\n"), vim.log.levels.ERROR)
    return
  end

  if #output > 0 then
    vim.api.nvim_buf_set_lines(buf, 0, -1, true, output)
  end
end

_G.Config.new_autocmd("BufWritePre", {
  callback = function(info)
    if vim.bo[info.buf].filetype == "sh" then shfmt_on_save(info.buf) end
  end,
})

-- Go organize-imports on save is handled in 41_lsp_format.lua (combined with auto-format to avoid race conditions)


-- Automatically update listchars to match indentation and listchars settings
-- https://www.reddit.com/r/neovim/comments/17aponn/comment/k5f2n7t/?utm_source=share&utm_medium=web2x&context=3
local function update_lead()
  local lcs = vim.opt_local.listchars:get()
  local space_src = lcs.multispace or lcs.space
  if not space_src or space_src == "" then return end
  local tab = vim.fn.str2list(lcs.tab)
  local space = vim.fn.str2list(space_src)
  local lead = { tab[1] }
  for i = 1, vim.bo.tabstop - 1 do
    lead[#lead + 1] = space[i % #space + 1]
  end
  vim.opt_local.listchars:append({ leadmultispace = vim.fn.list2str(lead) })
end
_G.Config.new_autocmd("OptionSet", { pattern = { "listchars", "tabstop", "filetype" }, callback = update_lead })
_G.Config.new_autocmd("VimEnter", { callback = update_lead, once = true })
