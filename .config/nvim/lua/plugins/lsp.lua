return {
  "neovim/nvim-lspconfig",
  dependencies = { "hrsh7th/cmp-nvim-lsp" },
  config = function()
    local lspconfig = require('lspconfig')

    -- Set up
    local capabilities = vim.lsp.protocol.make_client_capabilities()
    capabilities = vim.tbl_deep_extend('force', capabilities, require('cmp_nvim_lsp').default_capabilities())


    -- configure the capabilities to be passed to all LSPs
    lspconfig.util.default_config = vim.tbl_extend(
      "force",
      lspconfig.util.default_config,
      { capabilities = capabilities }
    )


    -----------------
    -- LSP Servers --
    -----------------
    -- https://github.com/neovim/nvim-lspconfig
    local lsps = {
      clangd = {},
      pyright = {},
      dockerls = {},
      rust_analyzer = {},
      jsonls = {},
      html = {},
      cssls = {},
      sourcekit = {},
      tailwindcss = {},
      tsserver = {},
      svelte = {},
      robotframework_ls = {},
      zls = {},
      eslint = {},
      gleam = {},
      nim_langserver = {},
      terraformls = {},
      gopls = {
        -- cmd = { vim.fn.getenv("HOME") .. "/go/bin/gopls" },
        settings = {
          gopls = {
            hints = {
              assignVariableTypes = true,
              compositeLiteralFields = true,
              compositeLiteralTypes = true,
              constantValues = true,
              functionTypeParameters = true,
              parameterNames = true,
              rangeVariableTypes = true
            },
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
        settings = {
          yaml = {
            schemas = {
              ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
            },
          },
        },
      },
      lua_ls = {
        on_init = function(client)
          local path = client.workspace_folders[1].name
          if not vim.uv.fs_stat(path .. '/.luarc.json') and not vim.uv.fs_stat(path .. '/.luarc.jsonc') then
            client.config.settings = vim.tbl_deep_extend('force', client.config.settings, {
              Lua = {
                runtime = {
                  version = 'LuaJIT'
                },
                -- Make the server aware of Neovim runtime files
                workspace = {
                  checkThirdParty = false,
                  library = vim.api.nvim_get_runtime_file("", true)
                }
              }
            })

            client.notify("workspace/didChangeConfiguration", { settings = client.config.settings })
          end
          return true
        end
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
