local M = {}

local function tmux(args, input)
  local result = vim.system(vim.list_extend({ "tmux" }, args), { text = true, stdin = input }):wait()
  return result.code == 0, vim.trim(result.stdout or ""), vim.trim(result.stderr or "")
end

local function current_session()
  local ok, stdout = tmux({ "display-message", "-p", "#S" })
  return ok and stdout ~= "" and stdout or nil
end

local function target_pane(session_name)
  local ok, stdout = tmux({ "list-panes", "-t", "=" .. session_name, "-F", "#{pane_id}" })
  return ok and stdout:match("[^\n]+") or nil
end

-- Send a path to a tmux pane via tmux paste-buffer. The bytes are written
-- verbatim into the target pane, so shellescape is wrong: it would wrap the
-- path in single quotes, and any backslash-escaped chars would land in the
-- pane as backslashes.
local function send_to_pane(pane_id, path)
  local buffer = "nvim-ai-file-" .. pane_id:gsub("^%%", "")
  local payload = "@" .. path .. "\n"
  local ok, _, err = tmux({ "load-buffer", "-b", buffer, "-" }, payload)
  if not ok then
    vim.notify("Failed to load tmux buffer: " .. err, vim.log.levels.ERROR)
    return false
  end

  ok, _, err = tmux({ "paste-buffer", "-b", buffer, "-d", "-r", "-t", pane_id })
  if not ok then
    vim.notify("Failed to paste tmux buffer: " .. err, vim.log.levels.ERROR)
    return false
  end

  return true
end

local function focus_popup(tool)
  local popup = vim.fs.joinpath(vim.env.HOME, ".config/tmux/session-popup")
  local job_id = vim.fn.jobstart({ "tmux", "display-popup", "-T", tool, "-w", "95%", "-h", "95%", "-E", popup, tool }, {
    detach = true,
  })

  if job_id <= 0 then
    vim.notify("Failed to focus " .. tool .. " popup", vim.log.levels.ERROR)
  end
end

function M.send_file_to_popup()
  if not vim.env.TMUX then
    vim.notify("Not running inside tmux", vim.log.levels.WARN)
    return
  end

  local file = vim.api.nvim_buf_get_name(0)
  if file == "" or vim.fn.filereadable(file) ~= 1 then
    vim.notify("Current buffer is not a readable file", vim.log.levels.WARN)
    return
  end

  local session = current_session()
  if not session then
    vim.notify("Could not determine tmux session", vim.log.levels.ERROR)
    return
  end

  local pane_id, tool
  for _, name in ipairs({ "pi", "claude" }) do
    pane_id = target_pane("_" .. name .. "_" .. session)
    if pane_id then
      tool = name
      break
    end
  end

  if not pane_id then
    vim.notify("No pi/claude popup session found. Open one with cmd-o first.", vim.log.levels.WARN)
    return
  end

  local rel = vim.fs.relpath(vim.fn.getcwd(), file) or file
  if send_to_pane(pane_id, rel) then
    focus_popup(tool)
    vim.notify("Sent " .. rel .. " to " .. tool, vim.log.levels.INFO)
  end
end

function M.setup()
  require("utils").map("n", "<leader>af", M.send_file_to_popup, { desc = "Send File to AI Popup" })
end

return M
