if require('core.utils').is_vscodevim() then
  return
end

local autocmd = vim.api.nvim_create_autocmd

local augroup = function(name, args)
  return vim.api.nvim_create_augroup('local_' .. name, args)
end


-- Check if we need to reload the file when it changed
autocmd({ "FocusGained", "TermClose", "TermLeave" }, {
  group = augroup('checktime', { clear = true }),
  command = "checktime",
})

-- Highlight on yank
autocmd('TextYankPost', {
  callback = function()
    vim.highlight.on_yank()
  end,
  group = augroup('YankHighlight', { clear = true }),
  pattern = '*',
})

-- resize splits if window got resized
autocmd({ "VimResized" }, {
  group = augroup('resize_splits', { clear = true }),
  callback = function()
    local current_tab = vim.fn.tabpagenr()
    vim.cmd("tabdo wincmd =")
    vim.cmd("tabnext " .. current_tab)
  end,
})

autocmd({ "InsertLeave" }, {
  desc = "set relativenumber",
  group = augroup("setrelativenumber", { clear = true }),
  command = "set relativenumber",
})
autocmd({ "InsertEnter" }, {
  desc = "set number",
  group = augroup("setnumber", { clear = true }),
  command = "set number norelativenumber",
})


-- show cursor line only in active window
local cursorGrp = augroup("CursorLine", { clear = true })
autocmd({ "InsertLeave", "WinEnter" }, {
  group = cursorGrp,
  pattern = "*",
  command = "set cursorline",
})
autocmd({ "InsertEnter", "WinLeave" }, {
  pattern = "*",
  command = "set nocursorline",
  group = cursorGrp
})

-- return to last edit position when opening files
autocmd('BufReadPost', {
  callback = function()
    local mark = vim.api.nvim_buf_get_mark(0, '"')
    local lcount = vim.api.nvim_buf_line_count(0)
    if mark[1] > 0 and mark[1] <= lcount then
      pcall(vim.api.nvim_win_set_cursor, 0, mark)
    end
  end,
})

-- Make sure :filetype is on
autocmd("BufWritePost", {
  group = augroup("shfmt-autofmt", { clear = true }),
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

autocmd("BufReadPost", {
  desc = "Collapse error handling with one line inside",
  group = augroup("go-fold", { clear = true }),
  pattern = "*.go",
  callback = function(info)
    vim.schedule(function()
      local view = vim.fn.winsaveview() -- save view
      --[[
      1. Collapse "if err != nil" error handling with one line inside
      2. Collapse all "if ...; err != nil" error handling with one line inside
      3. Collapse "case" statements with one line inside
      4. Collapse "default" statement with one line inside
      5. Remove search highlight
      ]] --
      vim.cmd([[
      normal! zR |
      :silent exec 'g/\s*if err != nil {\n.*\n\s*}/normal! za' |
      :silent exec 'g/\s*if.*; err != nil {\n.*\n\s*}/normal! za' |
      :silent exec 'g/\s*case.*\n.*\n\s*\(case\|default\)/normal! za' |
      :silent exec 'g/\s*default.*\n.*\n\s*}/normal! za' |
      :nohl
      ]])
      vim.fn.winrestview(view) -- reset view to where it was before
    end)
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
autocmd("OptionSet", { pattern = { "listchars", "tabstop", "filetype" }, callback = update_lead })
autocmd("VimEnter", { callback = update_lead, once = true })

-- https://www.reddit.com/r/neovim/comments/1ehidxy/you_can_remove_padding_around_neovim_instance/
-- wait for require("mini.misc").setup_termbg_sync() to be fixed
vim.api.nvim_create_autocmd({ "UIEnter", "ColorScheme" }, {
  callback = function()
    local normal = vim.api.nvim_get_hl(0, { name = "Normal" })
    if not normal.bg then return end
    io.write(string.format("\027]11;#%06x\027\\", normal.bg))
  end,
})

vim.api.nvim_create_autocmd("UILeave", {
  callback = function() io.write("\027]111\027\\") end,
})
