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
      return not require('core.utils').is_vscodevim()
    end
  },

  -- flash for jumping around the file
  {
    "folke/flash.nvim",
    event = "VeryLazy",
    opts = {
      modes = {
        search = { enabled = false },
        char = { enabled = false },
      },
      label = {
        rainbow = {
          enabled = true,
        },
      },
    },
    keys = {
      {
        "<leader>s",
        mode = { "n", "x", "o" },
        function()
          require("flash").jump()
        end,
        desc = "Flash",
      },
      {
        "<leader>S",
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
      return not require('core.utils').is_vscodevim()
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
    "jackMort/ChatGPT.nvim",
    opts = {
      api_key_cmd = nil,
      edit_with_instructions = {
        keymaps = {
          close = "<C-c>",
          accept = "<C-y>",
          toggle_diff = "<C-d>",
          toggle_settings = "<C-s>",
          toggle_help = "<C-h>",
          cycle_windows = "<Tab>",
          use_output_as_input = "<C-a>",
        },
      },
      chat = {
        keymaps = {
          close = "<C-c>",
          yank_last = "<C-y>",
          yank_last_code = "<C-k>",
          scroll_up = "<C-u>",
          scroll_down = "<C-d>",
          new_session = "<C-n>",
          cycle_windows = "<Tab>",
          cycle_modes = "<C-f>",
          next_message = "<C-j>",
          prev_message = "<C-k>",
          select_session = "<Space>",
          rename_session = "r",
          delete_session = "d",
          draft_message = "<C-r>",
          edit_message = "E",
          delete_message = "d",
          toggle_settings = "<C-o>",
          toggle_sessions = "<C-p>",
          toggle_help = "<C-h>",
          toggle_message_role = "<C-r>",
          toggle_system_role_open = "<C-s>",
          stop_generating = "<C-x>",
        },
      },
      openai_params = {
        model = "gpt-4o",
      },
    },
    keys = {
      {
        "<leader>ac",
        ":ChatGPT<CR>",
        desc = "ChatGPT open",
      },
      {
        "<leader>aC",
        ":ChatGPTCompleteCode<CR>",
        desc = "ChatGPT complete code",
      },
      {
        "<leader>ae",
        ":ChatGPTEditWithInstructions<CR>",
        mode = "v",
        desc = "ChatGPT edit with instructions",
      },
      {
        "<leader>aC",
        ":ChatGPTRun complete_code<CR>",
        mode = "v",
        desc = "ChatGPT complete code",
      },
      {
        "<leader>aa",
        ":ChatGPTRun code_readability_analysis<CR>",
        mode = "v",
        desc = "ChatGPT code readability analysis",
      },
      {
        "<leader>aE",
        ":ChatGPTRun explain_code<CR>",
        mode = "v",
        desc = "ChatGPT explain code",
      },
      {
        "<leader>ao",
        ":ChatGPTRun optimize_code<CR>",
        mode = "v",
        desc = "ChatGPT explain code",
      },
      {
        "<leader>af",
        ":ChatGPTRun fix_bugs<CR>",
        mode = "v",
        desc = "ChatGPT fix bugs",
      },
      {
        "<leader>as",
        ":ChatGPTRun summarize<CR>",
        mode = "v",
        desc = "ChatGPT summarize",
      },
      {
        "<leader>at",
        ":ChatGPTRun add_tests<CR>",
        mode = "v",
        desc = "ChatGPT add tests",
      },
      {
        "<leader>ad",
        ":ChatGPTRun docstring<CR>",
        mode = "v",
        desc = "ChatGPT add docstring",
      },
      {
        "q",
        ":q<CR>",
        desc = "Close ChatGPT",
        ft = "chatgpt-input"
      },
    },
    cond = function()
      return vim.fn.getenv("OPENAI_API_KEY") ~= vim.NIL and vim.fn.has("linux") == 1
    end,
    dependencies = {
      "MunifTanjim/nui.nvim",
      "nvim-lua/plenary.nvim",
      {
        "folke/trouble.nvim",
        version = "*",
      },
      "nvim-telescope/telescope.nvim"
    },
  },
  {
    -- "gh.nvim",
    dependencies = { "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim" },
    dir = "~/dotfiles/.config/nvim/lua/gh.nvim",
    opts = {},
    cmd = { "GHBrowse", "GHPRs" },
    -- dev = true,
  },
  {
    "windwp/nvim-ts-autotag",
    opts = {},
    event = { "InsertEnter" },
  }
}
