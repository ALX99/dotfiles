return {
  settings = {
    yaml = {
      schemas = {
        ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
        ["~/projects/ika/config/schema.json"] = "ika.yaml",
        -- ["~/projects/ika/config/schema.json"] = "ika.example.yaml",
      },
      format = {
        enable = true,
        bracketSpacing = true
      },
      schemaStore = {
        enable = true
      }
    },
  },
}
