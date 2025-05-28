return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    lazy = false,
    branch = 'main',
    config = function(_, opts)
      require('nvim-treesitter').setup(opts)
      vim.opt.foldmethod = "expr"
      vim.opt.foldexpr = "v:lua.vim.treesitter.foldexpr()"

      local ensureInstalled = {
        -- "c",
        -- "cpp",
        "bash",
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
        "regex", -- for Snacks.picker
        "gitcommit"
      }
      local alreadyInstalled = require("nvim-treesitter.config").installed_parsers()
      local parsersToInstall = vim.iter(ensureInstalled)
          :filter(function(parser) return not vim.tbl_contains(alreadyInstalled, parser) end)
          :totable()
      require("nvim-treesitter").install(parsersToInstall)

      -- Start treesitter highlighting if not in vscode
      if not vim.g.vscode then
        vim.api.nvim_create_autocmd('FileType', {
          pattern = {
            "c",
            "cpp",
            "bash",
            "css",
            "dockerfile",
            "go",
            "gomod",
            "html",
            "javascript",
            "javascriptreact",
            "typescript",
            "typescriptreact",
            "json",
            "lua",
            "make",
            "markdown",
            "help", -- for vimdoc
            "python",
            "yaml",
            'gitcommit',
            'go',
            'html',
          },
          callback = function()
            vim.treesitter.start()
          end,
        })
      end
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
