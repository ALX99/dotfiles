return {
  "iamcco/markdown-preview.nvim",
  cmd = { "MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle" },
  enabled = vim.fn.executable("yarn") == 1,
  build = "cd app && yarn install",
}
