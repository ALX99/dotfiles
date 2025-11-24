if vim.g.vscode then
  return
end

local autocmd = vim.api.nvim_create_autocmd

local augroup = function(name, args)
  return vim.api.nvim_create_augroup('local_' .. name, args)
end


-- Check if we need to reload the file when it changed
autocmd({ "FocusGained", "TermClose", "TermLeave", "CursorHold" }, {
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

-- show cursor line only in active window
-- local cursorGrp = augroup("CursorLine", { clear = true })
-- autocmd({ "InsertLeave", "WinEnter" }, {
--   group = cursorGrp,
--   pattern = "*",
--   command = "set cursorline",
-- })
-- autocmd({ "InsertEnter", "WinLeave" }, {
--   pattern = "*",
--   command = "set nocursorline",
--   group = cursorGrp
-- })


-- Format shell scripts on save without re-triggering write
autocmd("BufWritePre", {
  group = augroup("shfmt-autofmt", { clear = true }),
  callback = function(info)
    if vim.bo[info.buf].filetype == "sh" then
      if vim.fn.executable('shfmt') ~= 1 then
        return true -- delete the autocmd
      end

      local filepath = vim.api.nvim_buf_get_name(info.buf)
      local output = vim.fn.systemlist({ "shfmt", "-i", "2", "-s", filepath })
      if vim.v.shell_error ~= 0 then
        local error_message = "shfmt failed: " .. table.concat(output, "\n")
        vim.notify(error_message, vim.log.levels.ERROR)
        return
      end

      if #output > 0 then
        vim.api.nvim_buf_set_lines(info.buf, 0, -1, true, output)
      end
    end
  end
})

autocmd("BufWritePre", {
  pattern = "*.go",
  callback = function()
    local clients = vim.lsp.get_clients({ bufnr = 0 })
    local position_encoding = (clients[1] and clients[1].offset_encoding) or 'utf-16'
    local params = vim.lsp.util.make_range_params(nil, position_encoding)
    params.context = { only = { "source.organizeImports" } }
    local result = vim.lsp.buf_request_sync(0, "textDocument/codeAction", params, 1000)
    for _, res in pairs(result or {}) do
      for _, action in pairs(res.result or {}) do
        if action.edit then
          vim.lsp.util.apply_workspace_edit(action.edit, "utf-8")
        end
      end
    end
  end,
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
