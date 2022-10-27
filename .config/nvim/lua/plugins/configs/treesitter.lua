-- Treesitter
local utils = require('core.utils')

local treesitter_configs = utils.require('nvim-treesitter.configs')
local treesitter_parsers = utils.require('nvim-treesitter.parsers')
if not treesitter_configs or not treesitter_parsers then return end

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

  playground = {
    enable = true,
    disable = {},
    updatetime = 25, -- Debounced time for highlighting nodes in the playground from source code
    persist_queries = false, -- Whether the query persists across vim sessions
    keybindings = {
      toggle_query_editor = 'q',
      toggle_hl_groups = 'h',
      toggle_injected_languages = 't',
      toggle_anonymous_nodes = 'a',
      toggle_language_display = 'I',
      focus_language = 'f',
      unfocus_language = 'F',
      update = 'R',
      goto_node = '<cr>',
      show_help = '?',
    },
  }
}

vim.opt.foldmethod = "expr"
vim.opt.foldexpr = "nvim_treesitter#foldexpr()"
-- vim.opt.foldminlines = 20
vim.opt.foldenable = false
