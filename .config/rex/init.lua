-- Herdr-inspired shortcuts for Rex. Cmd+A is the shared prefix.
---@diagnostic disable-next-line: undefined-global -- Injected by the Rex host.
local rex = rex
local prefix = "cmd+a>"

-- The editor stays alive when detached and is shared across tabs in a session.
local editor_label = "rex-dock-editor"

local function active_layout()
  local view, err = rex.session.view{}
  if err then error(err, 0) end
  for _, window in ipairs(view.windows or {}) do
    if window.window_id == view.active_window_id then
      for _, layer in ipairs(window.layers or {}) do
        if layer.kind == "tiled" and layer.layout then return window, layer end
      end
    end
  end
  error("Rex has no active tiled layout", 0)
end

local function project_cwd(ctx, layer)
  -- Prefer the focused agent, not an editor or git process in the dock.
  local candidates = {}
  for _, block in ipairs(layer.blocks or {}) do
    if block.label ~= editor_label then
      if block.block_id == ctx.block_id then
        table.insert(candidates, 1, block.block_id)
      else
        table.insert(candidates, block.block_id)
      end
    end
  end
  for _, block_id in ipairs(candidates) do
    local process = rex.block.call("com.superlogical.terminal", "process", { block_id = block_id })
    local cwd = process and process.foreground and process.foreground.cwd
    if cwd then return cwd end
  end
  error("Could not determine the current agent pane's directory", 0)
end

local function toggle_editor(ctx)
  local window, layer = active_layout()
  local cwd = project_cwd(ctx, layer)
  local listed, err = rex.session.list_blocks{}
  if err then error(err, 0) end
  local target
  for _, block in ipairs(listed.blocks or {}) do
    if block.label == editor_label then
      if target then error("Multiple " .. editor_label .. " blocks", 0) end
      target = block
    end
  end

  -- Toggling the visible tool hides it, without terminating the process.
  if target and target.placement == "placed" and target.window_id == window.window_id then
    local _, detach_err = rex.session.detach_block{ block_id = target.block_id }
    if detach_err then error(detach_err, 0) end
    return
  end

  if target and target.placement == "placed" then
    local _, detach_err = rex.session.detach_block{ block_id = target.block_id }
    if detach_err then error(detach_err, 0) end
  end

  -- Detaching changes the layout tree, so obtain the root again before splitting.
  window, layer = active_layout()
  local root = layer.layout.split and layer.layout.split.split_id or layer.layout.block_id
  if not root then error("The active layout has no root", 0) end

  if not target then
    local created, create_err = rex.session.new_split{
      anchor_id = root, direction = "horizontal", side = "after", ratio = 0.55, focus = true,
      layout = { block = {
        flavor = "com.superlogical.terminal.shell", label = editor_label,
        options = { cwd = cwd, command = { "nvim" } },
      } },
    }
    if create_err then error(create_err, 0) end
    return
  end

  -- move_block only accepts a block anchor, not the root split. Reserve a
  -- full-height slot, move the detached tool into it, then remove the slot.
  local slot, slot_err = rex.session.new_split{
    anchor_id = root, direction = "horizontal", side = "after", ratio = 0.55,
    layout = { block = {
      flavor = "com.superlogical.terminal.shell", label = "rex-dock-slot",
      options = { shell = "none", command = { "/bin/sleep", "60" } },
    } },
  }
  if slot_err then error(slot_err, 0) end
  local slot_id = slot.block_ids[1]
  local _, move_err = rex.session.move_block{
    block_id = target.block_id, anchor_block_id = slot_id,
    direction = "horizontal", side = "before",
  }
  local _, close_err = rex.call("block.close", { session_id = ctx.session_id, block_id = slot_id })
  if move_err then error(move_err, 0) end
  if close_err then error(close_err, 0) end
  local _, focus_err = rex.session.focus_block{ block_id = target.block_id }
  if focus_err then error(focus_err, 0) end
end

rex.action{
  name = "toggle_editor_dock",
  title = "Toggle Editor Dock",
  description = "Show or hide Neovim in a full-height right-hand pane.",
  category = "Workspace",
  run = toggle_editor,
}
rex.bind(prefix .. "o", "toggle_editor_dock")

rex.action{
  name = "toggle_lazygit_popup",
  title = "Toggle Lazygit Popup",
  description = "Open or close lazygit in a wide floating terminal.",
  category = "Workspace",
  run = function(ctx)
    local window, layer = active_layout()
    for _, candidate in ipairs(window.layers or {}) do
      if candidate.kind == "floating" then
        for _, block in ipairs(candidate.blocks or {}) do
          if block.label == "lazygit-popup" then
            local _, err = rex.session.close_layer{ layer_id = candidate.layer_id }
            if err then error(err, 0) end
            return
          end
        end
      end
    end
    local cwd = project_cwd(ctx, layer)
    local _, err = rex.session.new_layer{
      window_id = window.window_id,
      bounds = { 0.05, 0.05, 0.9, 0.9 }, focus = true,
      layout = { block = {
        flavor = "com.superlogical.terminal.shell", label = "lazygit-popup",
        options = { cwd = cwd, command = { "lazygit" } },
      } },
    }
    if err then error(err, 0) end
  end,
}
rex.bind(prefix .. "g", "toggle_lazygit_popup")

local function open_project(path)
  local git, git_err = rex.exec({ "git", "-C", path, "rev-parse", "--show-toplevel" })
  if not git then error(git_err, 0) end
  -- Non-Git directories under ~/projects are projects too.
  local root = git.ok and git.stdout:gsub("\n$", "") or path
  local home = os.getenv("HOME")
  local projects = home and home .. "/projects/"
  local relative = projects and root:sub(1, #projects) == projects and root:sub(#projects + 1)
  local old_label = "project: " .. (relative and "projects/" .. relative or root)
  -- Top-level project names are unique; retain paths for other locations.
  local label = relative and not relative:find("/", 1, true) and "project: " .. relative or old_label
  if #label > 128 then error("Project path is too long for a Rex session label: " .. root, 0) end
  local listed, err = rex.call("session.list", {})
  if err then error(err, 0) end
  local session_id, needs_rename
  for _, session in ipairs(listed.sessions or {}) do
    if session.label == label or session.label == old_label then
      if session_id then error("Multiple sessions match project " .. root, 0) end
      session_id = session.session_id
      needs_rename = session.label ~= label
    end
  end
  if needs_rename then
    local _, rename_err = rex.call("session.set_label", { session_id = session_id, label = label })
    if rename_err then error(rename_err, 0) end
  end
  if not session_id then
    local created, create_err = rex.call("session.create", {
      label = label,
      initial_windows = {{ window_label = "Agent", layout = { block = {
        flavor = "com.superlogical.terminal.shell", options = { cwd = root },
      } } }},
    })
    if create_err then error(create_err, 0) end
    session_id = created.session_id
  end
  rex.client.queue("session.select", { session_id = session_id })
end

rex.action{
  name = "open_project_session",
  title = "Open Project Session",
  description = "Open or switch to a project session.",
  category = "Workspace",
  args = { path = "string" },
  run = function(_, args)
    local exists, err = rex.exec({ "/bin/test", "-d", args.path })
    if not exists then error(err, 0) end
    if not exists.ok then error("Project directory not found: " .. args.path, 0) end
    open_project(args.path)
  end,
}

rex.action{
  name = "pick_project",
  title = "Pick Project",
  description = "Choose a project directory and open or switch to its session.",
  category = "Workspace",
  run = function(ctx)
    local window = active_layout()
    for _, layer in ipairs(window.layers or {}) do
      for _, block in ipairs(layer.blocks or {}) do
        if block.label == "rex-project-picker" then return end
      end
    end
    local home = os.getenv("HOME")
    if not home then error("HOME is not set", 0) end
    if not ctx.client_id then error("Project picker needs a Rex app client", 0) end
    local projects = home .. "/projects"
    local exists, exists_err = rex.exec({ "/bin/test", "-d", projects })
    if not exists then error(exists_err, 0) end
    if not exists.ok then error("Projects directory not found: " .. projects, 0) end
    -- Return as soon as the popup is open. Waiting for the terminal to finish
    -- in the action prevents Rex.app from accepting input into the picker.
    local _, err = rex.session.new_layer{
      window_id = window.window_id, bounds = { 0.15, 0.1, 0.7, 0.8 }, focus = true,
      layout = { block = {
        flavor = "com.superlogical.terminal.shell", label = "rex-project-picker",
        options = { command = { "bash", "-c", [[
          IFS= read -r -d '' project < <(
            find -L "$1" -mindepth 1 -maxdepth 1 -type d -print0 |
              fzf --read0 --print0 --no-multi --delimiter / --with-nth=-1 --prompt='Project > '
          ) || exit 0
          if ! rex -C "$2" do -s "$3" open_project_session "path=$project"; then
            printf '\nCould not switch automatically. If the project session was created, select it in the sidebar.\n'
            printf 'For automatic switching, enable Remote Control in Rex Settings > Rex Server.\n'
            printf 'Press Enter to close. '
            read -r _
          fi
        ]], "rex-project-picker", projects, ctx.client_id, ctx.session_id } },
      } },
    }
    if err then error(err, 0) end
  end,
}
rex.bind(prefix .. "p", "pick_project")

rex.action{
  name = "new_agent_tab",
  title = "New Agent Tab",
  description = "Open a shell in the current project for another coding agent.",
  category = "Workspace",
  run = function(ctx)
    local _, layer = active_layout()
    local cwd = project_cwd(ctx, layer)
    local _, err = rex.session.new_window{
      window_label = "Agent", focus = true,
      layout = { block = { flavor = "com.superlogical.terminal.shell", options = { cwd = cwd } } },
    }
    if err then error(err, 0) end
  end,
}
rex.bind(prefix .. "a", "new_agent_tab")

-- Tabs and sessions.
rex.bind(prefix .. "c", "client.tab.new")
rex.bind(prefix .. ",", "client.tab.previous")
rex.bind(prefix .. ".", "client.tab.next")
for index = 1, 9 do
  rex.bind(prefix .. index, "client.tab.goto", { index = index })
end
rex.bind(prefix .. "h", "session.switch")

-- Pane layout and navigation (Colemak-DH m/n/e/i).
rex.bind(prefix .. "v", "pane.split.right")
rex.bind(prefix .. "s", "pane.split.down")
rex.bind(prefix .. "x", "pane.close")
rex.bind(prefix .. "z", "pane.zoom")
rex.bind("alt+f", "pane.zoom")

local directions = {
  m = "left",
  n = "down",
  e = "up",
  i = "right",
}
for key, direction in pairs(directions) do
  rex.bind("alt+" .. key, "pane.focus", { direction = direction })
  rex.bind(prefix .. key, "pane.focus", { direction = direction })
  rex.bind(prefix .. "shift+" .. key, "pane.move", { direction = direction })
  rex.bind("alt+shift+" .. key, "pane.resize", { direction = direction })
end
for _, direction in ipairs({ "left", "down", "up", "right" }) do
  rex.bind(prefix .. direction, "pane.focus", { direction = direction })
  -- Work around Rex Beta dropping unbound arrow keys before terminal input.
  rex.bind(direction, "pane.send_key", { key = direction })
end
