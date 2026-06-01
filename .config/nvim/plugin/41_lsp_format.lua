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

local format_group = vim.api.nvim_create_augroup('lsp.format', {})
local missing_black_notified = false

local function black_command(buf)
  local buf_name = vim.api.nvim_buf_get_name(buf)
  local start = buf_name ~= '' and vim.fs.dirname(buf_name) or vim.uv.cwd()
  local venv = vim.fs.find('.venv', { path = start, upward = true, type = 'directory' })[1]
  if venv then
    local black = venv .. '/bin/black'
    if vim.fn.executable(black) == 1 then return black end
  end

  if vim.fn.executable('black') == 1 then return 'black' end
end

local function format_python_black(buf)
  local black = black_command(buf)
  if not black then
    if not missing_black_notified then
      missing_black_notified = true
      vim.notify('black not found; install it in .venv or on PATH', vim.log.levels.WARN)
    end
    return
  end

  local filename = vim.api.nvim_buf_get_name(buf)
  if filename == '' then filename = 'stdin.py' end

  local input = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, true), '\n')
  local output = vim.fn.systemlist({ black, '--quiet', '--stdin-filename', filename, '-' }, input)
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

  return nil
end

local function organize_go_imports(buf, client)
  local params = vim.lsp.util.make_range_params(nil, client.offset_encoding)
  params.context = { only = { 'source.organizeImports' } }
  vim.lsp.buf_request_all(buf, 'textDocument/codeAction', params, function(results)
    for _, res in pairs(results or {}) do
      for _, action in pairs(res.result or {}) do
        if action.edit then
          vim.lsp.util.apply_workspace_edit(action.edit, client.offset_encoding)
        end
        if action.command then
          client:exec_cmd(action.command)
        end
      end
    end
    vim.lsp.buf.format({ bufnr = buf, name = client.name, timeout_ms = 1000 })
    if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].modified then
      vim.api.nvim_buf_call(buf, function()
        vim.cmd('noautocmd write')
      end)
    end
  end)
end

local function set_format_on_save(buf, client, callback)
  local group = vim.api.nvim_create_augroup('lsp.format.' .. buf, { clear = true })
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
        vim.api.nvim_del_augroup_by_name('lsp.format.' .. buf)
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
