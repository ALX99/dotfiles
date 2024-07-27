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


-- Functional wrapper for mapping custom keybindings
function M.map(mode, lhs, rhs, opts)
  local options = { noremap = true }
  if opts then
    options = vim.tbl_extend("force", options, opts)
  end
  vim.keymap.set(mode, lhs, rhs, options)
end

function M.is_vscodevim()
  if vim.g.vscode then
    return true
  else
    return false
  end
end

function M.is_linux()
  return vim.uv.os_uname().sysname == "Linux"
end

-- Copies the Github permalink of the current file and line/selection to the clipboard.
-- If the commit hash does not exist on the current branch, it will use the latest commit on the remote branch.
function M.copy_github_permalink()
  local function get_git_branch()
    local branch = vim.fn.system('git rev-parse --abbrev-ref HEAD')
    return vim.fn.trim(branch)
  end

  local function get_repo_url()
    local repo_url = vim.fn.system('git config --get remote.origin.url')
    repo_url = repo_url:gsub("git@github.com:", "https://github.com/")
    repo_url = repo_url:gsub("%.git", "")
    return vim.fn.trim(repo_url)
  end

  local function get_commit_hash(branch)
    local commit_hash = vim.fn.system('git rev-parse ' .. branch)
    return vim.fn.trim(commit_hash)
  end

  local function check_commit_exists_on_github(commit)
    local result = vim.fn.system('git ls-remote origin ' .. commit)
    return result ~= ""
  end

  local function get_latest_commit_hash_on_github(branch)
    local result = vim.fn.system('git ls-remote origin ' .. branch .. ' | tail -n 1')
    local commit_hash = vim.split(result, '\t')[1]
    return vim.fn.trim(commit_hash)
  end

  local file_path = vim.fn.expand('%:.')
  local line_number = vim.fn.line('.')
  local end_line = vim.fn.line("'>")
  local branch = get_git_branch()
  local repo_url = get_repo_url()
  local commit_hash = get_commit_hash(branch)


  if not check_commit_exists_on_github(commit_hash) then
    commit_hash = get_latest_commit_hash_on_github(branch)
  end

  local permalink = repo_url .. "/blob/" .. commit_hash .. "/" .. file_path .. "#L" .. line_number
  if end_line ~= 0 then
    permalink = permalink .. "-L" .. end_line
  end

  vim.fn.setreg("+", permalink)
  print("Copied GitHub permalink to clipboard: " .. permalink)
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
