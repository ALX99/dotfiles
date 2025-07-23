return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    lazy = false,
    branch = 'main',
    config = function(_, opts)
      local treesitter = require('nvim-treesitter')
      treesitter.setup(opts)
      vim.opt.foldmethod = "expr"
      vim.opt.foldexpr = "v:lua.vim.treesitter.foldexpr()"


      local ensure_installed = {
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

      local already_installed = treesitter.get_installed('parsers')
      local parsers_to_install = vim.iter(ensure_installed)
          :filter(function(parser) return not vim.tbl_contains(already_installed, parser) end)
          :totable()
      if #parsers_to_install > 0 then
        treesitter.install(parsers_to_install)
      end


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
