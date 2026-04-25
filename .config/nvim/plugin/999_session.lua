-- Auto-session management
local session_dir = vim.fn.expand(vim.fn.stdpath("state") .. "/sessions")

-- Directories where sessions should not be saved
local skip_dirs = {
  vim.env.HOME,
  "/",
  "/tmp",
  vim.fn.stdpath("state"),
  vim.fn.stdpath("data"),
  vim.fn.stdpath("config"),
}

local function should_save_session()
  local cwd = vim.fn.getcwd()

  -- Don't save if no files are open
  if vim.fn.argc() > 0 then
    return false
  end

  -- Don't save in skip directories
  for _, dir in ipairs(skip_dirs) do
    if cwd == dir then
      return false
    end
  end

  -- Don't save if directory doesn't exist or isn't accessible
  if vim.fn.isdirectory(cwd) ~= 1 then
    return false
  end

  return true
end

local function get_session_file()
  local cwd = vim.fn.getcwd()
  return session_dir .. "/" .. vim.fn.sha256(cwd) .. ".vim"
end

-- Create the dir if it doesn't exist
if vim.fn.isdirectory(session_dir) == 0 then
  vim.fn.mkdir(session_dir, "p")
end

local session_group = vim.api.nvim_create_augroup("auto_sessions", { clear = true })

vim.api.nvim_create_autocmd("VimEnter", {
  desc = "Restore previous session",
  callback = function()
    local session_file = get_session_file()
    if should_save_session() and vim.fn.filereadable(session_file) ~= 0 then
      -- Session files may contain benign errors (e.g. %argdel with empty arglist).
      -- silent! is the canonical way to source them: keep going regardless.
      vim.cmd('silent! source ' .. vim.fn.fnameescape(session_file))
    end
  end,
  group = session_group,
  nested = true,
  once = true,
})

vim.api.nvim_create_autocmd("VimLeavePre", {
  desc = "Save session",
  callback = function()
    if should_save_session() then
      vim.cmd("mks! " .. vim.fn.fnameescape(get_session_file()))
    end
  end,
  group = session_group,
  once = true,
})

