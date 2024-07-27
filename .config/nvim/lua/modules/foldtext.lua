---@module Foldtext
---Based on https://www.reddit.com/r/neovim/comments/16sqyjz/finally_we_can_have_highlighted_folds/
---Updated with vim.treesitter._fold.foldtext()
---https://github.com/Wansmer/nvim-config/blob/a6a8c7e4c9237190e80b46726c23d4594bf01945/lua/modules/foldtext.lua

local function get_line(bufnr, linenr)
  if bufnr == 0 then
    bufnr = vim.api.nvim_get_current_buf()
  end
  return vim.api.nvim_buf_get_lines(bufnr, linenr - 1, linenr, false)[1]
end
local function parse_line(linenr)
  local bufnr = vim.api.nvim_get_current_buf()

  local line = get_line(bufnr, linenr)
  if not line then
    return nil
  end

  local ok, parser = pcall(vim.treesitter.get_parser, bufnr)
  if not ok then
    return nil
  end

  local query = vim.treesitter.query.get(parser:lang(), "highlights")
  if not query then
    return nil
  end

  local tree = parser:parse({ linenr - 1, linenr })[1]

  local result = {}

  local line_pos = 0

  for id, node, metadata in query:iter_captures(tree:root(), 0, linenr - 1, linenr) do
    local name = query.captures[id]
    local start_row, start_col, end_row, end_col = node:range()

    local priority = tonumber(metadata.priority or vim.highlight.priorities.treesitter)

    if start_row == linenr - 1 and end_row == linenr - 1 then
      -- check for characters ignored by treesitter
      if start_col > line_pos then
        table.insert(result, {
          line:sub(line_pos + 1, start_col),
          { { "Folded", priority } },
          range = { line_pos, start_col },
        })
      end
      line_pos = end_col

      local text = line:sub(start_col + 1, end_col)
      table.insert(result, { text, { { "@" .. name, priority } }, range = { start_col, end_col } })
    end
  end

  local i = 1
  while i <= #result do
    -- find first capture that is not in current range and apply highlights on the way
    local j = i + 1
    while j <= #result and result[j].range[1] >= result[i].range[1] and result[j].range[2] <= result[i].range[2] do
      for k, v in ipairs(result[i][2]) do
        if not vim.tbl_contains(result[j][2], v) then
          table.insert(result[j][2], k, v)
        end
      end
      j = j + 1
    end

    -- remove the parent capture if it is split into children
    if j > i + 1 then
      table.remove(result, i)
    else
      -- highlights need to be sorted by priority, on equal prio, the deeper nested capture (earlier
      -- in list) should be considered higher prio
      if #result[i][2] > 1 then
        table.sort(result[i][2], function(a, b)
          return a[2] < b[2]
        end)
      end

      result[i][2] = vim.tbl_map(function(tbl) return tbl[1] end, result[i][2])
      result[i] = { result[i][1], result[i][2] }

      i = i + 1
    end
  end

  return result
end

function HighlightedFoldtext()
  local result = parse_line(vim.v.foldstart)
  if not result then
    return vim.fn.foldtext()
  end

  local next_line = get_line(0, vim.v.foldstart + 1)
  if not next_line then
    return vim.fn.foldtext()
  end

  -- If only folding one line
  if vim.v.foldend - vim.v.foldstart == 1 then
    table.insert(result, { " ", "" })
    -- If we are folding two lines and the next is not empty, show the line
  elseif vim.v.foldend - vim.v.foldstart == 2 and next_line:match("^%s*$") == nil then
    local result2 = parse_line(vim.v.foldstart + 1)
    if result2 then
      table.insert(result, { " ", "" })

      local first = result2[1]
      result2[1] = { vim.trim(first[1]), first[2] }
      for _, item in ipairs(result2) do
        table.insert(result, item)
      end

      table.insert(result, { " ", "" })
    end
  else
    local folded = {
      { " ",                                                    "FoldedIcon" },
      { "+" .. vim.v.foldend - vim.v.foldstart - 1 .. " lines", "FoldedText" },
      { " ",                                                    "FoldedIcon" },
    }
    for _, item in ipairs(folded) do
      table.insert(result, item)
    end
  end


  local result2 = parse_line(vim.v.foldend)
  if result2 then
    local first = result2[1]
    result2[1] = { vim.trim(first[1]), first[2] }
    for _, item in ipairs(result2) do
      table.insert(result, item)
    end
  end

  return result
end

local function set_fold_hl()
  local cl = vim.api.nvim_get_hl(0, { name = "CursorLineNr" })
  vim.api.nvim_set_hl(0, "FoldedIcon", { fg = cl.bg })
  vim.api.nvim_set_hl(0, "FoldedText", { bg = cl.bg, fg = cl.fg, italic = true })
end

set_fold_hl()

vim.api.nvim_create_autocmd("ColorScheme", {
  callback = set_fold_hl,
})

return 'luaeval("HighlightedFoldtext")()'
