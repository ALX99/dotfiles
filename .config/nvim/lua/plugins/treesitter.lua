return {
  "nvim-treesitter/nvim-treesitter",
  build = ":TSUpdateSync",
  config = function()
    -- Treesitter

    local treesitter_configs = require('nvim-treesitter.configs')
    local treesitter_parsers = require('nvim-treesitter.parsers')

    -- vim.filetype.add({
    --   extension = {
    --     robot = 'robot',
    --   },
    -- })

    treesitter_configs.setup {
      -- A list of parser names, or "all"
      ensure_installed = { "bash", "c", "cpp", "css", "dockerfile", "go", "gomod", "gowork",
        "html", "java", "javascript", "json", "make", "python", "rust",
        "typescript", "yaml" },
      -- sql, typescript, vim, c_sharp

      -- Install parsers synchronously (only applied to `ensure_installed`)
      sync_install = true,

      -- Automatically install missing parsers when entering buffer
      auto_install = true,

      -- List of parsers to ignore installing (for "all")
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
