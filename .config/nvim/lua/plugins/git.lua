return {
  {
    dir = vim.fn.stdpath("config") .. "/lua/custom_plugins/gitgud",
    name = "gitgud",
    dev = true,
    opts = {},
    keys = {
      {
        "<leader>Gl",
        function()
          require("gitgud").copy_github_permalink()
        end,
        mode = "n",
        desc = "Copy GitHub permalink",
      },
      {
        "<leader>Gl",
        function()
          local start_line = vim.fn.line("v")
          local end_line = vim.fn.line(".")
          if end_line < start_line then
            start_line, end_line = end_line, start_line
          end
          require("gitgud").copy_github_permalink({ start_line = start_line, end_line = end_line })
          vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
        end,
        mode = "x",
        desc = "Copy GitHub permalink (range)",
      },
      {
        "<leader>Go",
        function()
          require("gitgud").open_github_file()
        end,
        mode = "n",
        desc = "Open GitHub file",
      },
      {
        "<leader>Go",
        function()
          local start_line = vim.fn.line("v")
          local end_line = vim.fn.line(".")
          if end_line < start_line then
            start_line, end_line = end_line, start_line
          end
          require("gitgud").open_github_file({ start_line = start_line, end_line = end_line })
          vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
        end,
        mode = "x",
        desc = "Open GitHub file (range)",
      },
    },
  },
  {
    "FabijanZulj/blame.nvim",
    opts = {},
    cond = function()
      return not vim.g.vscode
    end,
  },
  {
    "esmuellert/vscode-diff.nvim",
    dependencies = { "MunifTanjim/nui.nvim" },
    cmd = "CodeDiff",
    keys = {
      { "<leader>Gs", "<cmd>CodeDiff<cr>", desc = "Show git status" },
    },
    cond = function()
      return not vim.g.vscode
    end,
  },
}
