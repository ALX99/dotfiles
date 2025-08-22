return {
  -- harpoon for navigating between files
  {
    "ThePrimeagen/harpoon",
    keys = {
      { "<leader>1", "<cmd>lua require('harpoon.ui').nav_file(1)<cr>",         desc = "Harpoon 1" },
      { "<leader>2", "<cmd>lua require('harpoon.ui').nav_file(2)<cr>",         desc = "Harpoon 2" },
      { "<leader>3", "<cmd>lua require('harpoon.ui').nav_file(3)<cr>",         desc = "Harpoon 3" },
      { "<leader>4", "<cmd>lua require('harpoon.ui').nav_file(4)<cr>",         desc = "Harpoon 4" },
      { "<leader>h", "<cmd>lua require('harpoon.mark').add_file()<cr>",        desc = "Harpoon add file" },
      { "<leader>H", "<cmd>lua require('harpoon.ui').toggle_quick_menu()<cr>", desc = "Harpoon UI" },
    },
    dependencies = {
      'nvim-lua/plenary.nvim',
    },
    cond = function()
      return not vim.g.vscode
    end
  },

  -- flash for jumping around the file
  {
    "folke/flash.nvim",
    event = "VeryLazy",
    opts = {
      labels = "arstgmneiofpludh",
      modes = {
        char = { enabled = false },
      },
    },
    config = function(_, cfg)
      vim.api.nvim_set_hl(0, 'FlashLabel', { fg = '#eb6aa3', bg = '#000000', bold = true })
      require("flash").setup(cfg)
      -- FlashBackdrop     Comment      backdrop
      -- FlashMatch        Search       search matches
      -- FlashCurrent      IncSearch    current match
      -- FlashLabel        Substitute   jump label
      -- FlashPrompt       MsgArea      prompt
      -- FlashPromptIcon   Special      prompt icon
      -- FlashCursor       Cursor       cursor
    end,
    keys = {
      {
        "s",
        mode = { "n", "x", "o" },
        function()
          require("flash").jump()
        end,
        desc = "Flash",
      },
      {
        "S",
        mode = { "n", "x", "o" },
        function()
          require("flash").treesitter()
        end,
        desc = "Flash Treesitter",
      },
      {
        "r",
        mode = "o",
        function()
          require("flash").remote()
        end,
        desc = "Remote Flash",
      },
      {
        "R",
        mode = { "o", "x" },
        function()
          require("flash").treesitter_search()
        end,
        desc = "Flash Treesitter Search",
      },
      {
        "<a-s>",
        mode = { "c" },
        function()
          require("flash").toggle()
        end,
        desc = "Toggle Flash Search",
      },
    },
  },
  {
    "abecodes/tabout.nvim",
    event = { "BufReadPost", "BufNewFile" },
    dependencies = { "nvim-treesitter/nvim-treesitter" },
    config = true,
    enabled = false,
    cond = function()
      return not vim.g.vscode
    end
  },
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
    "zbirenbaum/copilot.lua",
    event = "VeryLazy",
    cond = function()
      return not vim.g.vscode
    end,
    enabled = false,
    opts = {
      panel = {
        enabled = false,
      },
      suggestion = {
        auto_trigger = true,
        keymap = {
          accept = "<A-CR>",
        },
      },
    }
  },
  {
    -- "gh.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    dir = "~/dotfiles/.config/nvim/lua/gh.nvim",
    opts = {},
    cmd = { "GHBrowse", "GHPRs" },
    -- dev = true,
  },
  {
    "windwp/nvim-ts-autotag",
    enabled = false,
    cond = function()
      return not vim.g.vscode
    end,
    opts = {},
    event = { "InsertEnter" },
  },
  {
    dir = "~/dotfiles/.config/nvim/lua/custom_plugins/vscode",
    config = function()
      require("custom_plugins.vscode").setup()
    end,
    cond = function()
      return vim.g.vscode
    end,
  },
  {
    "coder/claudecode.nvim",
    dependencies = { "folke/snacks.nvim" },
    config = true,
    cond = function()
      return vim.fn.has("mac") == 1
    end,
    keys = {
      { "<leader>a", nil, desc = "AI/Claude Code" },
      { "<leader>ac", "<cmd>ClaudeCode<cr>", desc = "Toggle Claude" },
      { "<leader>af", "<cmd>ClaudeCodeFocus<cr>", desc = "Focus Claude" },
      { "<leader>ar", "<cmd>ClaudeCode --resume<cr>", desc = "Resume Claude" },
      { "<leader>aC", "<cmd>ClaudeCode --continue<cr>", desc = "Continue Claude" },
      { "<leader>am", "<cmd>ClaudeCodeSelectModel<cr>", desc = "Select Claude model" },
      { "<leader>ab", "<cmd>ClaudeCodeAdd %<cr>", desc = "Add current buffer" },
      { "<leader>as", "<cmd>ClaudeCodeSend<cr>", mode = "v", desc = "Send to Claude" },
      {
        "<leader>as",
        "<cmd>ClaudeCodeTreeAdd<cr>",
        desc = "Add file",
        ft = { "NvimTree", "neo-tree", "oil", "minifiles" },
      },
      -- Diff management
      { "<leader>aa", "<cmd>ClaudeCodeDiffAccept<cr>", desc = "Accept diff" },
      { "<leader>ad", "<cmd>ClaudeCodeDiffDeny<cr>", desc = "Deny diff" },
    },
  }
}
