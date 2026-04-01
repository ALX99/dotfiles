return {
  {
    'saghen/blink.cmp',
    version = '1.*',
    cond = function()
      return not vim.g.vscode
    end,

    opts = {
      -- All presets have the following mappings:
      -- C-space: Open menu or open docs if already open
      -- C-n/C-p or Up/Down: Select next/previous item
      -- C-e: Hide menu
      -- C-k: Toggle signature help (if signature.enabled = true)
      --
      -- See :h blink-cmp-config-keymap for defining your own keymap
      keymap = {
        preset = 'default',
        ['<CR>'] = { 'select_and_accept', 'fallback' },
        ["<Tab>"] = {
          function()
            return require("sidekick").nes_jump_or_apply()
          end,
          function()
            return vim.lsp.inline_completion.get()
          end,
          "fallback",
        },
      },

      appearance = {
        -- 'mono' (default) for 'Nerd Font Mono' or 'normal' for 'Nerd Font'
        -- Adjusts spacing to ensure icons are aligned
        nerd_font_variant = 'mono'
      },

      completion = {
        documentation = { auto_show = true },
        list =
        {
          selection = {
            auto_insert = false,
          }
        },
      },

      signature = { enabled = true },

      sources = {
        default = { 'lsp', 'path', 'buffer' },
      },
    },
  }
}
