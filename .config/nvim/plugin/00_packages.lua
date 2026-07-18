local packages = {
  { src = 'https://github.com/nvim-mini/mini.nvim', version = vim.version.range('*') },
}

if not vim.g.vscode then
  local group = vim.api.nvim_create_augroup('packages', { clear = true })
  vim.api.nvim_create_autocmd('PackChanged', {
    group = group,
    callback = function(ev)
      local name, kind = ev.data.spec.name, ev.data.kind
      if kind ~= 'install' and kind ~= 'update' then return end

      if name == 'fff.nvim' then
        if not ev.data.active then vim.cmd.packadd('fff.nvim') end
        require('fff.download').download_or_build_binary()
      elseif name == 'nvim-treesitter' then
        if not ev.data.active then vim.cmd.packadd('nvim-treesitter') end
        vim.cmd.TSUpdate()
      end
    end,
  })

  vim.list_extend(packages, {
    'https://github.com/nvim-treesitter/nvim-treesitter',
    'https://github.com/nvim-treesitter/nvim-treesitter-context',
    'https://github.com/rebelot/kanagawa.nvim',
    { src = 'https://github.com/OXY2DEV/markview.nvim', version = vim.version.range('*') },
    'https://github.com/folke/flash.nvim',
    'https://github.com/FabijanZulj/blame.nvim',
    { src = 'https://github.com/dmtrKovalenko/fff.nvim', version = vim.version.range('*') },
    { src = 'https://github.com/folke/snacks.nvim', version = vim.version.range('*') },
    { src = 'https://github.com/saghen/blink.cmp', version = vim.version.range('1.*') },
    { src = 'https://github.com/neovim/nvim-lspconfig', version = vim.version.range('*') },
    { src = 'https://github.com/mason-org/mason.nvim', version = vim.version.range('*') },
  })
end

vim.pack.add(packages)
