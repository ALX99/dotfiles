-- nvim-lspconfig
if vim.g.vscode then return end

-- An empty buffer needs no clients or LSP UI. Configure on the first filetype;
-- vim.lsp.enable also starts clients for buffers whose filetype is already set.
Config.new_autocmd('FileType', {
  once = true,
  callback = function()
    vim.lsp.handlers["window/showMessage"] = function(_, result, ctx)
      if not (result and result.message) then return end
      local client = ctx and ctx.client_id and vim.lsp.get_client_by_id(ctx.client_id)
      local prefix = client and ("[LSP] [" .. client.name .. "]") or "[LSP]"
      -- LSP MessageType: 1=Error, 2=Warning, 3=Info, 4=Log, 5=Debug (LSP 3.18+)
      local level = ({ [1] = vim.log.levels.ERROR, [2] = vim.log.levels.WARN, [3] = vim.log.levels.INFO, [4] = vim.log.levels.DEBUG, [5] = vim.log.levels.DEBUG })
          [result.type] or vim.log.levels.INFO
      vim.notify(prefix .. " " .. result.message, level)
    end

    local enabled_lsps = {
      "pyright",
      "html",
      "cssls",
      "tailwindcss",
      "tsc",
      "terraformls",
      "oxlint",
      "gopls",
      "lua_ls",
      "gh_actions_ls",
      "kotlin_lsp",
    }

    vim.lsp.enable(enabled_lsps)
    vim.lsp.codelens.enable(true)
  end,
})
