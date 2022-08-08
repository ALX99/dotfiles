local utils_ok, utils = pcall(require, 'alx99.utils')
if not utils_ok then
  vim.notify("Could not load utils", vim.log.levels.ERROR)
  return
end

local lspconfig_ok, lspconfig = pcall(require, 'lspconfig')
if not lspconfig_ok then
  vim.notify("Could not load lspconfig", vim.log.levels.ERROR)
  return
end

-- nvim-cmp capabiltiies to pass to lspconfig (announce what features the editor can support)
local capabilities = require('cmp_nvim_lsp').update_capabilities(vim.lsp.protocol.make_client_capabilities())


-- map('n', 'gw', ':lua vim.lsp.buf.document_symbol()<cr>')
-- map('n', 'gw', ':lua vim.lsp.buf.workspace_symbol()<cr>')

-- This is a callback function that will e executed when a
-- language server is attached to a buffer.
local on_attach = function(client, bufnr)
  -- Enable completion triggered by <c-x><c-o>
  -- vim.api.nvim_buf_set_option(bufnr, 'omnifunc', 'v:lua.vim.lsp.omnifunc')

  -- Mappings.
  -- See `:help vim.lsp.*` for documentation on any of the below functions
  local bufopts = { noremap = true, silent = true, buffer = bufnr }
  -- vim.api.nvim_buf_set_keymap(bufnr, "n", "gd", "<cmd>tab split | lua vim.lsp.buf.definition()<CR>", opts)
  utils.map('n', 'gd', vim.lsp.buf.definition, bufopts)
  utils.map('n', 'gD', vim.lsp.buf.declaration, bufopts)
  utils.map('n', 'gh', vim.lsp.buf.hover, bufopts)
  utils.map('n', 'gi', vim.lsp.buf.implementation, bufopts)
  utils.map('n', 'gs', vim.lsp.buf.signature_help, bufopts)
  utils.map('n', '<leader>wa', vim.lsp.buf.add_workspace_folder, bufopts)
  utils.map('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder, bufopts)
  utils.map('n', '<leader>wl', function()
    print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
  end, bufopts)
  utils.map('n', '<leader>D', vim.lsp.buf.type_definition, bufopts)
  utils.map('n', '<leader>rn', vim.lsp.buf.rename, bufopts)
  utils.map('n', '<leader>ca', vim.lsp.buf.code_action, bufopts)
  utils.map('n', 'gr', vim.lsp.buf.references, bufopts)
  utils.map('n', 'gf', vim.lsp.buf.formatting, bufopts)

  local sig_ok, sig = pcall(require, 'lsp_signature')
  if not sig_ok then
    vim.notify("Could not load lsp_signature", vim.log.levels.ERROR)
    return
  end

  -- https://github.com/ray-x/lsp_signature.nvim#configure
  sig.on_attach({
    bind = true, -- This is mandatory, otherwise border config won't get registered.
    floating_window = true,
    always_trigger = true,
    hint_prefix = "> ",
    handler_opts = {
      border = "rounded"
    }
  }, bufnr)

  -- todo https://sbulav.github.io/til/til-neovim-highlight-references/
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
