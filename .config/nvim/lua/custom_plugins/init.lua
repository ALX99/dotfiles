require('custom_plugins.minmode').setup()
if not vim.g.vscode then
  require('custom_plugins.session').setup()
end
