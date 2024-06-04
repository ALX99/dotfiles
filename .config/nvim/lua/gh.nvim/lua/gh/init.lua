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
  pickers.new(require("telescope.themes").get_ivy {
    -- :h telescope.defaults.layout_config
    layout_config = {
      height = {
        padding = 0.4,
      },
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
        local res = vim.system({ "gh", "pr", "list", "--json", "number,title,author" }, { text = true }):wait()
        if res.code ~= 0 then
          vim.notify("Error: " .. vim.inspect(res.stderr), vim.log.levels.ERROR)
          return {}
        end
        return vim.fn.json_decode(res.stdout)
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
    attach_mappings = function(prompt_bufnr, map)
      actions.select_default:replace(function()
      end)

      map("n", "b", function(prompt_bufnr)
        local entry = action_state.get_selected_entry()
        if not entry then return end
        gh({ "browse", entry.value.number })
      end)

      map("n", "c", function(prompt_bufnr)
        local entry = action_state.get_selected_entry()
        if not entry then return end

        vim.system({ 'git', 'stash', 'push', '--all', '--message', 'gh.lua review start' }, { text = true }):wait()

        local bufnr = vim.api.nvim_create_buf(false, true)

        vim.api.nvim_command('split')
        vim.api.nvim_set_current_buf(bufnr)

        local job_id = vim.fn.termopen("gh pr checkout " .. entry.value.number, {
          on_exit = function(_, exit_code, _)
            if exit_code == 0 then
              vim.api.nvim_buf_delete(bufnr, { force = false })
            end
          end
        })
        if job_id <= 0 then
          vim.notify("Error: Failed to start job", vim.log.levels.ERROR)
        end

        -- wait for the job to finish
        vim.fn.jobwait({ job_id }, 10000)

        vim.cmd('bufdo e!')
      end)

      return true -- return true means to keep default_mappings
    end,
  }):find()
end

return M
