-- Auto-session management
if vim.g.vscode then
  return
end
local session_dir = vim.fs.joinpath(vim.fn.stdpath("state"), "sessions")

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

  -- Don't save/restore if files were passed on the command line
  if vim.fn.argc() > 0 then
    return false
  end

  -- Don't save in skip directories
  if vim.tbl_contains(skip_dirs, cwd) then
    return false
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
vim.fn.mkdir(session_dir, "p")

local session_group = vim.api.nvim_create_augroup("auto_sessions", { clear = true })

-- Capture the session file path once at startup. Recomputing it at VimLeavePre
-- would hash whatever directory a mid-session `:cd` left as the cwd, orphaning
-- the session state that was actually restored at VimEnter.
local active_session_file

_G.Config.new_autocmd("VimEnter", {
  desc = "Restore previous session",
  callback = function()
    if should_save_session() then
      active_session_file = get_session_file()
      if vim.fn.filereadable(active_session_file) ~= 0 then
        -- Session files may contain benign errors (e.g. %argdel with empty arglist).
        -- silent! is the canonical way to source them: keep going regardless.
        vim.cmd('silent! source ' .. vim.fn.fnameescape(active_session_file))
      end
    end
  end,
  group = session_group,
  nested = true,
  once = true,
})

_G.Config.new_autocmd("VimLeavePre", {
  desc = "Save session",
  callback = function()
    if active_session_file and should_save_session() then
      vim.cmd("mks! " .. vim.fn.fnameescape(active_session_file))
    end
  end,
  group = session_group,
  once = true,
})
