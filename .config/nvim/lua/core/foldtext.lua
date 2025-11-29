function _G.CustomFoldText()
  local start_line = vim.v.foldstart
  local first_line_text = vim.fn.getline(start_line)

  -- Handle Go's "if err != nil" specifically with manual highlighting
  if first_line_text:match("if%s+err%s*!=%s*nil") then
    local end_line = vim.v.foldend
    local lines_count = end_line - start_line + 1
    local indent_level = vim.fn.indent(start_line)
    local indent_str = string.rep(" ", indent_level)

    local result = { { indent_str, "Normal" } }

    -- Construct the "if err != nil {" part with highlights
    table.insert(result, { "if", "Conditional" })
    table.insert(result, { " ", "Normal" })
    table.insert(result, { "err", "Identifier" })
    table.insert(result, { " ", "Normal" })
    table.insert(result, { "!=", "Operator" })
    table.insert(result, { " ", "Normal" })
    table.insert(result, { "nil", "Constant" })
    table.insert(result, { " ", "Normal" })
    table.insert(result, { "{", "Delimiter" })

    -- Retrieve and process the body lines
    local body_lines = vim.api.nvim_buf_get_lines(0, start_line, end_line, false)

    local lines_to_join = {}
    for _, line in ipairs(body_lines) do
      local trimmed = line:match("^%s*(.-)%s*$")
      if trimmed ~= "" then
        -- Remove trailing } if it is the last character (end of block)
        trimmed = trimmed:gsub("%s*}$", "")
        if trimmed ~= "" then
          table.insert(lines_to_join, trimmed)
        end
      end
    end

    local content = table.concat(lines_to_join, "; ")

    -- Add the content as a comment/faded text
    table.insert(result, { " " .. content .. " }", "Comment" })

    -- Add line count
    local count_text = string.format(" (%d lines) ", lines_count)
    table.insert(result, { count_text, "Comment" })

    return result
  end

  -- Fallback to standard vim foldtext for everything else
  return vim.fn.foldtext()
end

vim.opt.foldtext = 'v:lua.CustomFoldText()'
