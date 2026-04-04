vim.pack.add({
  'https://github.com/nvim-treesitter/nvim-treesitter',
  'https://github.com/nvim-treesitter/nvim-treesitter-context',
})

vim.api.nvim_create_autocmd('PackChanged', {
  callback = function(ev)
    local name, kind = ev.data.spec.name, ev.data.kind
    if name == 'nvim-treesitter' and kind == 'update' then
      if not ev.data.active then vim.cmd.packadd('nvim-treesitter') end
      vim.cmd('TSUpdate')
    end
  end
})

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

if vim.g.vscode then return end

local group = vim.api.nvim_create_augroup('treesitter_filetypes', { clear = true })

vim.api.nvim_create_autocmd('FileType', {
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
