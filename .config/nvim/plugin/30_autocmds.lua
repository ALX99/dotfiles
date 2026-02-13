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
    vim.highlight.on_yank()
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
_G.Config.new_autocmd("BufWritePre", {
  callback = function(info)
    if vim.bo[info.buf].filetype == "sh" then
      if vim.fn.executable('shfmt') ~= 1 then
        return true -- delete the autocmd
      end

      local original_lines = vim.api.nvim_buf_get_lines(info.buf, 0, -1, true)
      local input = table.concat(original_lines, "\n")
      local output = vim.fn.systemlist({ "shfmt", "-i", "2", "-s" }, input)
      if vim.v.shell_error ~= 0 then
        local error_message = "shfmt failed: " .. table.concat(output, "\n")
        vim.notify(error_message, vim.log.levels.ERROR)
        return
      end

      if #output > 0 and #output ~= #original_lines then
        vim.notify("shfmt output line count mismatch", vim.log.levels.ERROR)
        return
      end
      if #output > 0 then
        vim.api.nvim_buf_set_lines(info.buf, 0, -1, true, output)
      end
    end
  end
})

_G.Config.new_autocmd("BufWritePre", {
  pattern = "*.go",
  callback = function()
    local clients = vim.lsp.get_clients({ bufnr = 0 })
    local position_encoding = (clients[1] and clients[1].offset_encoding) or 'utf-16'
    local params = vim.lsp.util.make_range_params(nil, position_encoding)
    params.context = { only = { "source.organizeImports" } }
    local result = vim.lsp.buf_request_sync(0, "textDocument/codeAction", params, 5000)
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
_G.Config.new_autocmd("OptionSet", { pattern = { "listchars", "tabstop", "filetype" }, callback = update_lead })
_G.Config.new_autocmd("VimEnter", { callback = update_lead, once = true })
