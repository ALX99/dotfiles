if require('core.utils').is_vscodevim() then
  return
end


-- Check if we need to reload the file when it changed
vim.api.nvim_create_autocmd({ "FocusGained", "TermClose", "TermLeave" }, {
  group = vim.api.nvim_create_augroup('checktime', { clear = true }),
  command = "checktime",
})

-- Highlight on yank
vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function()
    vim.highlight.on_yank()
  end,
  group = vim.api.nvim_create_augroup('YankHighlight', { clear = true }),
  pattern = '*',
})

-- resize splits if window got resized
vim.api.nvim_create_autocmd({ "VimResized" }, {
  group = vim.api.nvim_create_augroup('resize_splits', { clear = true }),
  callback = function()
    local current_tab = vim.fn.tabpagenr()
    vim.cmd("tabdo wincmd =")
    vim.cmd("tabnext " .. current_tab)
  end,
})

vim.api.nvim_create_autocmd({ "InsertLeave" }, {
  desc = "set relativenumber",
  group = vim.api.nvim_create_augroup("setrelativenumber", { clear = true }),
  command = "set relativenumber",
})
vim.api.nvim_create_autocmd({ "InsertEnter" }, {
  desc = "set number",
  group = vim.api.nvim_create_augroup("setnumber", { clear = true }),
  command = "set number norelativenumber",
})


-- show cursor line only in active window
local cursorGrp = vim.api.nvim_create_augroup("CursorLine", { clear = true })
vim.api.nvim_create_autocmd({ "InsertLeave", "WinEnter" }, {
  group = cursorGrp,
  pattern = "*",
  command = "set cursorline",
})
vim.api.nvim_create_autocmd({ "InsertEnter", "WinLeave" }, {
  pattern = "*",
  command = "set nocursorline",
  group = cursorGrp
})

-- return to last edit position when opening files
vim.api.nvim_create_autocmd('BufReadPost', {
  callback = function()
    local mark = vim.api.nvim_buf_get_mark(0, '"')
    local lcount = vim.api.nvim_buf_line_count(0)
    if mark[1] > 0 and mark[1] <= lcount then
      pcall(vim.api.nvim_win_set_cursor, 0, mark)
    end
  end,
})

-- Make sure :filetype is on
vim.api.nvim_create_autocmd("BufWritePost", {
  group = vim.api.nvim_create_augroup("shfmt-autofmt", { clear = true }),
  callback = function(info)
    if vim.o.filetype == "sh" then
      if vim.fn.executable('shfmt') ~= 1 then
        return true -- delete the autocmd
      end

      local output = vim.fn.systemlist("shfmt -i=2 -s " .. info.file)
      if vim.v.shell_error ~= 0 then
        local error_message = "shfmt failed: " .. table.concat(output, "\n")
        vim.notify(error_message, vim.log.levels.ERROR)
        return
      end

      if #output > 0 then
        vim.api.nvim_buf_set_lines(info.buf, 0, -1, true, output)
      end
      vim.cmd(":w")
    end
  end
})


-- Automatically update listchars to match indentation and listchars settings
-- https://www.reddit.com/r/neovim/comments/17aponn/comment/k5f2n7t/?utm_source=share&utm_medium=web2x&context=3
local function update_lead()
  local lcs = vim.opt_local.listchars:get()
  local tab = vim.fn.str2list(lcs.tab)
  local space = vim.fn.str2list(lcs.multispace or lcs.space)
  local lead = { tab[1] }
  for i = 1, vim.bo.tabstop - 1 do
    lead[#lead + 1] = space[i % #space + 1]
  end
  vim.opt_local.listchars:append({ leadmultispace = vim.fn.list2str(lead) })
end
vim.api.nvim_create_autocmd("OptionSet", { pattern = { "listchars", "tabstop", "filetype" }, callback = update_lead })
vim.api.nvim_create_autocmd("VimEnter", { callback = update_lead, once = true })
