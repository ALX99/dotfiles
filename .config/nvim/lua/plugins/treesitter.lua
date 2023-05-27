return {
  "nvim-treesitter/nvim-treesitter",
  build = ":TSUpdateSync",
  config = function()
    -- Treesitter

    local treesitter_configs = require('nvim-treesitter.configs')
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

    treesitter_configs.setup {
      -- A list of parser names, or "all"
      ensure_installed = {
        "bash",
        "c",
        "cpp",
        "css",
        "dockerfile",
        "go",
        "gomod",
        "gowork",
        "html",
        "java",
        "javascript",
        "json",
        "lua",
        "luadoc",
        "make",
        "markdown",
        "markdown_inline",
        "python",
        "rust",
        "yaml",
      },

      -- Install parsers synchronously (only applied to `ensure_installed`)
      sync_install = false,

      -- ignore_install = { "javascript" },

      indent = {
        enable = true -- Experimental feature
      },

      highlight = {
        -- `false` will disable the whole extension
        enable = true,
        -- Setting this to true will run `:h syntax` and tree-sitter at the same time.
        -- Set this to `true` if you depend on 'syntax' being enabled (like for indentation).
        -- Using this option may slow down your editor, and you may see some duplicate highlights.
        -- Instead of true it can also be a list of languages
        additional_vim_regex_highlighting = false,
      },
    }

    vim.opt.foldmethod = "expr"
    vim.opt.foldexpr = "nvim_treesitter#foldexpr()"
    -- vim.opt.foldminlines = 20
    vim.opt.foldenable = false
  end,
  enabled = function()
    return not require('core.utils').is_vscodevim()
  end
}
