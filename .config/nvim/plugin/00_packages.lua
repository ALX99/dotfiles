-- Wildcard ranges include prereleases; only accept stable semver tags.
local stable = vim.version.range('*')
function stable:has(version)
  if type(version) == 'string' then version = vim.version.parse(version) end
  return version ~= nil and version.prerelease == nil
end

local packages = {
  { src = 'https://github.com/nvim-mini/mini.nvim', version = stable },
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
    'https://github.com/rebelot/kanagawa.nvim',
    'https://github.com/folke/flash.nvim',
    { src = 'https://github.com/OXY2DEV/markview.nvim',  version = stable },
    { src = 'https://github.com/dmtrKovalenko/fff.nvim', version = stable },
    { src = 'https://github.com/folke/snacks.nvim',      version = stable },
    { src = 'https://github.com/neovim/nvim-lspconfig',  version = 'master' },
  })
end

vim.pack.add(packages)
