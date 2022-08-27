local utils = require('core.utils')

local telescope = utils.require('telescope')
local actions = utils.require('telescope.actions')
local pickers = utils.require('telescope.pickers')
local conf = utils.require('telescope.config').values
local previewers = utils.require('telescope.previewers')
local finders = utils.require('telescope.finders')

if not (telescope and actions and pickers and conf and previewers and finders) then return end

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
        ["q"] = "close", -- This ruins macros in the telescope windows but why would I want that
      },
      i = {
        ["<M-v>"] = actions.select_vertical,
        ["<M-s>"] = actions.select_horizontal,
        ["<M-t>"] = actions.select_tab,
      },
    },
  },
  pickers = {
    lsp_references = {
      initial_mode = "normal",
    }
  }
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

telescope.load_extension("ui-select")
