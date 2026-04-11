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

  local sha = vim.fn.system("git rev-parse @{u} 2>/dev/null")
  local is_upstream = (vim.v.shell_error == 0)
  sha = vim.fn.trim(sha)

  local cmd
  if is_upstream and #sha > 0 then
    cmd = string.format(
      "gh browse --no-browser %s --branch %s 2>&1",
      vim.fn.shellescape(file_arg),
      vim.fn.shellescape(sha)
    )
  else
    cmd = string.format(
      "gh browse --no-browser %s --commit 2>&1",
      vim.fn.shellescape(file_arg)
    )
  end

  local url = vim.fn.system(cmd)
  url = vim.fn.trim(url)

  return url, vim.v.shell_error
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
  if vim.ui.open then
    vim.ui.open(url)
  else
    local os_name = vim.uv.os_uname().sysname
    local opener = "xdg-open"
    if os_name == "Darwin" then opener = "open" end
    vim.fn.jobstart({opener, url}, {detach = true})
  end
end

return M
