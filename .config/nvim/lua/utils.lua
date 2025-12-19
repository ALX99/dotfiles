local M = {
}


---strip leading spaces
---@param lines table<string>
---@return table<string>
local function strip_leading_spaces(lines)
  local spaces_to_trim_cnt = nil

  for _, line in ipairs(lines) do
    if line ~= "" then
      local space_count = #line:match("^(%s*)")

      if not spaces_to_trim_cnt or space_count < spaces_to_trim_cnt then
        spaces_to_trim_cnt = space_count
      end
    end
  end

  -- If all lines are empty, return them as is
  if not spaces_to_trim_cnt then
    return lines
  end

  -- Strip the leading spaces from each line
  local stripped_lines = {}
  for _, line in ipairs(lines) do
    -- Remove the leading spaces
    table.insert(stripped_lines, line:sub(spaces_to_trim_cnt + 1))
  end

  return stripped_lines
end


---Functional wrapper for mapping custom keybindings
---@param mode string|string[] Mode short-name, see |nvim_set_keymap()|.
---                            Can also be list of modes to create mapping on multiple modes.
---@param lhs string           Left-hand side |{lhs}| of the mapping.
---@param rhs string|function  Right-hand side |{rhs}| of the mapping, can be a Lua function.
---
---@param opts? vim.keymap.set.Opts
function M.map(mode, lhs, rhs, opts)
  local options = { noremap = true }
  if opts then
    options = vim.tbl_extend("force", options, opts)
  end
  vim.keymap.set(mode, lhs, rhs, options)
end

function M.is_linux()
  return vim.uv.os_uname().sysname == "Linux"
end

function M.copy_github_permalink()
  local file_path = vim.fn.expand('%:.')
  local line_number = vim.fn.line('.')
  local end_line = vim.fn.line("'>")

  local file_arg = file_path .. ':' .. line_number
  if end_line ~= 0 then
    file_arg = file_arg .. '-' .. end_line
  end

  local url = vim.fn.system('gh browse --no-browser ' .. vim.fn.shellescape(file_arg) .. ' --commit 2>&1')
  url = vim.fn.trim(url)

  if vim.v.shell_error ~= 0 then
    print("Error: " .. url)
    return
  end

  vim.fn.setreg("+", url)
  print("Copied GitHub permalink: " .. url)
end

--- Copy the selected code block to clipboard
---@param opts vim.api.keyset.user_command
function M.copy_code_block(opts)
  local lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, true)
  local content = table.concat(strip_leading_spaces(lines), '\n')
  local result = string.format('```%s\n%s\n```', vim.bo.filetype, content)
  vim.fn.setreg('+', result)
end

return M
