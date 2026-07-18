-- LSP attach behavior
if vim.g.vscode then
  return
end

local map = require('utils').map

local UserLspConfig = vim.api.nvim_create_augroup('UserLspConfig', { clear = true })
local Methods = vim.lsp.protocol.Methods

local lsp_picker_layout = {
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
}

---@param client vim.lsp.Client
---@param buf number
local function mappings(client, buf)
  local Snacks = require("snacks")
  local bmap = function(mode, lhs, rhs, opts)
    local options = { buffer = buf }
    if opts then options = vim.tbl_extend("force", options, opts) end
    map(mode, lhs, rhs, options)
  end

  bmap('n', 'gri', function()
    local pattern = vim.bo.filetype == "go" and "!_test.go" or nil
    Snacks.picker.lsp_implementations({ layout = lsp_picker_layout, focus = "list", pattern = pattern })
  end, { desc = "Go to implementation" }) -- vim.lsp.buf.implementation
  bmap('n', 'grr', function()
    Snacks.picker.lsp_references({ layout = lsp_picker_layout, focus = "list" })
  end, { desc = "Go to reference" }) -- vim.lsp.buf.references
  bmap('n', 'gS', Snacks.picker.lsp_workspace_symbols, { desc = "Goto workspace symbols" })

  bmap('n', 'gD', vim.lsp.buf.declaration, { desc = "Go to declaration" })      -- Many LSPs do not implement this
  bmap('n', 'gd', Snacks.picker.lsp_definitions, { desc = "Go to definition" }) -- vim.lsp.buf.definition
  bmap('n', 'gs', Snacks.picker.lsp_symbols, { desc = "Goto symbols" })

  bmap('n', 'grx', vim.lsp.codelens.run, { desc = 'Run codelens' })

  bmap('n', 'gai', function()
    Snacks.picker.lsp_incoming_calls({ layout = lsp_picker_layout, focus = "list" })
  end, { desc = "C[a]lls Incoming" })
  bmap('n', 'gao', function()
    Snacks.picker.lsp_outgoing_calls({ layout = lsp_picker_layout, focus = "list" })
  end, { desc = "C[a]lls Outgoing" })

  if client:supports_method(Methods.textDocument_inlayHint) then
    bmap('n', '<leader>th', function()
      local filter = { bufnr = buf }
      vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled(filter), filter)
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
    local filter = { bufnr = buf }
    vim.diagnostic.enable(not vim.diagnostic.is_enabled(filter), filter)
  end, { desc = 'Toggle diagnostics' })
end

---@param client vim.lsp.Client
---@param buf number
local function highlight_references(client, buf)
  if not client:supports_method(Methods.textDocument_documentHighlight) then return end
  if vim.b[buf].lsp_highlight_setup then return end
  vim.b[buf].lsp_highlight_setup = true

  local group = vim.api.nvim_create_augroup('lsp-highlight-' .. buf, { clear = true })
  _G.Config.new_autocmd('CursorHold', {
    desc = "Document Highlight",
    buffer = buf,
    group = group,
    callback = vim.lsp.buf.document_highlight,
  })

  _G.Config.new_autocmd({ 'CursorMoved', 'BufLeave' }, {
    desc = "Clear All the References",
    buffer = buf,
    group = group,
    callback = vim.lsp.buf.clear_references,
  })

end

_G.Config.new_autocmd('LspAttach', {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)

    if not client then
      vim.notify("LspAttach: client " .. args.data.client_id .. " not found", vim.log.levels.INFO)
      return
    end
    mappings(client, args.buf)
    highlight_references(client, args.buf)
  end,
  group = UserLspConfig,
})
