---@type vim.lsp.Config
return {
  cmd = { "tsc", "--lsp", "--stdio" },
  settings = {
    typescript = {
      inlayHints = {
        parameterNames = {
          enabled = "literals",
          suppressWhenArgumentMatchesName = true,
        },
        parameterTypes = { enabled = true },
        variableTypes = { enabled = true },
        propertyDeclarationTypes = { enabled = true },
        functionLikeReturnTypes = { enabled = true },
        enumMemberValues = { enabled = true },
      },
    },
  },
  filetypes = {
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
  },
  root_dir = function(bufnr, on_dir)
    local root_markers = {
      { "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock" },
      { ".git" },
    }

    local deno_root = vim.fs.root(bufnr, { "deno.json", "deno.jsonc" })
    local deno_lock_root = vim.fs.root(bufnr, { "deno.lock" })
    local project_root = vim.fs.root(bufnr, root_markers)
    if deno_lock_root and (not project_root or #deno_lock_root > #project_root) then return end
    if deno_root and (not project_root or #deno_root >= #project_root) then return end
    on_dir(project_root or vim.fn.getcwd())
  end,
}
