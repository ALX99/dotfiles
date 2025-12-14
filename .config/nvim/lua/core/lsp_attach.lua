vim.g.diagnostics_visible = true
local utils = require('core.utils')

local auto_fmt_clients = {
  "lua_ls",
  "gopls",
  "rust_analyzer",
  "html",
  "biome",
  "tsgo",
}

-- Map filetypes to their preferred formatter(s)
-- Can be a string for single formatter or a table for fallback order
-- Example: { "biome", "tsgo" } will use biome if available, else tsgo
local filetype_formatters = {
  javascript = { "biome", "tsgo" },
  typescript = { "biome", "tsgo" },
  javascriptreact = { "biome", "tsgo" },
  typescriptreact = { "biome", "tsgo" },
}

---Get the appropriate formatter for a buffer
---@param bufnr number
---@return vim.lsp.Client|nil
local function get_formatter(bufnr)
  local filetype = vim.bo[bufnr].filetype
  local formatter_pref = filetype_formatters[filetype]

  -- Get all clients that can format this buffer
  local formatters = {}
  for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
    if client:supports_method('textDocument/formatting') then
      table.insert(formatters, client)
    end
  end

  if #formatters == 0 then
    return nil
  end

  -- If a preferred formatter(s) is configured for this filetype
  if formatter_pref then
    -- Normalize to table format
    local prefs = type(formatter_pref) == 'string' and { formatter_pref } or formatter_pref

    -- Try each preferred formatter in order
    for _, pref_name in ipairs(prefs) do
      for _, client in ipairs(formatters) do
        if client.name == pref_name then
          return client
        end
      end
    end

    -- None of the preferred formatters are available
    local available_names = vim.tbl_map(function(c) return c.name end, formatters)
    error("Configured formatters '" .. table.concat(prefs, "', '") .. "' not available for " .. filetype ..
      ". Available: " .. table.concat(available_names, ", "))
  end

  -- If multiple formatters but none configured, error
  if #formatters > 1 then
    local names = vim.tbl_map(function(c) return c.name end, formatters)
    error("Multiple formatters available for " .. filetype .. ": " .. table.concat(names, ", ") ..
      ". Please configure preferred formatter in filetype_formatters")
  end

  return formatters[1]
end

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
  bmap('n', 'gt', Snacks.picker.lsp_type_definitions, { desc = "Go to type definition" })
  bmap('n', 'gs', Snacks.picker.lsp_symbols, { desc = "Goto symbols" })


  bmap('n', 'gai', lsp_picker(Snacks.picker.lsp_incoming_calls), { desc = "C[a]lls Incoming" })
  bmap('n', 'gao', lsp_picker(Snacks.picker.lsp_outgoing_calls), { desc = "C[a]lls Outgoing" })

  -- map('n', 'gs', vim.lsp.buf.signature_help, { desc = "Signature help" })
  bmap('i', '<C-k>', vim.lsp.buf.signature_help, { desc = "Signature help" })

  --
  bmap({ 'n', 'v' }, '=', function()
    local ok, formatter = pcall(get_formatter, buf)
    if not ok then
      vim.notify("Format error: " .. formatter, vim.log.levels.ERROR)
      return
    end
    if not formatter then
      vim.notify("No formatter available", vim.log.levels.WARN)
      return
    end
    vim.lsp.buf.format { async = true, id = formatter.id }
  end, { desc = "Format file" })

  if client:supports_method(vim.lsp.protocol.Methods.textDocument_inlayHint) then
    bmap('n', '<leader>th', function()
      vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({}))
    end, { desc = 'Toggle inlay hints' })
  end

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
      vim.log.levels.INFO)

    -- Taken from https://neovim.io/doc/user/lsp.html :h lsp
    if client.server_capabilities.definitionProvider then
      vim.bo[args.buf].tagfunc = "v:lua.vim.lsp.tagfunc"
    end
    if client.server_capabilities.documentFormattingProvider then
      vim.bo[args.buf].formatexpr = "v:lua.vim.lsp.formatexpr()"
    end

    -- workaround for gopls not supporting semanticTokensProvider
    -- https://github.com/golang/go/issues/54531#issuecomment-1464982242
    if client.name == "gopls" then
      if not client.server_capabilities.semanticTokensProvider then
        local semantic = client.config.capabilities.textDocument.semanticTokens
        if semantic then
          client.server_capabilities.semanticTokensProvider = {
            full = true,
            legend = {
              tokenTypes = semantic.tokenTypes,
              tokenModifiers = semantic.tokenModifiers,
            },
            range = true,
          }
        end
      end
    end
    -- end workaround

    mappings(client, args.buf)
    highlight_references(client, args.buf)
    show_diagnostics(client, args.buf)
  end,
  group = vim.api.nvim_create_augroup('UserLspConfig', {}),
})

-- Auto-format on save using the configured formatter for each filetype
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('lsp.setupautofmt', {}),
  callback = function(args)
    local client = assert(vim.lsp.get_client_by_id(args.data.client_id))
    local buf = args.buf

    if not vim.tbl_contains(auto_fmt_clients, client.name) then
      return
    end

    -- Auto-format on save using the configured formatter
    if not client:supports_method('textDocument/willSaveWaitUntil')
        and client:supports_method('textDocument/formatting') then
      vim.notify_once("Formatting provided by " .. client.name, vim.log.levels.INFO)
      vim.api.nvim_create_autocmd('BufWritePre', {
        group = vim.api.nvim_create_augroup('lsp.autofmt', { clear = false }),
        buffer = buf,
        callback = function()
          local ok, formatter = pcall(get_formatter, buf)
          if not ok then
            vim.notify("Format error: " .. formatter, vim.log.levels.ERROR)
            return
          end
          if formatter then
            vim.lsp.buf.format({ bufnr = buf, id = formatter.id, timeout_ms = 1000 })
          end
        end,
      })
    end
  end,
})
