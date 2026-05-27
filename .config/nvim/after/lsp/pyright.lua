local function use_project_venv(config, root_dir)
  if not root_dir then return end

  local python = root_dir .. '/.venv/bin/python'
  if vim.fn.executable(python) ~= 1 then return end

  config.settings = config.settings or {}
  config.settings.python = config.settings.python or {}
  config.settings.python.pythonPath = python
  config.settings.python.venvPath = root_dir
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
  on_new_config = use_project_venv,
}
