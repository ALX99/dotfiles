return {
  "neovim/nvim-lspconfig",
  dependencies = { "hrsh7th/cmp-nvim-lsp" },
  config = function()
    local lspconfig = require('lspconfig')

    -- nvim-cmp capabilities to pass to lspconfig (announce what features the editor can support)
    local capabilities = vim.tbl_deep_extend(
      'force',
      lspconfig.util.default_config.capabilities,
      require('cmp_nvim_lsp').default_capabilities()
    )


    -----------------
    -- LSP Servers --
    -----------------
    -- https://github.com/neovim/nvim-lspconfig
    local lsps = {
      pyright = { capabilities = capabilities },
      dockerls = { capabilities = capabilities },
      rust_analyzer = { capabilities = capabilities },
      jsonls = { capabilities = capabilities },
      html = { capabilities = capabilities },
      cssls = { capabilities = capabilities },
      tailwindcss = { capabilities = capabilities },
      tsserver = { capabilities = capabilities },
      svelte = { capabilities = capabilities },
      robotframework_ls = { capabilities = capabilities },
      zls = { capabilities = capabilities },
      esint = { capabilities = capabilities },
      gopls = {
        capabilities = capabilities,
        settings = {
          gopls = {
            gofumpt = true,
            staticcheck = true,
            usePlaceholders = true,
            semanticTokens = true,
            directoryFilters = { "-.git", "-.vscode", "-.idea", "-.vscode-test", "-node_modules" },

            codelenses = {
              gc_details = false,
              generate = true,
              regenerate_cgo = true,
              run_govulncheck = true,
              test = true,
              tidy = true,
              upgrade_dependency = true,
              vendor = true,
            },
            -- https://github.com/golang/tools/blob/master/gopls/doc/analyzers.md
            analyses = {
              fieldalignment = true,
              unusedvariable = true,
              unusedparams = true,
              unusedwrite = true,
              nilness = true,
              shadow = true,
              useany = true,
            },
          },
        },
      },
      -- https://github.com/redhat-developer/yaml-language-server
      yamlls = {
        capabilities = capabilities,
        settings = {
          yaml = {
            schemas = {
              ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
            },
          },
        },
      },
      lua_ls = {
        capabilities = capabilities,
        settings = {
          Lua = {
            runtime = {
              version = 'LuaJIT',
            },
            diagnostics = {
              globals = { 'vim' },
            },
            workspace = {
              -- Make the server aware of Neovim runtime files
              library = {
                vim.api.nvim_get_runtime_file("", true),
              }
            },
            telemetry = { enable = false },
          },
        },
      }

    }

    for name, set in pairs(lsps) do
      lspconfig[name].setup(set)
    end
  end,
  cond = function()
    return not require('core.utils').is_vscodevim()
  end
}
