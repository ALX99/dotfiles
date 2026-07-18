local function use_project_venv(_, config)
  if not config.root_dir then return end

  local python = vim.fs.joinpath(config.root_dir, '.venv', 'bin', 'python')
  if vim.fn.executable(python) ~= 1 then return end

  config.settings = config.settings or {}
  config.settings.python = config.settings.python or {}
  config.settings.python.pythonPath = python
end

return {
  ---@type lspconfig.settings.pyright
  before_init = use_project_venv,
}
