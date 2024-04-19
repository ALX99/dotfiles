local utils = require('core.utils')

-- Create an augroup that is used for managing our formatting autocmds.
-- We need one augroup per client to make sure that multiple clients
-- can attach to the same buffer without interfering with each other.
local _augroups = {}

local function get_augroup(client, prefix)
  if not _augroups[client.id] then
    local group_name = prefix .. '-' .. client.name
    local id = vim.api.nvim_create_augroup(group_name, { clear = true })
    _augroups[client.id] = id
  end

  return _augroups[client.id]
end

local function mappings(buf)
  local map = function(mode, lhs, rhs, opts)
    local options = { buffer = buf }
    if opts then
      options = vim.tbl_extend("force", options, opts)
    end
    utils.map(mode, lhs, rhs, opts)
  end

  -- See `:help vim.lsp.*` for documentation on any of the below functions
  map('n', 'gD', vim.lsp.buf.declaration, { desc = "Go to declaration" })                     -- Many LSPs do not implement this
  map('n', 'gd', '<cmd>Telescope lsp_definitions<CR>', { desc = "Go to definition" })         -- vim.lsp.buf.definition
  map('n', 'gi', '<cmd>Telescope lsp_implementations<CR>', { desc = "Go to implementation" }) -- vim.lsp.buf.implementation
  map('n', 'go', vim.lsp.buf.type_definition, { desc = "Go to type definition" })
  map('n', 'gr', '<cmd>Telescope lsp_references<CR>', { desc = "Go to reference" })           -- vim.lsp.buf.references
  map('n', 'gs', '<cmd>Telescope lsp_document_symbols<CR>', { desc = "Goto symbol" })
  map('n', 'gS', '<cmd>Telescope lsp_dynamic_workspace_symbols<CR>', { desc = "Goto symbol" })
  map('n', 'gm', '<cmd>Telescope lsp_document_symbols symbols=method<CR>', { desc = "Goto method" })
  map('n', 'gf', '<cmd>Telescope lsp_document_symbols symbols=function<CR>', { desc = "Goto function" })
  map('n', 'K', vim.lsp.buf.hover, { desc = "Hover" })
  -- map('n', 'gs', vim.lsp.buf.signature_help, { desc = "Signature help" })
  map('n', 'gt', vim.lsp.buf.type_definition, { desc = "Go to type definition" })
  map('n', '<leader>rn', vim.lsp.buf.rename, { desc = "Rename" })
  map({ 'n', 'v' }, '<leader>ca', vim.lsp.buf.code_action, { desc = "Code action" })
  map({ 'n', 'v' }, '=', function()
    vim.lsp.buf.format { async = true }
  end, { desc = "Format file" })

  -- map('n', '<leader>wa', vim.lsp.buf.add_workspace_folder)
  -- map('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder)
  -- map('n', '<leader>wl', function()
  --   print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
  -- end)
end


local function highlight_references(client, buf)
  -- https://sbulav.github.io/til/til-neovim-highlight-references/
  if client.server_capabilities.documentHighlightProvider then
    vim.notify_once("Highlight references provided by " .. client.name, vim.log.levels.INFO)

    vim.api.nvim_create_autocmd("CursorHold", {
      desc = "Document Highlight",
      callback = function() vim.schedule(vim.lsp.buf.document_highlight) end,
      group = get_augroup(client, 'lsp-show-references'),
      buffer = buf,
    })
    vim.api.nvim_create_autocmd("CursorMoved", {
      desc = "Clear All the References",
      callback = function() vim.schedule(vim.lsp.buf.clear_references) end,
      group = get_augroup(client, 'lsp-show-references'),
      buffer = buf,
    })
  end
end

local function formatting(client, buf)
  if client.server_capabilities.documentFormattingProvider then
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

        vim.lsp.buf.format({
          filter = function(c)
            return c.name == "lua_ls"
                or c.name == "gopls"
                or c.name == "rust_analyzer"
                or c.name == "robotframework_ls"
                or c.name == "html"
                or c.name == "clangd"
                or c.name == "tsserver"
                or c.name == "gleam"
                or c.name == "nim_langserver"
          end,
        })
        vim.fn.winrestview(view) -- reset view to where it was before
      end,
      group = get_augroup(client, 'lsp-format'),
      buffer = buf,
    })
  end
end

vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(args)
    local path = vim.api.nvim_buf_get_name(args.buf)
    local filename = vim.fn.fnamemodify(path, ":t")
    local client = vim.lsp.get_client_by_id(args.data.client_id)

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
    -- end workaround

    mappings(args.buf)
    highlight_references(client, args.buf)
    formatting(client, args.buf)
  end,
  group = vim.api.nvim_create_augroup('UserLspConfig', {}),
})
