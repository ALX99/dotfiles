return {
  {
    "folke/tokyonight.nvim",
    event = "VeryLazy",
  },
  {
    "projekt0n/github-nvim-theme",
    version = "0.0.x",
    config = function()
      require('github-theme').setup()
    end
  },
  {
    "EdenEast/nightfox.nvim",
    event = "VeryLazy",
    config = function()
      require('nightfox').setup({
        options = {
          dim_inactive = true, -- Non focused panes set to alternative background
        }
      })
    end,
  },
}
