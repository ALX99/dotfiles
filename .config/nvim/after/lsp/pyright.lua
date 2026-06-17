local function use_project_venv(_, config)
  if not config.root_dir then return end

  local python = config.root_dir .. '/.venv/bin/python'
  if not vim.fn.executable(python) then return end

  config.settings = config.settings or {}
  config.settings.python = config.settings.python or {}
  config.settings.python.pythonPath = python
  config.settings.python.venvPath = config.root_dir
  config.settings.python.venv = '.venv'
end

return {
  ---@type lspconfig.settings.pyright
  settings = {
    python = {
      analysis = {
        autoSearchPaths = true,
        useLibraryCodeForTypes = true,
      },
    },
  },
  before_init = use_project_venv,
}
