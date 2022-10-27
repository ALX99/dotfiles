local utils = require('core.utils')

local tabline = utils.require('mini.tabline')
local lspconfig = utils.require('lspconfig')
local cmp_lsp = utils.require('cmp_nvim_lsp')
if not (lspconfig and cmp_lsp) then return end

-- nvim-cmp capabiltiies to pass to lspconfig (announce what features the editor can support)
local capabilities = cmp_lsp.default_capabilities()

-- map('n', 'gw', ':lua vim.lsp.buf.document_symbol()<cr>')
-- map('n', 'gw', ':lua vim.lsp.buf.workspace_symbol()<cr>')

-- This is a callback function that will e executed when a
-- language server is attached to a buffer.
local on_attach = function(client, bufnr)
  -- https://sbulav.github.io/til/til-neovim-highlight-references/
  if client.server_capabilities.documentHighlightProvider then
    local group = vim.api.nvim_create_augroup("lsp_document_highlight", { clear = true })
    vim.api.nvim_clear_autocmds({ buffer = bufnr, group = group })
    vim.api.nvim_create_autocmd("CursorHold", {
      group = group,
      callback = vim.lsp.buf.document_highlight,
      buffer = bufnr,
      desc = "Document Highlight",
    })
    vim.api.nvim_create_autocmd("CursorMoved", {
      group = group,
      callback = vim.lsp.buf.clear_references,
      buffer = bufnr,
      desc = "Clear All the References",
    })
  end



  -- Mappings.
  -- See `:help vim.lsp.*` for documentation on any of the below functions
  local bufopts = { noremap = true, silent = true, buffer = bufnr }
  utils.map('n', 'gd', '<cmd>Telescope lsp_definitions<CR>', bufopts) -- vim.lsp.buf.definition
  utils.map('n', 'gr', '<cmd>Telescope lsp_references<CR>', bufopts) -- vim.lsp.buf.references
  utils.map('n', 'gi', '<cmd>Telescope lsp_implementations<CR>', bufopts) --vim.lsp.buf.implementation
  utils.map('n', 'gt', vim.lsp.buf.type_definition, bufopts)
  --   utils.map('n', 'gD', vim.lsp.buf.declaration, bufopts) -- Many LSPs do not implement this
  utils.map('n', 'gh', vim.lsp.buf.hover, bufopts)
  --   utils.map('n', 'gs', vim.lsp.buf.signature_help, bufopts)
  utils.map('n', '<leader>wa', vim.lsp.buf.add_workspace_folder, bufopts)
  utils.map('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder, bufopts)
  utils.map('n', '<leader>wl', function()
    print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
  end, bufopts)
  utils.map('n', '<leader>rn', vim.lsp.buf.rename, bufopts)
  utils.map('n', '<leader>ca', vim.lsp.buf.code_action, bufopts)
  --   utils.map('n', 'gf', function() vim.lsp.buf.format { async = true } end, bufopts)
  utils.map({ 'n', 'v' }, '=', vim.lsp.buf.format, bufopts)


  -- Auto format
  if client.server_capabilities.documentFormattingProvider then
    -- Format before leaving insert mode
    vim.api.nvim_create_autocmd("InsertLeavePre", {
      group = vim.api.nvim_create_augroup("AutoFmtInsertLeavePre", { clear = true }),
      pattern = "*",
      callback = function()
        vim.lsp.buf.format({
          bufnr = bufnr,
          filter = function(c) return c.name == "sumneko_lua" or c.name == "gopls" end
        })
      end
    })

    -- Format before saving
    vim.api.nvim_create_autocmd("BufWritePre", {
      group = vim.api.nvim_create_augroup("AutoFmtBufWritePre", { clear = true }),
      pattern = "*",
      callback = function()
        vim.lsp.buf.format({
          bufnr = bufnr,
          name = "rust_analyzer"
        })
      end
    })

  end
end

----------------------
-- Language servers --
----------------------

-- Requires gopls
lspconfig.gopls.setup {
  capabilities = capabilities,
  on_attach = on_attach,
  settings = {
    gopls = {
      experimentalPostfixCompletions = true,
      -- https://github.com/golang/tools/blob/master/gopls/doc/analyzers.md
      analyses = {
        unusedparams = true,
        shadow = true,
        fieldalignment = true,
        nilness = true,
        unusedwrite = true,
        useany = true
      },
      staticcheck = true,
    },
  },
}

-- Requires shellcheck and https://github.com/bash-lsp/bash-language-server
lspconfig.bashls.setup {
  capabilities = capabilities,
  on_attach = on_attach,
}

-- Requires pyright
lspconfig.pyright.setup {
  capabilities = capabilities,
  on_attach = on_attach,
}

-- Requires https://github.com/rcjsuen/dockerfile-language-server-nodejs (used by the vscode docker extension)
lspconfig.dockerls.setup {
  capabilities = capabilities,
  on_attach = on_attach,
}

-- Requires rust-analyzer
lspconfig.rust_analyzer.setup {
  capabilities = capabilities,
  on_attach = on_attach,
}

-- Requires https://github.com/redhat-developer/yaml-language-server
lspconfig.yamlls.setup {
  on_attach = on_attach,
  capabilities = capabilities,
  settings = {
    yaml = {
      schemas = {
        ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
      },
    },
  },
}

lspconfig.sumneko_lua.setup {
  capabilities = capabilities,
  on_attach = on_attach,
  settings = {
    Lua = {
      runtime = {
        -- Tell the language server which version of Lua you're using (most likely LuaJIT in the case of Neovim)
        version = 'LuaJIT',
      },
      diagnostics = {
        -- Get the language server to recognize the `vim` global
        globals = { 'vim' },
      },
      workspace = {
        -- Make the server aware of Neovim runtime files
        library = {
          [vim.fn.expand "$VIMRUNTIME/lua"] = true,
          [vim.fn.expand "$VIMRUNTIME/lua/vim/lsp"] = true,
          vim.api.nvim_get_runtime_file("", true),
        }
      },
      -- Do not send telemetry data containing a randomized but unique identifier
      telemetry = { enable = false },
    },
  },
}

-- https://github.com/neovim/nvim-lspconfig/blob/master/doc/server_configurations.md#jsonls
lspconfig.jsonls.setup {
  capabilities = capabilities,
  on_attach = on_attach,
}

-- https://github.com/neovim/nvim-lspconfig/blob/master/doc/server_configurations.md#html
lspconfig.html.setup {
  capabilities = capabilities,
}

lspconfig.robotframework_ls.setup {
}

-- Setup some nicer icons for diagnostics in the gutter
local signs = { Error = " ", Warn = " ", Hint = " ", Info = " " }
for type, icon in pairs(signs) do
  local hl = "DiagnosticSign" .. type
  vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
end

vim.diagnostic.config({
  virtual_text = true,
  signs = true,
  underline = true,
  severity_sort = true, -- Errors first
})
