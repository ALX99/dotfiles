local M = {}

local function get_github_url(opts)
  opts = opts or {}

  local file_path = vim.fn.expand("%:.")
  local start_line = tonumber(opts.start_line) or vim.fn.line(".")
  local end_line = opts.end_line and tonumber(opts.end_line) or nil

  if end_line and end_line < start_line then
    start_line, end_line = end_line, start_line
  end

  local file_arg = string.format("%s:%d", file_path, start_line)
  if end_line and end_line ~= start_line then
    file_arg = string.format("%s-%d", file_arg, end_line)
  end

  -- Get upstream branch SHA
  local sha_result = vim.system({ "git", "rev-parse", "@{u}" }, { text = true }):wait()
  local is_upstream = sha_result.code == 0
  local sha = vim.fn.trim(sha_result.stdout or "")

  -- Build gh browse command with proper argument escaping
  local cmd = { "gh", "browse", "--no-browser", file_arg }
  if is_upstream and #sha > 0 then
    table.insert(cmd, "--branch")
    table.insert(cmd, sha)
  else
    table.insert(cmd, "--commit")
  end

  local result = vim.system(cmd, { text = true }):wait()
  local url = vim.fn.trim(result.stdout or "")

  return url, result.code
end

---@param opts? {start_line?: number, end_line?: number}
function M.copy_github_permalink(opts)
  local url, err = get_github_url(opts)

  if err ~= 0 then
    vim.notify("gitgud: " .. url, vim.log.levels.ERROR)
    return
  end

  vim.fn.setreg("+", url)
  vim.notify("Copied GitHub permalink: " .. url, vim.log.levels.INFO)
end

---@param opts? {start_line?: number, end_line?: number}
function M.open_github_file(opts)
  local url, err = get_github_url(opts)

  if err ~= 0 then
    vim.notify("gitgud: " .. url, vim.log.levels.ERROR)
    return
  end

  vim.notify("Opening: " .. url, vim.log.levels.INFO)
  vim.ui.open(url)
end

return M
