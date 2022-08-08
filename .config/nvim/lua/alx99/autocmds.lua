-- show cursor line only in active window
local cursorGrp = vim.api.nvim_create_augroup("CursorLine", { clear = true })
vim.api.nvim_create_autocmd(
  { "InsertLeave", "WinEnter" },
  { pattern = "*", command = "set cursorline", group = cursorGrp }
)
vim.api.nvim_create_autocmd(
  { "InsertEnter", "WinLeave" },
  { pattern = "*", command = "set nocursorline", group = cursorGrp }
)

-- return to last edit position when opening files
local bufcheck = vim.api.nvim_create_augroup('bufcheck', { clear = true })
vim.api.nvim_create_autocmd(
  'BufReadPost',
  { group = bufcheck,
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
local preBufCheck = vim.api.nvim_create_augroup('prebufcheck', { clear = true })
vim.api.nvim_create_autocmd(
  'BufWritePre',
  { group = preBufCheck,
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
local yankGrp = vim.api.nvim_create_augroup("YankHighlight", { clear = true })
vim.api.nvim_create_autocmd("TextYankPost", {
  command = "silent! lua vim.highlight.on_yank()",
  group = yankGrp,
})

-- local bufEnter = vim.api.nvim_create_augroup("BufEnter", { clear = true })
-- -- Don't auto commenting new lines
-- -- https://github.com/NvChad/NvChad/blob/main/lua/core/init.lua
-- vim.api.nvim_create_autocmd("BufEnter", {
--   pattern = "*",
--   command = "set fo-=c fo-=r fo-=o",
--   group = bufEnter,
-- })
