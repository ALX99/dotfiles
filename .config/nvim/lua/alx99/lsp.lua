-- Setup nvim-cmp
local cmp = require("cmp")
local lspconfig = require("lspconfig")
if cmp == nil or lspconfig == nil then
    return
end

cmp.setup({
    snippet = {
        expand = function(args)
            vim.fn["vsnip#anonymous"](args.body)
        end,
    },
    window = {
        completion = cmp.config.window.bordered(),
        documentation = cmp.config.window.bordered(),
    },
    mapping = cmp.mapping.preset.insert({
        ['<C-b>'] = cmp.mapping.scroll_docs(-4),
        ['<C-f>'] = cmp.mapping.scroll_docs(4),
        ['<C-Space>'] = cmp.mapping.complete(),
        ['<C-e>'] = cmp.mapping.abort(),
        ['<CR>'] = cmp.mapping.confirm({ select = true }), -- Accept currently selected item. Set `select` to `false` to only confirm explicitly selected items.
    }),
    sources = cmp.config.sources({
        { name = 'nvim_lsp' },
        { name = 'vsnip' },
    }, {
        { name = 'buffer' },
    })
})

-- Set configuration for specific filetype.
cmp.setup.filetype('gitcommit', {
    sources = cmp.config.sources({
        { name = 'cmp_git' }, -- You can specify the `cmp_git` source if you were installed it.
    }, {
        { name = 'buffer' },
    })
})

-- Use buffer source for `/` (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline('/', {
    mapping = cmp.mapping.preset.cmdline(),
    sources = {
        { name = 'buffer' }
    }
})

-- Use cmdline & path source for ':' (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline(':', {
    mapping = cmp.mapping.preset.cmdline(),
    sources = cmp.config.sources({
        { name = 'path' }
    }, {
        { name = 'cmdline' }
    })
})

-- nvim-cmp capabiltiies to pass to lspconfig
-- This announces what features the editor can support
local capabilities = require("cmp_nvim_lsp").update_capabilities(vim.lsp.protocol.make_client_capabilities())

local opts = { noremap = true, silent = true }
-- vim.keymap.set('n', '<space>e', vim.diagnostic.open_float, opts)
vim.keymap.set('n', '[d', vim.diagnostic.goto_prev, opts)
vim.keymap.set('n', ']d', vim.diagnostic.goto_next, opts)

vim.opt.completeopt = "menu,menuone,noselect" -- https://github.com/hrsh7th/nvim-cmp
-- vim.keymap.set('n', '<space>q', vim.diagnostic.setloclist, opts)

-- map('n', 'gw', ':lua vim.lsp.buf.document_symbol()<cr>')
-- map('n', 'gw', ':lua vim.lsp.buf.workspace_symbol()<cr>')

-- This is a callback function that will e executed when a
-- language server is attached to a buffer.
local on_attach = function(client, bufnr)
    -- Enable completion triggered by <c-x><c-o>
    -- vim.api.nvim_buf_set_option(bufnr, 'omnifunc', 'v:lua.vim.lsp.omnifunc')

    -- Mappings.
    -- See `:help vim.lsp.*` for documentation on any of the below functions
    local bufopts = { noremap = true, silent = true, buffer = bufnr }
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, bufopts)
    vim.keymap.set('n', 'gD', vim.lsp.buf.declaration, bufopts)
    vim.keymap.set('n', 'gh', vim.lsp.buf.hover, bufopts)
    vim.keymap.set('n', 'gi', vim.lsp.buf.implementation, bufopts)
    vim.keymap.set('n', 'gs', vim.lsp.buf.signature_help, bufopts)
    vim.keymap.set('n', '<leader>wa', vim.lsp.buf.add_workspace_folder, bufopts)
    vim.keymap.set('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder, bufopts)
    vim.keymap.set('n', '<leader>wl', function()
        print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
    end, bufopts)
    vim.keymap.set('n', '<leader>D', vim.lsp.buf.type_definition, bufopts)
    vim.keymap.set('n', '<leader>rn', vim.lsp.buf.rename, bufopts)
    vim.keymap.set('n', '<leader>ca', vim.lsp.buf.code_action, bufopts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, bufopts)
    vim.keymap.set('n', '<leader>f', vim.lsp.buf.formatting, bufopts)

    -- https://github.com/ray-x/lsp_signature.nvim#configure
    require("lsp_signature").on_attach({
        bind = true, -- This is mandatory, otherwise border config won't get registered.
        floating_window = true,
        always_trigger = true,
        hint_prefix = "> ",
        handler_opts = {
            border = "rounded"
        }
    }, bufnr)

end


-- Requires gopls
lspconfig.gopls.setup {
    capabilities = capabilities,
    on_attach = on_attach,
}

-- Requires shellcheck and https://github.com/bash-lsp/bash-language-server
lspconfig.bashls.setup {
    capabilities = capabilities,
    on_attach = on_attach,
}

-- Requires pyright
lspconfig.pyright.setup {
    capabilities = capabilities,
    on_attach = on_attach,
}

-- Requires https://github.com/rcjsuen/dockerfile-language-server-nodejs (used by the vscode docker extension)
lspconfig.dockerls.setup {
    capabilities = capabilities,
    on_attach = on_attach,
}

-- Requires https://github.com/redhat-developer/yaml-language-server
lspconfig.yamlls.setup {
    on_attach = on_attach,
    capabilities = capabilities,
    settings = {
        yaml = {
            schemas = {
                ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*"
            },
        },
    },
}

lspconfig.sumneko_lua.setup {
    on_attach = on_attach,
    settings = {
        Lua = {
            runtime = {
                -- Tell the language server which version of Lua you're using (most likely LuaJIT in the case of Neovim)
                version = 'LuaJIT',
            },
            diagnostics = {
                -- Get the language server to recognize the `vim` global
                globals = { 'vim' },
            },
            workspace = {
                -- Make the server aware of Neovim runtime files
                library = vim.api.nvim_get_runtime_file("", true),
            },
            -- Do not send telemetry data containing a randomized but unique identifier
            telemetry = {
                enable = false,
            },
        },
    },
}
