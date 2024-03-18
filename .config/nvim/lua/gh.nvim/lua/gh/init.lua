local pickers = require "telescope.pickers"
local finders = require "telescope.finders"
local previewers = require "telescope.previewers"
local conf = require("telescope.config").values
local actions = require "telescope.actions"
local action_state = require "telescope.actions.state"
local job = require('plenary.job')

local M = {}

function M.setup(opts)
  vim.api.nvim_create_user_command(
    "GHPRs",
    M.browse_pr,
    { desc = "Browse pull requests" }
  )

  vim.api.nvim_create_user_command(
    "GHBrowse",
    M.browse_file,
    { desc = "Browse file on Github" }
  )
end

local function gh(args)
  job:new({
    command = 'gh',
    args = args,
    on_exit = function(j, return_val)
      print(vim.inspect(j:result()))
    end,
  }):start()
end

function M.browse_file()
  local relative_file = vim.fn.fnamemodify(vim.fn.expand('%'), ':.')
  local line = vim.fn.line('.')
  gh({ "browse", relative_file .. ':' .. line })
end

function M.browse_pr()
  pickers.new(require("telescope.themes").get_dropdown {
    -- :h telescope.defaults.layout_config
    layout_strategy = "center",
    layout_config = {
      width = {
        padding = 4
      },
      height = function(_, _, max_lines)
        return math.min(max_lines, 1)
      end,
    },
  }, {
    prompt_title = "Pull Requests",
    previewer = previewers.new_termopen_previewer {
      title = "Description",
      get_command = function(entry)
        return { "gh", "pr", "view", entry.value.number }
      end,
    },
    finder = finders.new_dynamic {
      fn = function()
        local res, code = require('plenary.job'):new({
          command = 'gh',
          args = { "pr", "list", "--json", "number,title,author" },
        }):sync()
        if code ~= 0 then
          vim.notify("Error: " .. vim.inspect(res), vim.log.levels.ERROR)
          return {}
        end
        return vim.fn.json_decode(res[1])
      end,
      entry_maker = function(entry)
        return {
          value = entry,
          ordinal = entry.number,
          display = string.format('#%d %s (%s)', entry.number, entry.title, entry.author.login),
        }
      end,
    },
    sorter = conf.generic_sorter({}),
    attach_mappings = function(prompt_bufnr, _)
      actions.select_default:replace(function()
        actions.close(prompt_bufnr)
        local selection = action_state.get_selected_entry()
        if not selection then
          return
        end
        gh({ "browse", selection.value.number })
      end)
      return true
    end,
  }):find()
end

return M
