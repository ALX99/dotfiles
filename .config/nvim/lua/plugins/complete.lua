return {
  -- completion
  {
    "hrsh7th/nvim-cmp",
    enabled = false,
    event = { "InsertEnter", "CmdlineEnter" },
    dependencies = {
      -- 'hrsh7th/cmp-buffer',
    },
    opts = function(_, _)
      local cmp = require('cmp')
      vim.opt.completeopt = { 'menu', 'menuone', 'noselect', 'preview' }

      return {
        snippet = {
          expand = function(args)
            vim.snippet.expand(args.body)
          end,
        },
        mapping = {
          ["<Down>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_next_item({ behavior = cmp.SelectBehavior.Select })
            else
              fallback()
            end
          end, { 'i' }),
          ["<Up>"] = function(fallback)
            if cmp.visible() then
              cmp.select_prev_item({ behavior = cmp.SelectBehavior.Select })
            else
              fallback()
            end
          end,
          ["<Right>"] = function(fallback)
            if cmp.visible() then
              -- select means to select the first entry if nothing is selected
              cmp.confirm({ select = true })
            else
              fallback()
            end
          end,
          -- ["<A-n>"] = cmp.mapping.scroll_docs(-4),
          -- ["<A-e>"] = cmp.mapping.scroll_docs(4),
          ["<Esc>"] = cmp.mapping.abort(),
          ["<CR>"] = function(fallback)
            if cmp.visible() and cmp.get_selected_entry() then
              -- select means to select the first entry if nothing is selected
              cmp.confirm({ select = false })
            else
              fallback()
            end
          end,
        },
        formatting = {
          format = function(entry, item)
            local short_name = {
              nvim_lsp = 'LSP',
              buffer = 'BUF',
            }
            local menu_name = short_name[entry.source.name] or entry.source.name
            item.menu = string.format('[%s]', menu_name)
            return item
          end,
        },
        sources = cmp.config.sources(
          {
            { name = "nvim_lsp" }
          }
        -- {
        --   { name = "buffer" },
        -- }
        ),
        -- experimental = {
        --   ghost_text = {
        --     hl_group = "LspCodeLens",
        --   },
        -- },
        -- sorting = {
        --   comparators = {
        --     cmp.config.compare.offset,
        --     cmp.config.compare.exact,
        --     cmp.config.compare.score,
        --     cmp.config.compare.recently_used,
        --     cmp.config.compare.kind,
        --     cmp.config.compare.sort_text,
        --     cmp.config.compare.length,
        --     cmp.config.compare.order,
        --   },
        -- },
      }
    end,
    config = function(_, opts)
      local map = require('core.utils').map
      local cmp = require('cmp')

      cmp.setup(opts)

      map({ 'i', 's' }, '<M-.>', function()
        if vim.snippet.active({ direction = 1 }) then
          return '<cmd>lua vim.snippet.jump(1)<cr>'
        else
          return '<Tab>'
        end
      end, { expr = true })

      map({ 'i', 's' }, '<M-,>', function()
        if vim.snippet.active({ direction = -1 }) then
          return '<cmd>lua vim.snippet.jump(-1)<cr>'
        else
          return '<S-Tab>'
        end
      end, { expr = true })
    end,
    cond = function()
      return not vim.g.vscode
    end
  },
  {
    'saghen/blink.cmp',
    dependencies = { 'rafamadriz/friendly-snippets' },

    version = '1.*',

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
