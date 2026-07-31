if vim.g.vscode then return end

local group = vim.api.nvim_create_augroup('treesitter_filetypes', { clear = true })

local function enable_treesitter(buf, filetype)
  local lang = vim.treesitter.language.get_lang(filetype) or filetype

  if lang == nil or not vim.treesitter.language.add(lang) then return end

  -- syntax highlighting, provided by Neovim
  pcall(vim.treesitter.start, buf, lang)

  if vim.treesitter.query.get(lang, "indents") then
    -- indentation, provided by nvim-treesitter
    vim.bo[buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
  end

  if vim.treesitter.query.get(lang, "folds") then
    -- folds, provided by Neovim
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
      vim.wo[win].foldmethod = "expr"
      vim.wo[win].foldexpr = 'v:lua.vim.treesitter.foldexpr()'
    end
  end
end

_G.Config.new_autocmd('FileType', {
  group = group,
  desc = 'Enable treesitter highlighting and indentation',
  callback = function(event) enable_treesitter(event.buf, event.match) end,
})

local parsers = {
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
}

vim.schedule(function()
  require('nvim-treesitter').install(parsers):await(function(err)
    if err then return end

    -- A failed language lookup is cached until 'runtimepath' is assigned.
    -- Refresh it now that asynchronous parser installation has finished.
    vim.o.rtp = vim.o.rtp
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].filetype ~= '' then
        enable_treesitter(buf, vim.bo[buf].filetype)
      end
    end
  end)
end)

require('treesitter-context').setup({})
