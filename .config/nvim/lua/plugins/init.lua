return {
  "folke/tokyonight.nvim",
  {
    "ggandor/leap.nvim",
    keys = {
      { "<leader>f", "<Plug>(leap-forward-to)", { "n", "x" } },
      { "<leader>F", "<Plug>(leap-backward-to)", { "n", "x" } },
    },
  },
  {
    "alx99/qc.lua",
    opts = {
      shortcut = "<leader>/"
    }
  },
  {
    "EdenEast/nightfox.nvim",
    config = function()
      require('nightfox').setup({
        options = {
          dim_inactive = true, -- Non focused panes set to alternative background
        }
      })
      vim.cmd("colorscheme carbonfox")
    end,
  },
}


-- local plugins = {
--   ['navarasu/onedark.nvim'] = {
--     disable = true,
--     config = function() require('onedark').load() end,
--     commit = 'cad3d983e57f467ba8e8252b0567e96dde9a8f0d'
--   },
--   ['rebelot/kanagawa.nvim'] = {
--     disable = true,
--     config = function() vim.cmd("colorscheme kanagawa") end,
--     commit = '52cfa270317121672c1416c725361fa653684de0'
--   },

-- Eyecandy for notifications
--   ['rcarriga/nvim-notify'] = {
--     disable = true,
--     config = function() require('plugins.configs.notify') end,
--   },

-- Autopairs
--   ['windwp/nvim-autopairs'] = {
--     disable = true,
--     config = function() require('plugins.configs.autopairs') end,
--   },


--   ['simrat39/symbols-outline.nvim'] = {
--     disable = true,
--     config = function() require('symbols-outline').setup({
--         auto_close = true
--       })
--     end,
--   },



-- Utilities
-- }
