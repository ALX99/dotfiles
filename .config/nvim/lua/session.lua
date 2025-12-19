local M = {
  dir = vim.fn.expand(vim.fn.stdpath("state") .. "/sessions")
}

function M.setup()
  -- Create the dir if it doesn't exists
  if vim.fn.isdirectory(M.dir) == 0 then
    vim.fn.mkdir(M.dir, "p")
  end

  local session_group = vim.api.nvim_create_augroup("auto_sessions", { clear = true })

  vim.api.nvim_create_autocmd("VimEnter", {
    desc = "Restores the previous session",
    callback = function()
      local session_file = M.get_session_file()
      if vim.fn.argc() == 0 and vim.fn.filereadable(session_file) ~= 0 then
        vim.cmd("silent! source " .. vim.fn.fnameescape(session_file))
      end
    end,
    group = session_group,
    nested = true,
    once = true,
  })

  vim.api.nvim_create_autocmd("VimLeavePre", {
    desc = "Saves the session",
    callback = function()
      if vim.fn.argc() == 0 and vim.fn.getcwd() ~= vim.env.HOME then
        vim.cmd("mks! " .. vim.fn.fnameescape(M.get_session_file()))
      end
    end,
    group = session_group,
    once = true,
  })
end

function M.get_session_file()
  local pattern = "/"
  if vim.fn.has("win32") == 1 then
    pattern = "[\\:]"
  end

  return M.dir .. "/" .. vim.fn.getcwd():gsub(pattern, "%%") .. ".vim"
end

return M
