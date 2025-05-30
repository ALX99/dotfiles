vim.g.diagnostics_visible = true
local utils = require('core.utils')

local auto_fmt_clients = {
  "lua_ls",
  "gopls",
  "rust_analyzer",
  "robotframework_ls",
  "html",
  "clangd",
  "ts_ls",
  "gleam",
  "nim_langserver",
}

-- Create an augroup that is used for managing our formatting autocmds.
-- We need one augroup per client to make sure that multiple clients
-- can attach to the same buffer without interfering with each other.
local _augroups = {}

local function get_augroup(client, prefix)
  if not _augroups[client.id] then
    local group_name = prefix .. '-' .. client.name
    local id = vim.api.nvim_create_augroup(group_name, {})
    _augroups[client.id] = id
  end

  return _augroups[client.id]
end

---@param client vim.lsp.Client
---@param buf number
local function mappings(client, buf)
  local bmap = function(mode, lhs, rhs, opts)
    local options = { buffer = buf }
    if opts then options = vim.tbl_extend("force", options, opts) end
    utils.map(mode, lhs, rhs, options)
  end

  -- See `:help vim.lsp.*` for documentation on any of the below functions ()
  bmap('n', 'gD', vim.lsp.buf.declaration, { desc = "Go to declaration" })                          -- Many LSPs do not implement this
  bmap('n', 'gd', require('snacks').picker.lsp_definitions, { desc = "Go to definition" })          -- vim.lsp.buf.definition
  bmap('n', 'gri', require('snacks').picker.lsp_implementations, { desc = "Go to implementation" }) -- vim.lsp.buf.implementation
  -- { show_line = false }
  bmap('n', 'grr', require('snacks').picker.lsp_references, { desc = "Go to reference" })           -- vim.lsp.buf.references
  bmap('n', 'gt', require('snacks').picker.lsp_type_definitions, { desc = "Go to type definition" })

  bmap('n', 'gs', require('snacks').picker.lsp_symbols, { desc = "Goto symbols" })
  bmap('n', 'gS', require('snacks').picker.lsp_workspace_symbols, { desc = "Goto workspace symbols" })

  -- map('n', 'gs', vim.lsp.buf.signature_help, { desc = "Signature help" })
  bmap('i', '<C-k>', vim.lsp.buf.signature_help, { desc = "Signature help" })

  --
  bmap({ 'n', 'v' }, '=', function()
    vim.lsp.buf.format { async = true }
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
    -- only needs one augroup
    group = vim.api.nvim_create_augroup('lsp-diag-hold', {}),
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

---@param client vim.lsp.Client
---@param buf number
local function formatting(client, buf)
  if client:supports_method(vim.lsp.protocol.Methods.textDocument_formatting) then
    vim.notify_once("Formatting provided by " .. client.name, vim.log.levels.INFO)

    -- Auto format before saving
    vim.api.nvim_create_autocmd("BufWritePre", {
      callback = function()
        local view = vim.fn.winsaveview() -- save view

        -- https://github.com/neovim/nvim-lspconfig/issues/115
        -- https://github.com/golang/tools/blob/master/gopls/doc/vim.md#neovim-imports
        if client.name == "gopls" then
          local params = vim.lsp.util.make_range_params()
          params.context = { only = { "source.organizeImports" } }
          -- buf_request_sync defaults to a 1000ms timeout. Depending on your
          -- machine and codebase, you may want longer. Add an additional
          -- argument after params if you find that you have to write the file
          -- twice for changes to be saved.
          -- E.g., vim.lsp.buf_request_sync(0, "textDocument/codeAction", params, 3000)
          local result = vim.lsp.buf_request_sync(0, "textDocument/codeAction", params, 5000)
          for cid, res in pairs(result or {}) do
            for _, r in pairs(res.result or {}) do
              if r.edit then
                local enc = (vim.lsp.get_client_by_id(cid) or {}).offset_encoding or "utf-16"
                vim.lsp.util.apply_workspace_edit(r.edit, enc)
              end
            end
          end
        end

        vim.lsp.buf.format({ timeout_ms = 2000 })
        vim.fn.winrestview(view) -- reset view to where it was before
      end,
      group = get_augroup(client, 'lsp-format' .. buf),
      buffer = buf,
    })
  end
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
      vim.log.levels.DEBUG)

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


    if vim.tbl_contains(auto_fmt_clients, client.name) then
      formatting(client, args.buf)
    end
  end,
  group = vim.api.nvim_create_augroup('UserLspConfig', {}),
})
