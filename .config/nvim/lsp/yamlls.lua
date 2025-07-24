return {
  settings = {
    yaml = {
      schemas = {
        ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*",
        ["/home/dozy/projects/ika/config/schema.json"] = "ika.yaml",
        -- ["/home/dozy/projects/ika/config/schema.json"] = "ika.example.yaml",
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
