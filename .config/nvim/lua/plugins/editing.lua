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
    enabled = function()
      return not require('core.utils').is_vscodevim()
    end
  },

  -- leap for jumping around the file
  {
    "ggandor/leap.nvim",
    event = "VeryLazy",
    keys = {
      { "<leader>t", "<Plug>(leap-forward-to)",  { "n", "v" }, desc = "Leap forwards" },
      { "<leader>a", "<Plug>(leap-backward-to)", { "n", "v" }, desc = "Leap backwards" },
    },
    config = function()
      local leap = require('leap')
      leap.opts.safe_labels = {
        "t", "f", "g", "q", "w", "b", "n", "e", "h", "u", "o", "l", "u",
        "T", "F", "G", "Q", "W", "B", "N", "E", "H", "U", "O", "L", "U" }
      leap.opts.special_keys = {
        next_target = { '<enter>', '.', '<A-n>' },
        prev_target = { '<tab>', ',', '<A-e>' },
      }
    end
  },
}
