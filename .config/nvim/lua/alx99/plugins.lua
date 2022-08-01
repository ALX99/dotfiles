require('gitsigns').setup {
    on_attach = function(bufnr)
        local gs = package.loaded.gitsigns
        vim.keymap.set({ 'n', 'v' }, '<leader>ss', ':Gitsigns stage_hunk<CR>')
        vim.keymap.set({ 'n', 'v' }, '<leader>sr', ':Gitsigns reset_hunk<CR>')
        vim.keymap.set('n', '<leader>sS', gs.stage_buffer)
        vim.keymap.set('n', '<leader>su', gs.undo_stage_hunk)
        vim.keymap.set('n', '<leader>sR', gs.reset_buffer)
        vim.keymap.set('n', '<leader>sp', gs.preview_hunk)
        vim.keymap.set('n', '<leader>slb', function() gs.blame_line { full = true } end)
        vim.keymap.set('n', '<leader>stlb', gs.toggle_current_line_blame)
        vim.keymap.set('n', '<leader>sd', gs.diffthis)
        vim.keymap.set('n', '<leader>sD', function() gs.diffthis('~') end)
        vim.keymap.set('n', '<leader>std', gs.toggle_deleted)
    end
    -- Further config goes here
}

-- :help nvim-tree-setup
-- :help nvim-tree.OPTION_NAME
require("nvim-tree").setup({
    view = {
        adaptive_size = true,
    },
})
vim.api.nvim_set_keymap('n', '<leader>b', '<cmd>NvimTreeFindFile<CR>', { noremap = true })


-- Treesitter
require("nvim-treesitter.configs").setup {
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
