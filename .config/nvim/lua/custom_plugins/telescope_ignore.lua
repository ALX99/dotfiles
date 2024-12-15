local M = {}

function M.toggle_ignore_patterns()
  if vim.g.ignore_patterns_enabled then
    require("telescope.config").set_defaults({ file_ignore_patterns = {} })
    vim.g.ignore_patterns_enabled = false
    vim.notify("Telescope FIP disabled", vim.log.levels.INFO)
    return
  end

  local ignore_pattern = vim.b.ts_fip or {}
  require("telescope.config").set_defaults({ file_ignore_patterns = ignore_pattern })
  vim.g.ignore_patterns_enabled = true
  vim.notify("Telescope FIP set to " .. vim.inspect(ignore_pattern), vim.log.levels.INFO)
end

function M.setup()
  vim.api.nvim_create_user_command('ToggleTelescopeIgnore', M.toggle_ignore_patterns,
    { desc = 'Toggle telescope ignore patterns' })

  vim.api.nvim_create_autocmd("BufReadPost", {
    callback = function()
      local ignore_pattern = vim.b.ts_fip
      if ignore_pattern ~= nil and vim.g.ignore_patterns_enabled ~= false then
        require("telescope.config").set_defaults({ file_ignore_patterns = ignore_pattern })
        vim.g.ignore_patterns_enabled = true
        vim.notify("Telescope FIP set to " .. vim.inspect(ignore_pattern), vim.log.levels.INFO)
      end
    end,
  })
end

return M
