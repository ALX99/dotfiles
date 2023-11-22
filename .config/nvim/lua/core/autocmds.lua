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
vim.api.nvim_create_autocmd("BufWritePre", {
  group = vim.api.nvim_create_augroup("autoformat", { clear = true }),
  callback = function(info)
    if vim.o.filetype == "sh" then
      if vim.fn.executable('shfmt') ~= 1 then
        return true -- delete the autocmd
      end

      vim.cmd(":w") -- Can't be bothered to figure out the piping yet
      local job = vim.fn.jobstart("shfmt -i=2 -s " .. info.file, {
        stdout_buffered = true,
        stderr_buffered = true,
        on_stdout = function(_, data)
          if data and data[1] ~= '' then
            vim.api.nvim_buf_set_lines(info.buf, 0, -1, true, data)
          end
        end,
        on_stderr = function(_, data)
          if data and data[1] == '' then
            return
          end
          vim.notify("shfmt failed", vim.log.levels.ERROR)
        end
      })
      vim.fn.jobwait({ job })
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
