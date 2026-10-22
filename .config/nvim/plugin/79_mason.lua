-- mason.nvim (LSP server installer)
if vim.g.vscode then return end

-- Server executables must be available before LSP starts, without loading the installer.
local root = vim.fn.stdpath('data') .. '/mason'
vim.env.MASON = root
vim.env.PATH = root .. '/bin' .. (vim.fn.has('win32') == 1 and ';' or ':') .. vim.env.PATH

for _, name in ipairs({ 'Mason', 'MasonInstall', 'MasonUninstall', 'MasonUninstallAll', 'MasonUpdate', 'MasonLog' }) do
  vim.api.nvim_create_user_command(name, function(args)
    require('mason').setup({ PATH = 'skip' })
    vim.cmd({ cmd = name, args = args.fargs, mods = args.smods })
  end, {
    nargs = '*',
    complete = function(_, cmdline, cursorpos)
      require('mason').setup({ PATH = 'skip' })
      return vim.fn.getcompletion(cmdline:sub(1, cursorpos), 'cmdline')
    end,
    desc = 'Load Mason and run ' .. name,
  })
end
