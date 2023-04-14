return {
  "numToStr/FTerm.nvim",
  cmd = "FTermToggle",
  keys = {
    {
      "<M-t>",
      "<cmd>FTermToggle<CR>",
      mode = { "n", "t" },
      desc =
      "Toggle floating term"
    },
    { "<leader>Pg", "<cmd>lua require('FTerm').scratch({ cmd = 'lazygit', border = 'none' })<CR>", desc = "LazyGit" },
  },
  config = function()
    vim.api.nvim_create_user_command('FTermToggle', require('FTerm').toggle, { bang = true })
  end,
  enabled = function()
    return not require('core.utils').is_vscodevim()
  end
}
