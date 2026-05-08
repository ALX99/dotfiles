return {
  ---@type lspconfig.settings.jsonls
  settings = {
    json = {
      schemas = require('schemastore').json.schemas(),
      validate = { enable = true },
    },
  },
}
