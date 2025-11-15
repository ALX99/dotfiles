return {
  {
    "github/copilot.vim",
    event = { "VeryLazy" },
    init = function(_)
      vim.g.copilot_no_tab_map = true
      vim.g.copilot_filetypes = {
        minifiles = false,
      }
    end,
    cond = function()
      return not vim.g.vscode
    end,
    -- enabled = false,
    config = function()
      -- vim.g.copilot_assume_mapped = true

      local map = require('core.utils').map
      map(
        "i",
        "<A-CR>",

        'copilot#Accept("<CR>")',
        {
          silent = true,
          expr = true,
          script = true,
          replace_keycodes = false,
          desc = "Accept copilot suggestion"
        }
      )

      map({ "i", "n" }, "<A-p>", '<Esc>:Copilot panel<CR>', { desc = "Open copilot panel" })
      map("i", "<C-n>", "<Plug>(copilot-next)", { desc = "Next copilot suggestion" })
      map("i", "<C-e>", "<Plug>(copilot-previous)", { desc = "Previous copilot suggestion" })
      map("i", "<A-o>", "<Plug>(copilot-accept-line)", { desc = "Accept copilot line" })
      map("i", "<A-i>", "<Plug>(copilot-accept-word)", { desc = "Accept copilot word" })
      -- keymap("i", "<C-o>", "<Plug>(copilot-dismiss)")
      -- keymap("i", "<C-s>", "<Plug>(copilot-suggest)")
    end,
    keys = {
      {
        "q",
        ":q<CR>",
        desc = "Close Copilot",
        ft = "copilot.lua"
      },
    }
  },
  {
    "folke/sidekick.nvim",
    version = "*",
    event = "VeryLazy",
    cond = function()
      return not vim.g.vscode
    end,
    opts = {
      cli = {
        mux = {
          backend = "tmux",
          enabled = false,
        },
      },
    },
    keys = {
      {
        "<tab>",
        function()
          -- if there is a next edit, jump to it, otherwise apply it if any
          if not require("sidekick").nes_jump_or_apply() then
            return "<Tab>" -- fallback to normal tab
          end
        end,
        expr = true,
        desc = "Goto/Apply Next Edit Suggestion",
      },
      {
        "<c-.>",
        function() require("sidekick.cli").toggle() end,
        desc = "Sidekick Toggle",
        mode = { "n", "t", "i", "x" },
      },
      {
        "<leader>aa",
        function() require("sidekick.cli").toggle() end,
        desc = "Sidekick Toggle CLI",
      },
      {
        "<leader>as",
        function() require("sidekick.cli").select() end,
        -- Or to select only installed tools:
        -- require("sidekick.cli").select({ filter = { installed = true } })
        desc = "Select CLI",
      },
      {
        "<leader>ad",
        function() require("sidekick.cli").close() end,
        desc = "Detach a CLI Session",
      },
      {
        "<leader>at",
        function() require("sidekick.cli").send({ msg = "{this}" }) end,
        mode = { "x", "n" },
        desc = "Send This",
      },
      {
        "<leader>af",
        function() require("sidekick.cli").send({ msg = "{file}" }) end,
        desc = "Send File",
      },
      {
        "<leader>av",
        function() require("sidekick.cli").send({ msg = "{selection}" }) end,
        mode = { "x" },
        desc = "Send Visual Selection",
      },
      {
        "<leader>ap",
        function()
          require("sidekick.cli").prompt(function(msg)
            if msg then
              require("sidekick.cli").send({ msg = msg, render = false })
              vim.fn.system(
                'tmux display-popup -T "claude" -w 95% -h 95% -E ~/dotfiles/.config/tmux/session-popup claude')
            end
          end)
        end,
        desc = "Sidekick Ask Prompt",
        mode = { "n", "v" },
      },
    },
  },
}
