if vim.g.vscode then return end

vim.pack.add({
  { src = 'https://github.com/folke/sidekick.nvim', version = vim.version.range('*') },
})
local map = require('utils').map

-- sidekick
require('sidekick').setup({
  cli = {
    mux = {
      backend = "tmux",
      enabled = false,
    },
  },
})

map("n", "<tab>", function()
  if require("sidekick").nes_jump_or_apply() then
    return ""
  end
  return "<Tab>"
end, { expr = true, desc = "Goto/Apply Next Edit Suggestion" })

map({ "n", "t", "i", "x" }, "<c-.>", function() require("sidekick.cli").toggle() end, { desc = "Sidekick Toggle" })
map("n", "<leader>aa", function() require("sidekick.cli").toggle() end, { desc = "Sidekick Toggle CLI" })
map("n", "<leader>as", function() require("sidekick.cli").select() end, { desc = "Select CLI" })
map("n", "<leader>ad", function() require("sidekick.cli").close() end, { desc = "Detach a CLI Session" })
map({ "x", "n" }, "<leader>at", function() require("sidekick.cli").send({ msg = "{this}" }) end, { desc = "Send This" })
map("n", "<leader>af", function() require("sidekick.cli").send({ msg = "{file}" }) end, { desc = "Send File" })
map("x", "<leader>av", function() require("sidekick.cli").send({ msg = "{selection}" }) end,
  { desc = "Send Visual Selection" })
map({ "n", "v" }, "<leader>ap", function()
  require("sidekick.cli").prompt(function(msg)
    if msg then
      require("sidekick.cli").send({ msg = msg, render = false })
      vim.fn.system(
        'tmux display-popup -T "claude" -w 95% -h 95% -E ~/dotfiles/.config/tmux/session-popup claude')
    end
  end)
end, { desc = "Sidekick Ask Prompt" })
