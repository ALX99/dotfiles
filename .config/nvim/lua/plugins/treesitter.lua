return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "BufReadPost", "BufNewFile" },
    dependencies ={ "windwp/nvim-ts-autotag" },
    opts = {
      ensure_installed = {
        "bash",
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
      highlight = { enable = true },
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
      autotag = {
        enable = true,
      },
    },
    config = function(_, opts)
      require('nvim-treesitter.configs').setup(opts)

      -- local treesitter_parsers = require('nvim-treesitter.parsers')

      -- vim.filetype.add({
      --   extension = {
      --     robot = 'robot',
      --   },
      -- })

      -- DON'T COMMIT THIS ...
      -- treesitter_parsers.get_parser_configs().robot = {
      -- install_info = {
      --  url = "~/projects/tree-sitter-robot",  -- local path or git repo
      -- files = { "src/parser.c" },
      -- optional entries:
      -- branch = "master",                       -- default branch in case of git repo if different from master
      -- generate_requires_npm = false,           -- if stand-alone parser without npm dependencies
      -- requires_generate_from_grammar = false,  -- if folder contains pre-generated src/parser.c
      -- }
      -- }

      vim.opt.foldmethod = "expr"
      vim.opt.foldexpr = "nvim_treesitter#foldexpr()"
      -- vim.opt.foldminlines = 20
      vim.opt.foldenable = false
    end,
    cond = function()
      return not require('core.utils').is_vscodevim()
    end
  },
  {
    "nvim-treesitter/nvim-treesitter-context",
    event = { "BufReadPost", "BufNewFile" },
    config = true,
    enabled = false,
    cond = function()
      return not require('core.utils').is_vscodevim()
    end
  },
}
