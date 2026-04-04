if vim.g.vscode then return end
-- Depends on: complete.lua (blink.cmp) — get_lsp_capabilities() is called eagerly at load time
--             (load order: complete.lua runs before lsp.lua alphabetically, so this is safe)
vim.pack.add({
  { src = 'https://github.com/neovim/nvim-lspconfig', version = vim.version.range('*') },
  'https://github.com/b0o/schemastore.nvim', -- used by jsonls/yamlls lsp configs
})


local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = vim.tbl_deep_extend('force', capabilities, require('blink.cmp').get_lsp_capabilities({}, false)) -- blink.cmp from complete.lua

vim.lsp.config('*', { capabilities = capabilities })

-- vim.lsp.handlers["window/showMessage"] = function(err, result, ctx)
--   local client = ctx.client_id and vim.lsp.get_client_by_id(ctx.client_id)
--   local msg = "[LSP]"
--   if client then msg = msg .. " [" .. client.name .. "] " end
--   if result and result.message then
--     vim.notify(msg .. result.message, vim.log.levels.INFO)
--   end
-- end

local enabled_lsps = {
  "pyright",
  "docker_language_server",
  "rust_analyzer",
  "jsonls",
  "html",
  "cssls",
  "sourcekit",
  "tailwindcss",
  "tsgo",
  "zls",
  "gleam",
  "terraformls",
  "eslint",
  "gopls",
  "yamlls",
  "lua_ls",
  "copilot",
  "svelte",
  "gh_actions_ls",
  "kotlin_lsp",
  "astro",
}

for _, name in ipairs(enabled_lsps) do
  vim.lsp.enable(name)
end
vim.lsp.inline_completion.enable(true)
vim.lsp.codelens.enable(true)


vim.api.nvim_create_autocmd('LspProgress', {
  callback = function(ev)
    local value = ev.data.params.value
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
