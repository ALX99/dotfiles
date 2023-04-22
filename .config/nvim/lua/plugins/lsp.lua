return {
  "neovim/nvim-lspconfig",
  dependencies = { "hrsh7th/cmp-nvim-lsp" },
  config = function()
    local map = require('core.utils').map
    local lspconfig = require('lspconfig')
    local cmp_lsp = require('cmp_nvim_lsp')

    -- nvim-cmp capabiltiies to pass to lspconfig (announce what features the editor can support)
    local capabilities = vim.tbl_deep_extend(
      'force',
      lspconfig.util.default_config.capabilities,
      cmp_lsp.default_capabilities()
    )

    local function mappings(buf)
      -- See `:help vim.lsp.*` for documentation on any of the below functions
      local opts = { buffer = buf }
      map('n', 'gD', vim.lsp.buf.declaration, opts)                  -- Many LSPs do not implement this
      map('n', 'gd', '<cmd>Telescope lsp_definitions<CR>', opts)     -- vim.lsp.buf.definition
      map('n', 'gk', vim.lsp.buf.hover, opts)
      map('n', 'gi', '<cmd>Telescope lsp_implementations<CR>', opts) -- vim.lsp.buf.implementation
      map('n', 'gs', vim.lsp.buf.signature_help, opts)
      map('n', '<leader>wa', vim.lsp.buf.add_workspace_folder, opts)
      map('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder, opts)
      map('n', '<leader>wl', function()
        print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
      end, opts)
      map('n', 'gt', vim.lsp.buf.type_definition, opts)
      map('n', '<leader>rn', vim.lsp.buf.rename, opts)
      map({ 'n', 'v' }, '<leader>ca', vim.lsp.buf.code_action, opts)
      map('n', 'gr', '<cmd>Telescope lsp_references<CR>', opts) -- vim.lsp.buf.references
      map({ 'n', 'v' }, '=', function()
        vim.lsp.buf.format { async = true }
      end, opts)
    end

    local function highlight_references(client, buf)
      -- https://sbulav.github.io/til/til-neovim-highlight-references/
      if client.server_capabilities.documentHighlightProvider then
        local grp = vim.api.nvim_create_augroup("lsp_document_highlight", {})
        vim.api.nvim_clear_autocmds({ group = grp, buffer = buf })
        vim.api.nvim_create_autocmd("CursorHold", {
          desc = "Document Highlight",
          callback = function() vim.schedule(vim.lsp.buf.document_highlight) end,
          group = grp,
          buffer = buf,
        })
        vim.api.nvim_create_autocmd("CursorMoved", {
          desc = "Clear All the References",
          callback = function() vim.schedule(vim.lsp.buf.clear_references) end,
          group = grp,
          buffer = buf,
        })
      end
    end

    local function formatting(client, buf)
      if client.server_capabilities.documentFormattingProvider then
        -- Auto format before saving
        vim.api.nvim_create_autocmd("BufWritePre", {
          callback = function()
            local view = vim.fn.winsaveview()
            vim.lsp.buf.format({
              filter = function(c)
                return c.name == "lua_ls"
                    or c.name == "gopls"
                    or c.name == "rust_analyzer"
                    or c.name == "robotframework_ls"
              end,
            })
            vim.fn.winrestview(view)
          end,
          group = vim.api.nvim_create_augroup("LspFormat", { clear = true }),
          buffer = buf,
        })
      end
    end

    vim.api.nvim_create_autocmd('LspAttach', {
      callback = function(ev)
        local client = vim.lsp.get_client_by_id(ev.data.client_id)

        if client.server_capabilities.definitionProvider then
          vim.bo[ev.buf].tagfunc = "v:lua.vim.lsp.tagfunc"
        end
        if client.server_capabilities.documentFormattingProvider then
          vim.bo[ev.buf].formatexpr = "v:lua.vim.lsp.formatexpr()"
        end

        mappings(ev.buf)
        highlight_references(client, ev.buf)
        formatting(client, ev.buf)
      end,
      group = vim.api.nvim_create_augroup('UserLspConfig', {}),
    })

    -----------------
    -- Diagnostics --
    -----------------

    map('n', 'gl', vim.diagnostic.open_float)
    map('n', '[d', vim.diagnostic.goto_prev)
    map('n', ']d', vim.diagnostic.goto_next)

    -- Setup some nicer icons for diagnostics in the gutter
    local signs = { Error = " ", Warn = " ", Hint = " ", Info = " " }
    for type, icon in pairs(signs) do
      local hl = "DiagnosticSign" .. type
      vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
    end

    vim.diagnostic.config({
      virtual_text = true,
      underline = true,
      update_in_insert = false,
      severity_sort = true, -- Errors first
      float = {
        focusable = true,
        style = "minimal",
        border = "rounded",
        source = "always",
      },
    })

    vim.lsp.handlers['textDocument/hover'] = vim.lsp.with(
      vim.lsp.handlers.hover,
      { focusable = true, style = "minimal", border = "rounded" }
    )

    vim.lsp.handlers['textDocument/signatureHelp'] = vim.lsp.with(
      vim.lsp.handlers.signature_help,
      { focusable = true, style = "minimal", border = "rounded" }
    )

    -----------------
    -- LSP Servers --
    -----------------

    -- https://github.com/neovim/nvim-lspconfig
    local lsps = {
      pyright = {},
      dockerls = {},
      rust_analyzer = {},
      jsonls = {},
      html = {},
      tsserver = {},
      robotframework_ls = {},
    }

    for name, _ in pairs(lsps) do
      lspconfig[name].setup({
        capabilities = capabilities,
      })
    end

    -- Requires gopls
    lspconfig.gopls.setup {
      capabilities = capabilities,
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
  end,
  enabled = function()
    return not require('core.utils').is_vscodevim()
  end
}
