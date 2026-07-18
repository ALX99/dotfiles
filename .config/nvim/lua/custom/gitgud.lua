local M = {}

---@param file_path? string
---@return { root: string, file: string, relative_file: string }|nil
---@return string|nil
function M.file_repo(file_path)
  local file = file_path or vim.api.nvim_buf_get_name(0)
  if file == "" then
    return nil, "Current buffer has no file"
  end

  file = vim.fs.normalize(vim.fn.fnamemodify(file, ":p"))
  local function find_root(path)
    return vim.system(
      { "git", "-C", vim.fs.dirname(path), "rev-parse", "--show-toplevel" },
      { text = true }
    ):wait()
  end

  local result = find_root(file)
  if result.code ~= 0 then
    local real_file = vim.uv.fs_realpath(file)
    if real_file then
      file = vim.fs.normalize(real_file)
      result = find_root(file)
    end
  end
  if result.code ~= 0 then
    return nil, "File is not in a Git repository"
  end

  local root = vim.trim(result.stdout or "")
  local relative_file = vim.fs.relpath(root, file)
  if not relative_file then
    return nil, "File is outside the Git repository"
  end

  return {
    root = root,
    file = file,
    relative_file = relative_file,
  }
end

local function get_github_url(opts)
  opts = opts or {}

  local repo, repo_err = M.file_repo()
  if not repo then
    return "", 1, repo_err
  end

  local tracked = vim.system(
    { "git", "ls-files", "--error-unmatch", "--", repo.relative_file },
    { cwd = repo.root, text = true }
  ):wait()
  if tracked.code ~= 0 then
    return "", tracked.code, "File is untracked"
  end

  local start_line = tonumber(opts.start_line) or vim.fn.line(".")
  local end_line = opts.end_line and tonumber(opts.end_line) or nil

  if end_line and end_line < start_line then
    start_line, end_line = end_line, start_line
  end

  local file_arg = string.format("%s:%d", repo.relative_file, start_line)
  if end_line and end_line ~= start_line then
    file_arg = string.format("%s-%d", file_arg, end_line)
  end

  -- Get upstream branch SHA
  local sha_result = vim.system({ "git", "rev-parse", "@{u}" }, { cwd = repo.root, text = true }):wait()
  local is_upstream = sha_result.code == 0
  local sha = vim.trim(sha_result.stdout or "")

  -- Build gh browse command with proper argument escaping
  local cmd = { "gh", "browse", "--no-browser", file_arg }
  if is_upstream and #sha > 0 then
    table.insert(cmd, "--branch")
    table.insert(cmd, sha)
  else
    table.insert(cmd, "--commit")
  end

  local result = vim.system(cmd, { cwd = repo.root, text = true }):wait()
  local url = vim.trim(result.stdout or "")
  local stderr = vim.trim(result.stderr or "")

  return url, result.code, stderr
end

---@param opts? {start_line?: number, end_line?: number}
function M.copy_github_permalink(opts)
  local url, err, stderr = get_github_url(opts)

  if err ~= 0 then
    vim.notify("gitgud: " .. (stderr ~= "" and stderr or ("gh exited with code " .. err)), vim.log.levels.ERROR)
    return
  end

  vim.fn.setreg("+", url)
  vim.notify("Copied GitHub permalink: " .. url, vim.log.levels.INFO)
end

---@param opts? {start_line?: number, end_line?: number}
function M.open_github_file(opts)
  local url, err, stderr = get_github_url(opts)

  if err ~= 0 then
    vim.notify("gitgud: " .. (stderr ~= "" and stderr or ("gh exited with code " .. err)), vim.log.levels.ERROR)
    return
  end

  vim.notify("Opening: " .. url, vim.log.levels.INFO)
  vim.ui.open(url)
end

return M
