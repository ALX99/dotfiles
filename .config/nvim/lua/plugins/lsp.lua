return {
  {
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

      -- use vim.notify for LSP messages
      local severity = { "error", "warn", "info", "info" } -- map hint and info to info
      vim.lsp.handlers["window/showMessage"] = function(_, method, params, _)
        local client = vim.lsp.get_client_by_id(params.client_id)
        local msg = "[LSP]"
        if client then
          msg = msg .. " [" .. client.name .. "] "
        end
        msg = msg .. method.message
        vim.notify(msg, severity[params.type])
      end

      -----------------
      -- LSP Servers --
      -----------------
      -- https://github.com/neovim/nvim-lspconfig/blob/master/doc/server_configurations.md
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
        erlangls = {},
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
              usePlaceholders = false,
              semanticTokens = true,
              directoryFilters = { "-.git", "-.vscode", "-.idea", "-.vscode-test", "-node_modules" },

              codelenses = {
                gc_details = true,
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
            if vim.uv.fs_stat(path .. '/.luarc.json') or vim.uv.fs_stat(path .. '/.luarc.jsonc') then
              return
            end
            client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua, {
              workspace = {
                checkThirdParty = false,
                library = {
                  vim.env.VIMRUNTIME
                }
                -- This pulls in a lot or more files
                -- library = vim.api.nvim_get_runtime_file("", true)
              }
            })
          end,
          settings = {
            Lua = {
              runtime = {
                version = 'LuaJIT'
              },
            }
          }
        }
      }

      for name, set in pairs(lsps) do
        lspconfig[name].setup(set)
      end
    end,
    cond = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "folke/lazydev.nvim",
    version      = "*",
    ft           = "lua",
    dependencies = { "Bilal2453/luvit-meta" },
    opts         = {
      library = {
        { path = "luvit-meta/library", words = { "vim%.uv" } },
      },
    },
    cond         = function()
      return not require('core.utils').is_vscodevim()
    end,
    enabled      = require('core.utils').is_linux
  },

}
