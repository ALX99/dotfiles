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
  group    = vim.api.nvim_create_augroup('ReturnToPos', { clear = true }),
  pattern  = '*',
  callback = function()
    if vim.fn.line("'\"") > 0 and vim.fn.line("'\"") <= vim.fn.line("$") then
      vim.fn.setpos('.', vim.fn.getpos("'\""))
      vim.api.nvim_feedkeys('zz', 'n', true)
    end
  end
})

-- https://github.com/neovim/nvim-lspconfig/issues/115
-- https://github.com/golang/tools/blob/master/gopls/doc/vim.md#neovim-imports
vim.api.nvim_create_autocmd('BufWritePre', {
  group    = vim.api.nvim_create_augroup('GoOrganizeImports', { clear = true }),
  pattern  = '*.go',
  callback = function()
    local wait_ms = 1000
    local params = vim.lsp.util.make_range_params()
    params.context = { only = { "source.organizeImports" } }
    local result = vim.lsp.buf_request_sync(0, "textDocument/codeAction", params, wait_ms)
    for _, res in pairs(result or {}) do
      for _, r in pairs(res.result or {}) do
        if r.edit then
          vim.lsp.util.apply_workspace_edit(r.edit, "UTF-8")
        else
          vim.lsp.buf.execute_command(r.command)
        end
      end
    end
  end
})

-- Highlight on yank
vim.api.nvim_create_autocmd("TextYankPost", {
  group = vim.api.nvim_create_augroup("YankHighlight", { clear = true }),
  command = "silent! lua vim.highlight.on_yank()",
})


-- Make sure :filetype is on
vim.api.nvim_create_autocmd("BufWritePre", {
  group = vim.api.nvim_create_augroup("autoformat", { clear = true }),
  callback = function(info)
    if vim.o.filetype == "sh" then
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
