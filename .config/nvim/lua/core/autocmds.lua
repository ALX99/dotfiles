if require('core.utils').is_vscodevim() then
  return
end

local function get_session_file()
  local pattern = "/"
  if vim.fn.has("win32") == 1 then
    pattern = "[\\:]"
  end
  return vim.fn.expand(vim.fn.stdpath("state") .. "/sessions/")
      .. vim.fn.getcwd():gsub(pattern, "%%") .. ".vim"
end

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

local sessionGrp = vim.api.nvim_create_augroup("auto_sessions", { clear = true })
vim.api.nvim_create_autocmd("VimEnter", {
  desc = "Restores the previous session",
  callback = function()
    local session = get_session_file()
    if vim.fn.argc() == 0 and vim.fn.filereadable(session) ~= 0 then
      vim.cmd("silent! source " .. vim.fn.fnameescape(session))
    end
    return true -- Delete the autocmd (only needs to run once)
  end,
  group = sessionGrp,
  nested = true,
})
vim.api.nvim_create_autocmd("VimLeavePre", {
  desc = "Saves the session",
  callback = function()
    if vim.fn.argc() == 0 and vim.fn.getcwd() ~= vim.env.HOME then
      vim.cmd("mks! " .. vim.fn.fnameescape(get_session_file()))
    end
    return true -- Delete the autocmd (only needs to run once)
  end,
  group = sessionGrp
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
vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function()
    vim.highlight.on_yank()
  end,
  group = vim.api.nvim_create_augroup('YankHighlight', { clear = true }),
  pattern = '*',
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
