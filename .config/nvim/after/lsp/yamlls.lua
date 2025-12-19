return {
  settings = {
    yaml = {
      schemas = require('schemastore').yaml.schemas(),
      format = {
        enable = true,
        bracketSpacing = true
      },
      schemaStore = {
        -- You must disable built-in schemaStore support if you want to use
        -- this plugin and its advanced options like `ignore`.
        enable = false,
        -- Avoid TypeError: Cannot read properties of undefined (reading 'length')
        url = "",
      },
    },
  },
}
