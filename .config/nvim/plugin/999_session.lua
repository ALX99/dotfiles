-- Auto-session management
local session_dir = vim.fn.expand(vim.fn.stdpath("state") .. "/sessions")

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
    if vim.fn.argc() == 0 and vim.fn.filereadable(session_file) ~= 0 then
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
    if vim.fn.argc() == 0 and vim.fn.getcwd() ~= vim.env.HOME then
      vim.cmd("mks! " .. vim.fn.fnameescape(get_session_file()))
    end
  end,
  group = session_group,
  once = true,
})