if vim.g.vscode then return end

local map = require('utils').map

local lsp_formatters = {
  lua = 'lua_ls',
  go = 'gopls',
  html = 'html',
  css = 'cssls',
  javascript = 'tsgo',
  javascriptreact = 'tsgo',
  typescript = 'tsgo',
  typescriptreact = 'tsgo',
}

local external_formatters = {
  python = function(filename)
    return { 'black', '--quiet', '--stdin-filename', filename ~= '' and filename or 'stdin.py', '-' }
  end,
  sh = function()
    return { 'shfmt', '-i', '2', '-s' }
  end,
}

local function replace_buffer(buf, lines)
  if #lines == 0 then return end
  local view = vim.fn.winsaveview()
  vim.api.nvim_buf_set_lines(buf, 0, -1, true, lines)
  vim.fn.winrestview(view)
end

local function format_external(buf, command)
  local executable = command[1]
  if vim.fn.executable(executable) == 0 then
    vim.notify(executable .. ' not found', vim.log.levels.WARN)
    return
  end

  local input = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, true), '\n')
  local output = vim.fn.systemlist(command, input)
  if vim.v.shell_error ~= 0 then
    vim.notify(executable .. ' failed: ' .. table.concat(output, '\n'), vim.log.levels.ERROR)
    return
  end

  replace_buffer(buf, output)
end

local function formatting_client(buf, notify)
  local name = lsp_formatters[vim.bo[buf].filetype]
  if name then
    local clients = vim.lsp.get_clients({
      bufnr = buf,
      method = 'textDocument/formatting',
      name = name,
    })
    if clients[1] then return clients[1] end
    if notify then vim.notify(name .. ' is not available for formatting', vim.log.levels.WARN) end
    return nil
  end

  local clients = vim.lsp.get_clients({ bufnr = buf, method = 'textDocument/formatting' })
  if #clients > 1 then
    if notify then
      vim.notify(
        'Multiple formatters for ' .. vim.bo[buf].filetype .. ': ' ..
        table.concat(vim.tbl_map(function(client) return client.name end, clients), ', '),
        vim.log.levels.WARN
      )
    end
    return nil
  end
  if not clients[1] and notify then vim.notify('No formatter available', vim.log.levels.WARN) end
  return clients[1]
end

local function organize_go_imports(buf, client)
  local params = vim.lsp.util.make_range_params(nil, client.offset_encoding)
  params.context = { only = { 'source.organizeImports' } }
  local response, request_err = client:request_sync('textDocument/codeAction', params, 1000, buf)

  if not response or response.err then
    vim.notify('organizeImports request failed: ' .. tostring(request_err or response and response.err),
      vim.log.levels.WARN)
    return
  end

  for _, action in ipairs(response.result or {}) do
    if action.edit then
      vim.lsp.util.apply_workspace_edit(action.edit, client.offset_encoding)
    end
    if action.command then
      local command = type(action.command) == 'string' and action or action.command
      client:request_sync('workspace/executeCommand', command, 1000, buf)
    end
  end
end

local function format_buffer(buf, opts)
  opts = opts or {}
  local external = external_formatters[vim.bo[buf].filetype]
  if external then
    format_external(buf, external(vim.api.nvim_buf_get_name(buf)))
    return
  end

  local client = formatting_client(buf, opts.notify)
  if not client then return end
  if vim.bo[buf].filetype == 'go' then organize_go_imports(buf, client) end
  vim.lsp.buf.format({
    bufnr = buf,
    name = client.name,
    async = false,
    timeout_ms = 1000,
  })
end

map('n', '<leader>cf', function()
  format_buffer(vim.api.nvim_get_current_buf(), { notify = true })
end, { desc = 'Format file' })

_G.Config.new_autocmd('BufWritePre', {
  group = vim.api.nvim_create_augroup('format-on-save', { clear = true }),
  callback = function(ev)
    local ft = vim.bo[ev.buf].filetype
    if external_formatters[ft] or lsp_formatters[ft] then format_buffer(ev.buf) end
  end,
})
