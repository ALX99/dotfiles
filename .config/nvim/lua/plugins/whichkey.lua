return {
  "folke/which-key.nvim",
  event = "VeryLazy",
  config = function()
    local wk = require("which-key")

    vim.o.timeout = true
    vim.o.timeoutlen = 1000
    wk.register({
      mode = { "n", "v" },
      --       ["g"] = { name = "+goto" },
      --       ["gz"] = { name = "+surround" },
      --       ["]"] = { name = "+next" },
      --       ["["] = { name = "+prev" },
      --       ["<leader><tab>"] = { name = "+tabs" },
      --       ["<leader>b"] = { name = "+buffer" },
      --       ["<leader>c"] = { name = "+code" },
      ["<leader>f"] = { name = "+file(s)" },
      ["<leader>g"] = { name = "+git" },
      --       ["<leader>s"] = { name = "+search" },
      ["<leader>w"] = { name = "+windows" },
    })
  end,
}
