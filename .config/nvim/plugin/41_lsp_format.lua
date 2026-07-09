-- LSP formatting behavior
if vim.g.vscode then
  return
end

local map = require('utils').map

-- Filetype -> formatter client name
-- Listed filetypes get auto-format on save.
-- Unlisted filetypes can still manual-format with = if there is a single formatter.
local fmt = {
  lua = "lua_ls",
  go = "gopls",
  html = "html",
  css = "cssls",
  yaml = "yamlls",
  javascript = "tsgo",
  typescript = "tsgo",
  javascriptreact = "tsgo",
  typescriptreact = "tsgo",
}

local format_group = vim.api.nvim_create_augroup('lsp.format', { clear = true })

local function format_python_black(buf)
  if not vim.fn.executable('black') then
    vim.notify('black not found; install it in .venv or on PATH', vim.log.levels.WARN)
    return
  end

  local filename = vim.api.nvim_buf_get_name(buf)
  if filename == '' then filename = 'stdin.py' end

  local input = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, true), '\n')
  local output = vim.fn.systemlist({ 'black', '--quiet', '--stdin-filename', filename, '-' }, input)
  if vim.v.shell_error ~= 0 then
    vim.notify('black failed: ' .. table.concat(output, '\n'), vim.log.levels.ERROR)
    return
  end

  if #output > 0 and output[#output] ~= "" then
    output[#output + 1] = ""
  end

  -- Guard against empty output (systemlist returns {}): nvim_buf_set_lines with
  -- an empty list replaces the whole buffer with a single blank line.
  if #output > 0 then
    local view = vim.fn.winsaveview()
    vim.api.nvim_buf_set_lines(buf, 0, -1, true, output)
    vim.fn.winrestview(view)
  end
end

local function formatter_name(buf)
  local ft = vim.bo[buf].filetype
  local name = fmt[ft]
  if name then return name end

  local clients = vim.lsp.get_clients({ bufnr = buf, method = 'textDocument/formatting' })
  if #clients > 1 then
    vim.notify("Multiple formatters for " .. ft .. ", add entry to fmt table: " ..
      table.concat(vim.tbl_map(function(c) return c.name end, clients), ", "), vim.log.levels.WARN)
    return nil
  end

  return clients[1] and clients[1].name or nil
end

local function organize_go_imports(buf, client)
  local params = vim.lsp.util.make_range_params(nil, client.offset_encoding)
  params.context = { only = { 'source.organizeImports' } }
  local response, request_err = client:request_sync('textDocument/codeAction', params, 1000, buf)

  if not response or response.err then
    local err = request_err or (response and response.err)
    vim.notify("organizeImports request failed: " .. tostring(err), vim.log.levels.WARN)
    return
  end

  for _, action in ipairs(response.result or {}) do
    if action.edit then
      local ok, err = pcall(vim.lsp.util.apply_workspace_edit, action.edit, client.offset_encoding)
      if not ok then
        vim.notify("organizeImports edit failed: " .. tostring(err), vim.log.levels.WARN)
      end
    end

    if action.command then
      local command = type(action.command) == 'string' and action or action.command
      local command_response, command_err = client:request_sync('workspace/executeCommand', command, 1000, buf)
      if not command_response or command_response.err then
        local err = command_err or (command_response and command_response.err)
        vim.notify("organizeImports command failed: " .. tostring(err), vim.log.levels.WARN)
      end
    end
  end

  vim.lsp.buf.format({ bufnr = buf, name = client.name, timeout_ms = 1000, async = false })
end

local function set_format_on_save(buf, client, callback)
  local group = vim.api.nvim_create_augroup('lsp.format.' .. buf .. '.' .. client.id, { clear = true })
  _G.Config.new_autocmd('BufWritePre', {
    group = group,
    buffer = buf,
    callback = callback,
  })

  _G.Config.new_autocmd('LspDetach', {
    desc = "Remove auto-format autocmd",
    group = group,
    buffer = buf,
    callback = function(ev)
      if ev.data and ev.data.client_id == client.id then
        vim.api.nvim_del_augroup_by_name('lsp.format.' .. buf .. '.' .. client.id)
        return true
      end
    end,
  })
end

_G.Config.new_autocmd('LspAttach', {
  group = format_group,
  callback = function(args)
    local client = assert(vim.lsp.get_client_by_id(args.data.client_id))
    local buf = args.buf
    local ft = vim.bo[buf].filetype

    map({ 'n', 'v' }, '=', function()
      if vim.bo[buf].filetype == 'python' then
        format_python_black(buf)
        return
      end

      vim.lsp.buf.format({ async = true, name = formatter_name(buf) })
    end, { buffer = buf, desc = "Format file" })

    if ft == 'python' and client.name == 'pyright' then
      set_format_on_save(buf, client, function()
        format_python_black(buf)
      end)
      return
    end

    if fmt[ft] ~= client.name then return end
    if not client:supports_method('textDocument/formatting') then return end

    set_format_on_save(buf, client, function()
      if ft == 'go' then
        organize_go_imports(buf, client)
        return
      end
      vim.lsp.buf.format({ bufnr = buf, name = client.name, timeout_ms = 1000 })
    end)
  end,
})
