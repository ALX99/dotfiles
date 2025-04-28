return {
  {
    "neovim/nvim-lspconfig",
    version = "*",
    -- dependencies = { "hrsh7th/cmp-nvim-lsp" },
    dependencies = { 'saghen/blink.cmp' },
    config = function()
      local lspconfig = require('lspconfig')

      local capabilities = vim.lsp.protocol.make_client_capabilities()
      capabilities = vim.tbl_deep_extend('force', capabilities, require('blink.cmp').get_lsp_capabilities({}, false))

      -- set base capabilities
      vim.lsp.config('*', {
        capabilities = capabilities,
      })

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

      -- LSPs with default configurations
      local default_lsps = {
        "clangd",
        "pyright",
        "dockerls",
        "rust_analyzer",
        "jsonls",
        "html",
        "cssls",
        "sourcekit",
        "tailwindcss",
        "ts_ls",
        "svelte",
        "robotframework_ls",
        "zls",
        "gleam",
        "nim_langserver",
        "terraformls",
        "erlangls",
      }

      for _, name in ipairs(default_lsps) do
        vim.lsp.enable(name)
      end

      -- LSPs with custom configurations
      vim.lsp.config('eslint', {
        cmd = { "vscode-eslint-languageserver", "--stdio" }
      })
      vim.lsp.enable('eslint')

      vim.lsp.config('gopls', {
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
              staticcheck = true,
              shadow = true,
            },
          },
        },
      })
      vim.lsp.enable('gopls')

      -- https://github.com/redhat-developer/yaml-language-server
      vim.lsp.config('yamlls', {
        settings = {
          yaml = {
            schemas = {
              ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
              ["/home/dozy/projects/ika/config/schema.json"] = "ika.yaml",
              -- ["/home/dozy/projects/ika/config/schema.json"] = "ika.example.yaml",
            },
            format = {
              enable = true,
              bracketSpacing = true
            },
            schemaStore = {
              enable = true
            }
          },
        },
      })
      vim.lsp.enable('yamlls')

      vim.lsp.config('lua_ls', {
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
      })
      vim.lsp.enable('lua_ls')
    end,
    cond = function()
      return not vim.g.vscode
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
      return not vim.g.vscode
    end,
    enabled      = require('core.utils').is_linux
  },

}
