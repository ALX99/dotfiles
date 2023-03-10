return {
  "neovim/nvim-lspconfig",
  dependencies = { "hrsh7th/cmp-nvim-lsp" },
  config = function()
    local utils = require('core.utils')

    local lspconfig = require('lspconfig')
    local cmp_lsp = require('cmp_nvim_lsp')

    -- nvim-cmp capabiltiies to pass to lspconfig (announce what features the editor can support)
    local capabilities = vim.tbl_deep_extend(
      'force',
      lspconfig.util.default_config.capabilities,
      cmp_lsp.default_capabilities()
    )

    -- map('n', 'gw', ':lua vim.lsp.buf.document_symbol()<cr>')
    -- map('n', 'gw', ':lua vim.lsp.buf.workspace_symbol()<cr>')

    -- This is a callback function that will e executed when a
    -- language server is attached to a buffer.
    local on_attach = function(client, bufnr)
      -- https://sbulav.github.io/til/til-neovim-highlight-references/
      if client.server_capabilities.documentHighlightProvider then
        local id = vim.api.nvim_create_augroup("lsp_document_highlight", { clear = true })
        vim.api.nvim_clear_autocmds({ buffer = bufnr, group = id })
        vim.api.nvim_create_autocmd("CursorHold", {
          group = id,
          callback = vim.lsp.buf.document_highlight,
          buffer = bufnr,
          desc = "Document Highlight",
        })
        vim.api.nvim_create_autocmd("CursorMoved", {
          group = id,
          callback = vim.lsp.buf.clear_references,
          buffer = bufnr,
          desc = "Clear All the References",
        })
      end



      -- Mappings.
      -- See `:help vim.lsp.*` for documentation on any of the below functions
      local bufopts = { noremap = true, silent = true, buffer = bufnr }
      utils.map('n', 'gd', '<cmd>Telescope lsp_definitions<CR>', bufopts) -- vim.lsp.buf.definition
      utils.map('n', 'gD', vim.lsp.buf.declaration, bufopts) -- Many LSPs do not implement this
      utils.map('n', 'gi', '<cmd>Telescope lsp_implementations<CR>', bufopts) --vim.lsp.buf.implementation
      utils.map('n', 'gk', vim.lsp.buf.hover, bufopts)
      utils.map('n', 'go', vim.lsp.buf.type_definition, bufopts)
      utils.map('n', 'gr', '<cmd>Telescope lsp_references<CR>', bufopts) -- vim.lsp.buf.references
      utils.map('n', 'gs', vim.lsp.buf.signature_help, bufopts)
      utils.map('n', '<leader>wa', vim.lsp.buf.add_workspace_folder, bufopts)
      utils.map('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder, bufopts)
      utils.map('n', '<leader>wl', function()
        print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
      end, bufopts)
      utils.map('n', '<leader>rn', vim.lsp.buf.rename, bufopts)
      utils.map('n', '<leader>ca', vim.lsp.buf.code_action, bufopts)
      utils.map('x', '<leader>ca', vim.lsp.buf.range_code_action, bufopts)
      utils.map({ 'n', 'v' }, '=', vim.lsp.buf.format, bufopts)


      utils.map('n', 'gl', vim.diagnostic.open_float, bufopts)
      utils.map('n', '[d', vim.diagnostic.goto_prev, bufopts)
      utils.map('n', ']d', vim.diagnostic.goto_next, bufopts)
      -- utils.map('n', '<space>a', vim.diagnostic.setloclist, bufopts)


      -- Auto format before saving
      if client.server_capabilities.documentFormattingProvider then
        vim.api.nvim_create_autocmd("BufWritePre", {
          group = vim.api.nvim_create_augroup("AutoFmtBufWritePre", { clear = true }),
          pattern = "*",
          callback = function()
            vim.lsp.buf.format({
              filter = function(c)
                return c.name == "lua_ls"
                    or c.name == "gopls"
                    or c.name == "rust_analyzer"
                    or c.name == "robotframework_ls"
              end
            })
          end
        })
      end
    end

    -- https://github.com/neovim/nvim-lspconfig
    local lsps = {
      pyright = {},
      dockerls = {},
      rust_analyzer = {},
      jsonls = {},
      html = {},
      robotframework_ls = {},
    }

    for name, _ in pairs(lsps) do
      lspconfig[name].setup({
        capabilities = capabilities,
        on_attach = on_attach,
      })
    end

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
            fieldalignment = false,
            nilness = true,
            unusedwrite = true,
            useany = true
          },
          staticcheck = true,
        },
      },
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

    lspconfig.lua_ls.setup {
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

    -- Setup some nicer icons for diagnostics in the gutter
    local signs = { Error = " ", Warn = " ", Hint = " ", Info = " " }
    for type, icon in pairs(signs) do
      local hl = "DiagnosticSign" .. type
      vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
    end

    vim.diagnostic.config({
      virtual_text = true,
      signs = true,
      --       underline = true,
      severity_sort = true, -- Errors first
      float = { border = 'rounded' },
    })

    vim.lsp.handlers['textDocument/hover'] = vim.lsp.with(
      vim.lsp.handlers.hover,
      { border = 'rounded' }
    )

    vim.lsp.handlers['textDocument/signatureHelp'] = vim.lsp.with(
      vim.lsp.handlers.signature_help,
      { border = 'rounded' }
    )
  end,
}
