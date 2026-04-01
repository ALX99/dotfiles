-- Skip the file, vscode has its own lsps
if vim.g.vscode then
  return
end

vim.g.diagnostics_visible = true
local utils = require('utils')

-- Filetype -> formatter client name
-- Listed filetypes get auto-format on save
-- Unlisted filetypes can still manual-format with =
local fmt = {
  lua = "lua_ls",
  go = "gopls",
  rust = "rust_analyzer",
  html = "html",
  javascript = "tsgo",
  typescript = "tsgo",
  javascriptreact = "tsgo",
  typescriptreact = "tsgo",
}

---@param client vim.lsp.Client
---@param buf number
local function mappings(client, buf)
  local ok, Snacks = pcall(require, "snacks")
  if not ok then
    vim.notify("snacks.nvim not available for LSP mappings", vim.log.levels.WARN)
    return
  end
  local bmap = function(mode, lhs, rhs, opts)
    local options = { buffer = buf }
    if opts then options = vim.tbl_extend("force", options, opts) end
    utils.map(mode, lhs, rhs, options)
  end

  local default_picker_opts = {
    layout = {
      layout = {
        backdrop = false,
        width = 0.5,
        min_width = 80,
        height = 0.8,
        min_height = 30,
        box = "vertical",
        border = true,
        title = "{title} {live} {flags}",
        title_pos = "center",
        { win = "input",   height = 1,          border = "bottom" },
        { win = "list",    border = "none" },
        { win = "preview", title = "{preview}", height = 0.4,     border = "top" },
      },
    },
    focus = "list", -- Focus the list view
    pattern = "!_test.go",
  }

  -- helper to create Snacks picker functions with default options
  local function lsp_picker(picker_fn, override_opts)
    return function()
      -- Merge default options with any overrides
      local final_opts = vim.tbl_extend("force", default_picker_opts, override_opts or {})
      picker_fn(final_opts)
    end
  end

  -- See `:help vim.lsp.*` for documentation on any of the below functions ()
  bmap('n', 'gri', lsp_picker(Snacks.picker.lsp_implementations), { desc = "Go to implementation" }) -- vim.lsp.buf.implementation
  bmap('n', 'grr', lsp_picker(Snacks.picker.lsp_references), { desc = "Go to reference" })           -- vim.lsp.buf.references
  bmap('n', 'gS', Snacks.picker.lsp_workspace_symbols, { desc = "Goto workspace symbols" })

  bmap('n', 'gD', vim.lsp.buf.declaration, { desc = "Go to declaration" })      -- Many LSPs do not implement this
  bmap('n', 'gd', Snacks.picker.lsp_definitions, { desc = "Go to definition" }) -- vim.lsp.buf.definition
  bmap('n', 'gs', Snacks.picker.lsp_symbols, { desc = "Goto symbols" })

  -- builitin "grt" for type definitions, grn for rename, grx for vim.lsp.codelens.run

  bmap('n', 'gai', lsp_picker(Snacks.picker.lsp_incoming_calls), { desc = "C[a]lls Incoming" })
  bmap('n', 'gao', lsp_picker(Snacks.picker.lsp_outgoing_calls), { desc = "C[a]lls Outgoing" })

  -- map('n', 'gs', vim.lsp.buf.signature_help, { desc = "Signature help" })
  bmap('i', '<C-k>', vim.lsp.buf.signature_help, { desc = "Signature help" })

  bmap({ 'n', 'v' }, '=', function()
    local ft = vim.bo[buf].filetype
    local name = fmt[ft]
    if not name then
      local clients = vim.lsp.get_clients({ bufnr = buf, method = 'textDocument/formatting' })
      if #clients > 1 then
        vim.notify("Multiple formatters for " .. ft .. ", add entry to fmt table: " ..
          table.concat(vim.tbl_map(function(c) return c.name end, clients), ", "), vim.log.levels.WARN)
        return
      end
    end
    vim.lsp.buf.format({ async = true, name = name })
  end, { desc = "Format file" })

  if client:supports_method(vim.lsp.protocol.Methods.textDocument_inlayHint) then
    bmap('n', '<leader>th', function()
      vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({}))
    end, { desc = 'Toggle inlay hints' })
  end

  -- if client:supports_method("textDocument/completion") then
  --   vim.notify("Enabling LSP completion for client " .. client.name)
  --   vim.lsp.completion.enable(true, client.id, buf, { autotrigger = true })
  -- end

  -- map('n', '<leader>wa', vim.lsp.buf.add_workspace_folder)
  -- map('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder)
  -- map('n', '<leader>wl', function()
  --   print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
  -- end)

  --- toggle diagnostics
  bmap('n', '<leader>td', function()
    if vim.g.diagnostics_visible then
      vim.g.diagnostics_visible = false
      vim.diagnostic.enable(false)
    else
      vim.g.diagnostics_visible = true
      vim.diagnostic.enable()
    end
  end, { desc = 'Toggle diagnostics' })
end


---@param client vim.lsp.Client
---@param buf number
local function highlight_references(client, buf)
  if client:supports_method(vim.lsp.protocol.Methods.textDocument_documentHighlight) then
    -- only needs one augroup
    local highlight_augroup = vim.api.nvim_create_augroup('lsp-highlight-' .. tostring(buf), {})
    vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
      desc = "Document Highlight",
      buffer = buf,
      group = highlight_augroup,
      callback = vim.lsp.buf.document_highlight,
    })

    vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI', 'BufLeave' }, {
      desc = "Clear All the References",
      buffer = buf,
      group = highlight_augroup,
      callback = vim.lsp.buf.clear_references,
    })


    vim.api.nvim_create_autocmd('LspDetach', {
      desc = "Remove highlight autocmds",
      group = vim.api.nvim_create_augroup('lsp-detach-' .. tostring(buf), { clear = true }),
      callback = function(ev)
        vim.lsp.buf.clear_references()
        vim.api.nvim_clear_autocmds { group = highlight_augroup, buffer = ev.buf }
        return true -- delete itself
      end,
    })
  end
end

---@param client vim.lsp.Client
---@param buf number
local function show_diagnostics(client, buf)
  vim.api.nvim_create_autocmd("CursorHold", {
    group = vim.api.nvim_create_augroup('lsp-diag-hold-' .. buf, { clear = true }),
    buffer = buf,
    callback = function()
      vim.diagnostic.open_float(nil, {
        focusable = false,
        close_events = { "BufLeave", "CursorMoved", "InsertEnter", "FocusLost" },
        border = 'rounded',
        source = 'if_many',
        prefix = ' ',
        scope = 'cursor',
      })
    end
  })
end

vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(args)
    local path = vim.api.nvim_buf_get_name(args.buf)
    local filename = vim.fn.fnamemodify(path, ":t")
    local client = vim.lsp.get_client_by_id(args.data.client_id)

    if not client then
      vim.notify("????????", vim.log.levels.WARN)
      return
    end

    vim.notify("lsp_attach: " .. client.name .. " to buf " .. tostring(args.buf) .. " file " .. filename,
      vim.log.levels.TRACE)

    -- Taken from https://neovim.io/doc/user/lsp.html :h lsp
    if client.server_capabilities.definitionProvider then
      vim.bo[args.buf].tagfunc = "v:lua.vim.lsp.tagfunc"
    end
    if client.server_capabilities.documentFormattingProvider then
      vim.bo[args.buf].formatexpr = "v:lua.vim.lsp.formatexpr()"
    end

    mappings(client, args.buf)
    highlight_references(client, args.buf)
    show_diagnostics(client, args.buf)
  end,
  group = vim.api.nvim_create_augroup('UserLspConfig', {}),
})

vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('lsp.autofmt', {}),
  callback = function(args)
    local client = assert(vim.lsp.get_client_by_id(args.data.client_id))
    local buf = args.buf
    local ft = vim.bo[buf].filetype

    if fmt[ft] ~= client.name then return end
    if not client:supports_method('textDocument/formatting') then return end
    if client:supports_method('textDocument/willSaveWaitUntil') then return end

    vim.api.nvim_create_autocmd('BufWritePre', {
      group = vim.api.nvim_create_augroup('lsp.autofmt.' .. buf, {}),
      buffer = buf,
      callback = function()
        vim.lsp.buf.format({ bufnr = buf, name = client.name, timeout_ms = 1000 })
      end,
    })
  end,
})
