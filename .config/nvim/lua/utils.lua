local M = {
}


---Functional wrapper for mapping custom keybindings
---@param mode string|string[] Mode short-name, see |nvim_set_keymap()|.
---                            Can also be list of modes to create mapping on multiple modes.
---@param lhs string           Left-hand side |{lhs}| of the mapping.
---@param rhs string|function  Right-hand side |{rhs}| of the mapping, can be a Lua function.
---
---@param opts? vim.keymap.set.Opts
function M.map(mode, lhs, rhs, opts)
  vim.keymap.set(mode, lhs, rhs, opts)
end

--- Copy the selected code block to clipboard
---@param opts vim.api.keyset.user_command
function M.copy_code_block(opts)
  local lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, true)

  -- strip leading spaces: smallest indent wins, empty lines ignored
  local min = math.huge
  for _, line in ipairs(lines) do
    if line:find('%S') then
      local n = #(line:match("^%s*") or "")
      if n < min then min = n end
    end
  end
  if min ~= math.huge then
    lines = vim.tbl_map(function(line) return line:sub(min + 1) end, lines)
  end

  local content = table.concat(lines, '\n')
  local result = string.format('```%s\n%s\n```', vim.bo.filetype, content)
  vim.fn.setreg('+', result)
end

return M
