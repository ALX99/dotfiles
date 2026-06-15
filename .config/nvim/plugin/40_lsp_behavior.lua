-- LSP attach behavior
if vim.g.vscode then
  return
end

vim.g.diagnostics_visible = true
local utils = require('utils')

local UserLspConfig = vim.api.nvim_create_augroup('UserLspConfig', { clear = true })

---@param client vim.lsp.Client
---@param buf number
local function mappings(client, buf)
  local Snacks = require("snacks")
  local bmap = function(mode, lhs, rhs, opts)
    local options = { buffer = buf }
    if opts then options = vim.tbl_extend("force", options, opts) end
    utils.map(mode, lhs, rhs, options)
  end

  -- ponytail: the layout spec is identical for every picker invocation;
  -- allocate it once at attach time instead of per keystroke.
  local picker_layout = {
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
      { win = "input",   height = 1,      border = "bottom" },
      { win = "list",    border = "none" },
      { win = "preview", title = "{preview}", height = 0.4, border = "top" },
    },
  }
  local function lsp_picker(picker_fn, opts)
    opts = opts or {}
    return function()
      picker_fn({ layout = picker_layout, focus = "list", pattern = opts.pattern })
    end
  end

  local go_test_exclude = vim.bo.filetype == "go" and "!_test.go" or nil

  -- See `:help vim.lsp.*` for documentation on any of the below functions ()
  bmap('n', 'gri', lsp_picker(Snacks.picker.lsp_implementations, { pattern = go_test_exclude }), { desc = "Go to implementation" }) -- vim.lsp.buf.implementation
  bmap('n', 'grr', lsp_picker(Snacks.picker.lsp_references), { desc = "Go to reference" })           -- vim.lsp.buf.references
  bmap('n', 'gS', Snacks.picker.lsp_workspace_symbols, { desc = "Goto workspace symbols" })

  bmap('n', 'gD', vim.lsp.buf.declaration, { desc = "Go to declaration" })      -- Many LSPs do not implement this
  bmap('n', 'gd', Snacks.picker.lsp_definitions, { desc = "Go to definition" }) -- vim.lsp.buf.definition
  bmap('n', 'gs', Snacks.picker.lsp_symbols, { desc = "Goto symbols" })

  bmap('n', 'grx', vim.lsp.codelens.run, { desc = 'Run codelens' })

  bmap('n', 'gai', lsp_picker(Snacks.picker.lsp_incoming_calls), { desc = "C[a]lls Incoming" })
  bmap('n', 'gao', lsp_picker(Snacks.picker.lsp_outgoing_calls), { desc = "C[a]lls Outgoing" })

  -- map('n', 'gs', vim.lsp.buf.signature_help, { desc = "Signature help" })
  bmap('i', '<C-k>', vim.lsp.buf.signature_help, { desc = "Signature help" })

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
  if vim.b[buf].lsp_highlight_setup then return end
  if not client:supports_method(vim.lsp.protocol.Methods.textDocument_documentHighlight) then return end
  vim.b[buf].lsp_highlight_setup = true

  local group = vim.api.nvim_create_augroup('lsp-highlight-' .. buf, { clear = true })
  _G.Config.new_autocmd({ 'CursorHold', 'CursorHoldI' }, {
    desc = "Document Highlight",
    buffer = buf,
    group = group,
    callback = vim.lsp.buf.document_highlight,
  })

  _G.Config.new_autocmd({ 'CursorMoved', 'CursorMovedI', 'BufLeave' }, {
    desc = "Clear All the References",
    buffer = buf,
    group = group,
    callback = vim.lsp.buf.clear_references,
  })

  _G.Config.new_autocmd('LspDetach', {
    desc = "Remove highlight autocmds",
    group = UserLspConfig,
    buffer = buf,
    callback = function(ev)
      if not (ev.data and ev.data.client_id == client.id) then return end
      vim.lsp.buf.clear_references()
      vim.api.nvim_del_augroup_by_name('lsp-highlight-' .. buf)
      vim.b[buf].lsp_highlight_setup = nil
      return true
    end,
  })
end

---@param client vim.lsp.Client
---@param buf number
local function show_diagnostics(client, buf)
  if vim.b[buf].lsp_diagnostics_float_setup then return end
  vim.b[buf].lsp_diagnostics_float_setup = true

  local group = vim.api.nvim_create_augroup('lsp-diag-hold-' .. buf, { clear = true })
  _G.Config.new_autocmd("CursorHold", {
    group = group,
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

  _G.Config.new_autocmd('LspDetach', {
    desc = "Remove diagnostics float autocmd",
    group = UserLspConfig,
    buffer = buf,
    callback = function(ev)
      if not (ev.data and ev.data.client_id == client.id) then return end
      vim.api.nvim_del_augroup_by_name('lsp-diag-hold-' .. buf)
      vim.b[buf].lsp_diagnostics_float_setup = nil
      return true
    end,
  })
end

_G.Config.new_autocmd('LspAttach', {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)

    if not client then
      vim.notify("LspAttach: client " .. args.data.client_id .. " not found", vim.log.levels.INFO)
      return
    end



    -- Taken from https://neovim.io/doc/user/lsp.html :h lsp
    -- Only set the LSP funcs when the option is empty/default; otherwise
    -- we'd clobber a user-customized tagfunc/formatexpr every time a
    -- client attaches. server_capabilities is optional on the client type
    -- (it's nil pre-initialize) so guard that too.
    local caps = client.server_capabilities or {}
    if caps.definitionProvider and vim.bo[args.buf].tagfunc == '' then
      vim.bo[args.buf].tagfunc = "v:lua.vim.lsp.tagfunc"
    end
    if caps.documentFormattingProvider and vim.bo[args.buf].formatexpr == '' then
      vim.bo[args.buf].formatexpr = "v:lua.vim.lsp.formatexpr()"
    end

    mappings(client, args.buf)
    highlight_references(client, args.buf)
    show_diagnostics(client, args.buf)
  end,
  group = UserLspConfig,
})
