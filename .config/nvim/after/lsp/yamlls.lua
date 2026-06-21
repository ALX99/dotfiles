return {
  ---@type lspconfig.settings.yamlls
  settings = {
    yaml = {
      format = {
        enable = true,
        bracketSpacing = true
      },
      schemaStore = {
        enable = true,
      },
    },
  },
}
