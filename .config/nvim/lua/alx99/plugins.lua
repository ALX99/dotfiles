local utils = require('alx99.utils')

-- Notifications
vim.notify = require('notify')

-- https://github.com/numToStr/Comment.nvim#configuration-optional
require('Comment').setup()

require('gitsigns').setup {
    on_attach = function(bufnr)
        local gs = package.loaded.gitsigns
        utils.map({ 'n', 'v' }, '<leader>ss', ':Gitsigns stage_hunk<CR>')
        utils.map({ 'n', 'v' }, '<leader>sr', ':Gitsigns reset_hunk<CR>')
        utils.map('n', '<leader>sS', gs.stage_buffer)
        utils.map('n', '<leader>su', gs.undo_stage_hunk)
        utils.map('n', '<leader>sR', gs.reset_buffer)
        utils.map('n', '<leader>sp', gs.preview_hunk)
        utils.map('n', '<leader>slb', function() gs.blame_line { full = true } end)
        utils.map('n', '<leader>stlb', gs.toggle_current_line_blame)
        utils.map('n', '<leader>sd', gs.diffthis)
        utils.map('n', '<leader>sD', function() gs.diffthis('~') end)
        utils.map('n', '<leader>std', gs.toggle_deleted)
    end
}

-- :help nvim-tree-setup
-- :help nvim-tree.OPTION_NAME
require('nvim-tree').setup({
    view = {
        adaptive_size = true,
    },
})
utils.map('n', '<leader>ft', '<cmd>NvimTreeFindFile<CR>', { noremap = true })


-- Treesitter
require('nvim-treesitter.configs').setup {
    -- A list of parser names, or "all"
    -- ensure_installed = { "c", "lua", "rust", "go" },
    ensure_installed = "all",

    -- Install parsers synchronously (only applied to `ensure_installed`)
    sync_install = false,

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
