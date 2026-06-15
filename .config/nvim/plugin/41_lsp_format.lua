-- LSP formatting behavior
if vim.g.vscode then
  return
end

local utils = require('utils')

-- Filetype -> formatter client name
-- Listed filetypes get auto-format on save.
-- Unlisted filetypes can still manual-format with = if there is a single formatter.
local fmt = {
  lua = "lua_ls",
  go = "gopls",
  html = "html",
  javascript = "tsgo",
  typescript = "tsgo",
  javascriptreact = "tsgo",
  typescriptreact = "tsgo",
}

local format_group = vim.api.nvim_create_augroup('lsp.format', { clear = true })

local function format_python_black(buf)
  if vim.fn.executable('black') ~= 1 then
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

  vim.api.nvim_buf_set_lines(buf, 0, -1, true, output)
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
  local results, err = vim.lsp.buf_request_sync(buf, 'textDocument/codeAction', params, 1000)
  if not results then
    vim.notify("organizeImports request failed: " .. tostring(err), vim.log.levels.WARN)
    return
  end
  for _, res in pairs(results) do
    for _, action in pairs(res.result or {}) do
      if action.edit then
        local ok, e = pcall(vim.lsp.util.apply_workspace_edit, action.edit, client.offset_encoding)
        if not ok then
          vim.notify("organizeImports edit failed: " .. tostring(e), vim.log.levels.WARN)
        end
      end
      if action.command then
        client:exec_cmd(action.command)
      end
    end
  end
  if vim.api.nvim_buf_is_valid(buf) then
    vim.lsp.buf.format({ bufnr = buf, name = client.name, timeout_ms = 1000 })
  end
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
    group = format_group,
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

    utils.map({ 'n', 'v' }, '=', function()
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
