local utils_ok, utils = pcall(require, 'alx99.utils')
if not utils_ok then
  vim.notify("Could not load utils", vim.log.levels.ERROR)
  return
end
local actions_ok, actions = pcall(require, 'telescope.actions')
if not actions_ok then
  vim.notify("Could not load telescope actions", vim.log.levels.ERROR)
  return
end
local telescope_ok, telescope = pcall(require, 'telescope')
if not telescope_ok then
  vim.notify("Could not load telescope", vim.log.levels.ERROR)
  return
end
local pickers_ok, pickers = pcall(require, 'telescope.pickers')
if not pickers_ok then
  vim.notify("Could not load telescope.pickers", vim.log.levels.ERROR)
  return
end

local conf = require("telescope.config").values
local previewers = require "telescope.previewers"
local finders = require "telescope.finders"


telescope.setup {
  defaults = {
    mappings = {
      n = {
        ["n"] = actions.move_selection_next,
        ["j"] = false,
        ["e"] = actions.move_selection_previous,
        ["k"] = false,
        ["<C-t>"] = false,
        ["t"] = actions.select_tab,
        ["<C-v>"] = false,
        ["v"] = actions.select_vertical,
        ["<C-x>"] = false,
        ["s"] = actions.select_horizontal,
      },
      i = {
        ["<M-v>"] = actions.select_vertical,
        ["<M-s>"] = actions.select_horizontal,
        ["<M-t>"] = actions.select_tab,
      },
    },
  },
}

-- Open any dotfiles
utils.map("n", "<leader><leader>d", function()
  pickers.new({}, {
    prompt_title = '~~ dotfiles ~~',
    finder = finders.new_oneshot_job({
      "fd", "--hidden", "--color", "never", "--type", "file", ".", os.getenv("HOME") .. "/dotfiles"
    }),
    previewer = previewers.vim_buffer_cat.new({}),
    sorter = conf.file_sorter({}),
  }):find()
end)
