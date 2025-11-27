return {
  {
    "neovim/nvim-lspconfig",
    version = "*",
    dependencies = { 'saghen/blink.cmp', 'b0o/schemastore.nvim' },
    config = function()
      local capabilities = vim.lsp.protocol.make_client_capabilities()
      capabilities = vim.tbl_deep_extend('force', capabilities, require('blink.cmp').get_lsp_capabilities({}, false))

      -- set base capabilities
      vim.lsp.config('*', {
        capabilities = capabilities,
      })

      -- use vim.notify for LSP messages
      vim.lsp.handlers["window/showMessage"] = function(err, result, ctx)
        local client = ctx.client_id and vim.lsp.get_client_by_id(ctx.client_id)
        local msg = "[LSP]"
        if client then
          msg = msg .. " [" .. client.name .. "] "
        end
        -- 'result' contains the parameters for showMessage (type, message)
        if result and result.message then
          msg = msg .. result.message
          vim.notify(msg, vim.log.levels.INFO)
        end
      end

      -----------------
      -- LSP Servers --
      -----------------
      -- https://github.com/neovim/nvim-lspconfig/blob/master/doc/configs.md

      -- LSPs
      local enabled_lsps = {
        "pyright",
        "dockerls",
        "rust_analyzer",
        "jsonls",
        "html",
        "cssls",
        "sourcekit",
        "tailwindcss",
        "ts_ls",
        "zls",
        "gleam",
        "nim_langserver",
        "terraformls",
        "eslint",
        "gopls",
        "yamlls",
        "lua_ls",
        "copilot",
      }

      for _, name in ipairs(enabled_lsps) do
        vim.lsp.enable(name)
      end
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
