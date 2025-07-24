return {
  -- cmd = { vim.fn.getenv("HOME") .. "/go/bin/gopls" },
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
      gofumpt = true,
      staticcheck = true,
      usePlaceholders = false,
      semanticTokens = true,
      directoryFilters = { "-.git", "-.vscode", "-.idea", "-.vscode-test", "-node_modules" },
      codelenses = {
        gc_details = true,
        generate = true,
        regenerate_cgo = true,
        run_govulncheck = true,
        test = true,
        tidy = true,
        upgrade_dependency = true,
        vendor = true,
      },
      -- https://github.com/golang/tools/blob/master/gopls/doc/analyzers.md
      analyses = {
        staticcheck = true,
        shadow = true,
      },
    },
  },
}
