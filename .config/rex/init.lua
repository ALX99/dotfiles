-- Herdr-inspired shortcuts for Rex. Cmd+A is the shared tmux-style prefix.
---@diagnostic disable-next-line: undefined-global -- Injected by the Rex host.
local rex = rex
local prefix = "cmd+a>"

local popup_label = "lazygit-popup"
rex.action{
  name = "toggle_lazygit_popup",
  title = "Toggle Lazygit Popup",
  description = "Open or close lazygit in a floating terminal.",
  category = "Terminal",
  keywords = "git popup float",
  run = function(ctx)
    local view, err = rex.session.view{}
    if err then error(err, 0) end

    local window
    for _, candidate in ipairs(view.windows or {}) do
      if candidate.window_id == view.active_window_id then
        window = candidate
        break
      end
    end
    if not window then error("Rex has no active window", 0) end

    for _, layer in ipairs(window.layers or {}) do
      if layer.kind == "floating" then
        for _, block in ipairs(layer.blocks or {}) do
          if block.label == popup_label then
            local _, close_err = rex.session.close_layer{ layer_id = layer.layer_id }
            if close_err then error(close_err, 0) end
            return
          end
        end
      end
    end

    local cwd
    if ctx.block_id then
      local process = rex.block.call("com.superlogical.terminal", "process", {
        block_id = ctx.block_id,
      })
      cwd = process and process.foreground and process.foreground.cwd
    end

    local options = { command = { "lazygit" } }
    if cwd then options.cwd = cwd end
    local _, layer_err = rex.session.new_layer{
      window_id = window.window_id,
      bounds = { 0.05, 0.05, 0.9, 0.9 },
      focus = true,
      layout = {
        block = {
          flavor = "com.superlogical.terminal.shell",
          label = popup_label,
          options = options,
        },
      },
    }
    if layer_err then error(layer_err, 0) end

  end,
}
rex.bind(prefix .. "g", "toggle_lazygit_popup")

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
