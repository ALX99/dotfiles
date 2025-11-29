return {
  {
    'saghen/blink.cmp',
    dependencies = { 'rafamadriz/friendly-snippets' },
    version = '1.*',
    cond = function()
      return not vim.g.vscode
    end,

    ---@module 'blink.cmp'
    ---@type blink.cmp.Config
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
          "snippet_forward",
          function() -- sidekick next edit suggestion
            return require("sidekick").nes_jump_or_apply()
          end,
          -- Nvim 0.12 prob
          -- function() -- if you are using Neovim's native inline completions
          --   return vim.lsp.inline_completion.get()
          -- end,
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
        default = { 'lsp', 'path', 'snippets', 'buffer' },

        providers = {
          snippets = {
            -- boost score
            -- score_offset = 1000,
            min_keyword_length = 2,
          }
        }
      },
    },
  }
}
