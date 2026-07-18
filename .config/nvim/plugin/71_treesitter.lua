if vim.g.vscode then return end

vim.schedule(function()
  require('nvim-treesitter').install({
    "bash",
    "css",
    "dockerfile",
    "go",
    "gomod",
    "html",
    "javascript",
    "typescript",
    "tsx",
    "json",
    "lua",
    "luadoc",
    "make",
    "markdown",
    "markdown_inline",
    "vimdoc",
    "python",
    "yaml",
    "regex", -- for Snacks.picker
    "gitcommit",
    "svelte",
  })
end)

local group = vim.api.nvim_create_augroup('treesitter_filetypes', { clear = true })

_G.Config.new_autocmd('FileType', {
  group = group,
  desc = 'Enable treesitter highlighting and indentation',
  callback = function(event)
    local lang = vim.treesitter.language.get_lang(event.match) or event.match
    local buf = event.buf

    if lang ~= nil and vim.treesitter.language.add(lang) then
      -- syntax highlighting, provided by Neovim
      pcall(vim.treesitter.start, buf, lang)

      if vim.treesitter.query.get(lang, "indents") then
        -- indentation, provided by nvim-treesitter
        vim.bo.indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
      end

      if vim.treesitter.query.get(lang, "folds") then
        -- folds, provided by Neovim
        vim.wo.foldmethod = "expr"
        vim.wo.foldexpr = 'v:lua.vim.treesitter.foldexpr()'
      end
    end
  end
})

require('treesitter-context').setup({})
