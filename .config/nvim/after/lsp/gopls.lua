return {
  cmd = { "gopls", "-remote=auto" },
  ---@type lspconfig.settings.gopls
  settings = {
    gopls = {
      hints = {
        assignVariableTypes = true,
        compositeLiteralFields = true,
        compositeLiteralTypes = true,
        constantValues = true,
        functionTypeParameters = true,
        parameterNames = true,
        rangeVariableTypes = true
      },
      fileWatcher = "poll",
      gofumpt = true,
      staticcheck = true,
      directoryFilters = {
        "-**/.git",
        "-**/.idea",
        "-**/.vscode",
        "-**/.vscode-test",
      },
    },
  },
}
