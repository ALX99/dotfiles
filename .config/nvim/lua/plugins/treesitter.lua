return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    lazy = false,
    config = function(_, _)
      require('nvim-treesitter').install({
        -- "c",
        -- "cpp",
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
      })


      if not vim.g.vscode then
        return -- if in vscode, do nothing
      end

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
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter-context",
    event = { "BufReadPost", "BufNewFile" },
    config = true,
    enabled = false,
    cond = function()
      return not vim.g.vscode
    end
  },
}
