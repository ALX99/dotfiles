-- blink.cmp (autocompletion)
if vim.g.vscode then return end

-- Keep LSP capabilities available at startup (registered by blink's plugin),
-- but initialize completion only when an editing mode first needs it.
local group = vim.api.nvim_create_augroup('blink_setup', { clear = true })
Config.new_autocmd({ 'InsertEnter', 'CmdlineEnter', 'TermEnter' }, {
  group = group,
  callback = function()
    vim.api.nvim_del_augroup_by_id(group)
    require('blink.cmp').setup({
      keymap = {
        preset = 'default',
        ['<CR>'] = { 'select_and_accept', 'fallback' },
      },
      appearance = {
        nerd_font_variant = 'mono',
      },
      completion = {
        documentation = { auto_show = true },
        list = {
          selection = { auto_insert = false },
        },
      },
      signature = { enabled = true },
      sources = {
        default = { 'lsp', 'path', 'buffer' },
      },
    })
  end,
})
