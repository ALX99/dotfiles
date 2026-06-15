-- nvim-lspconfig
-- Depends on: blink_cmp.lua (get_lsp_capabilities called eagerly at load time)
if vim.g.vscode then return end

vim.pack.add({
  { src = 'https://github.com/neovim/nvim-lspconfig', version = vim.version.range('*') },
  'https://github.com/b0o/schemastore.nvim', -- used by jsonls/yamlls lsp configs
})

local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = vim.tbl_deep_extend('force', capabilities, require('blink.cmp').get_lsp_capabilities({}, false))

vim.lsp.config('*', { capabilities = capabilities })

vim.lsp.handlers["window/showMessage"] = function(_, result, ctx)
  if not (result and result.message) then return end
  local client = ctx and ctx.client_id and vim.lsp.get_client_by_id(ctx.client_id)
  local prefix = client and ("[LSP] [" .. client.name .. "]") or "[LSP]"
  local levels = { [1] = vim.log.levels.ERROR, [2] = vim.log.levels.WARN, [3] = vim.log.levels.INFO, [4] = vim.log.levels.DEBUG }
  vim.notify(prefix .. " " .. result.message, levels[result.type] or vim.log.levels.INFO)
end

local enabled_lsps = {
  "pyright",
  "jsonls",
  "html",
  "cssls",
  "tailwindcss",
  "tsgo",
  "terraformls",
  "eslint",
  "gopls",
  "yamlls",
  "lua_ls",
  "copilot",
  "gh_actions_ls",
  "kotlin_lsp",
}

for _, name in ipairs(enabled_lsps) do
  vim.lsp.enable(name)
end
vim.lsp.inline_completion.enable(true)
vim.lsp.codelens.enable(true)

_G.Config.new_autocmd('LspProgress', {
  callback = function(ev)
    local value = ev.data.params.value
    if type(value) ~= 'table' or not value.kind then return end
    vim.api.nvim_echo({ { value.message or 'done' } }, false, {
      id = 'lsp.' .. ev.data.client_id,
      kind = 'progress',
      source = 'vim.lsp',
      title = value.title,
      status = value.kind ~= 'end' and 'running' or 'success',
      percent = value.percentage,
    })
  end,
})
