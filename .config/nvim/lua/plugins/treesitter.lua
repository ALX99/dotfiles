return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "BufReadPost", "BufNewFile" },
    opts = {
      ensure_installed = {
        -- "bash",
        -- "c",
        -- "cpp",
        "css",
        "dockerfile",
        "go",
        "gomod",
        "html",
        "javascript",
        "typescript",
        "json",
        "lua",
        -- "luadoc",
        "make",
        "markdown",
        "markdown_inline",
        "vimdoc",
        "python",
        "yaml",
      },
      -- Install parsers synchronously (only applied to `ensure_installed`)
      sync_install = false,
      auto_install = false,
      highlight = { enable = not vim.g.vscode },
      indent = { enable = true },
      incremental_selection = {
        enable = true,
        keymaps = {
          init_selection = "<C-space>",
          -- Below are only mapped in insert mode
          node_incremental = "<C-space>",
          scope_incremental = false,
          node_decremental = "<bs>",
        },
      },
    },
    config = function(_, opts)
      require('nvim-treesitter.configs').setup(opts)

      vim.opt.foldmethod = "expr"
      vim.opt.foldexpr = "nvim_treesitter#foldexpr()"
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter-context",
    event = { "BufReadPost", "BufNewFile" },
    config = true,
    enabled = false,
    cond = function()
      return not vim.g.vscode
    end
  },
}
