-- Personal Hyprland Lua config.
-- See https://wiki.hypr.land/Configuring/Start/

------------------
---- MONITORS ----
------------------

hl.monitor({
    output   = "eDP-1",
    mode     = "1920x1200@60",
    position = "2560x120",
    scale    = 1,
})

hl.monitor({
    output = "DP-3",
    mode   = "2560x1440@100",
    scale  = 1,
})

---------------------
---- MY PROGRAMS ----
---------------------

local terminal = "uwsm app -- com.mitchellh.ghostty.desktop"
local fileManager = "uwsm app -- dolphin"
local menu = "uwsm app -- fuzzel"
local mainMod = "SUPER"

-------------------
---- AUTOSTART ----
-------------------

hl.on("hyprland.start", function()
    hl.exec_cmd("uwsm finalize")
end)

-----------------------
---- LOOK AND FEEL ----
-----------------------

hl.config({
    general = {
        gaps_in = 0,
        gaps_out = 0,
        border_size = 2,
        no_focus_fallback = false,

        col = {
            active_border = { colors = { "rgba(33ccffee)", "rgba(00ff99ee)" }, angle = 45 },
            inactive_border = "rgba(595959aa)",
        },

        resize_on_border = true,
        extend_border_grab_area = 15,
        allow_tearing = false,
        layout = "master",
    },

    decoration = {
        rounding = 10,
        rounding_power = 2,

        shadow = {
            enabled = false,
            range = 4,
            render_power = 3,
            color = "rgba(1a1a1aee)",
        },

        blur = {
            enabled = true,
            size = 1,
            passes = 2,
        },
    },

    animations = {
        enabled = false,
    },

    dwindle = {
        preserve_split = true,
    },

    binds = {
        workspace_back_and_forth = true,
        focus_preferred_method = 1,
    },

    misc = {},

    input = {
        kb_layout = "us",
        kb_variant = "",
        kb_model = "",
        kb_options = "",
        kb_rules = "",
        repeat_rate = 50,
        repeat_delay = 300,
        follow_mouse = 1,
        special_fallthrough = true,
        sensitivity = 0,

        touchpad = {
            natural_scroll = true,
        },
    },

    gestures = {
        workspace_swipe_forever = true,
        workspace_swipe_cancel_ratio = 0.25,
    },
})

hl.gesture({ fingers = 3, direction = "swipe", action = "move" })
hl.gesture({ fingers = 4, direction = "horizontal", action = "workspace" })

hl.device({
    name = "epic-mouse-v1",
    sensitivity = -0.5,
})

---------------------
---- KEYBINDINGS ----
---------------------

hl.bind(mainMod .. " + Return", hl.dsp.exec_cmd(terminal))
hl.bind(mainMod .. " + Q", hl.dsp.window.close())
hl.bind(mainMod .. " + SHIFT + Q", hl.dsp.window.kill())
hl.bind(mainMod .. " + D", hl.dsp.exec_cmd(menu))
hl.bind(mainMod .. " + B", hl.dsp.exec_cmd("uwsm app -- brave-browser.desktop"))
hl.bind(mainMod .. " + SHIFT + E", hl.dsp.exec_cmd(fileManager))
hl.bind(mainMod .. " + SHIFT + A", hl.dsp.exec_cmd("uwsm app -- anki.desktop"))
hl.bind(mainMod .. " + V", hl.dsp.window.float({ action = "toggle" }))
hl.bind(mainMod .. " + P", hl.dsp.window.pseudo())
hl.bind(mainMod .. " + J", hl.dsp.layout("orientationnext"))
hl.bind(mainMod .. " + space", hl.dsp.layout("swapwithmaster master"))
hl.bind(mainMod .. " + Tab", hl.dsp.layout("cyclenext"))
hl.bind(mainMod .. " + SHIFT + Tab", hl.dsp.layout("cycleprev"))
hl.bind(mainMod .. " + equal", hl.dsp.layout("mfact +0.05"), { repeating = true })
hl.bind(mainMod .. " + minus", hl.dsp.layout("mfact -0.05"), { repeating = true })
hl.bind(mainMod .. " + bracketright", hl.dsp.layout("addmaster"))
hl.bind(mainMod .. " + bracketleft", hl.dsp.layout("removemaster"))
hl.bind(mainMod .. " + F", hl.dsp.window.fullscreen())
hl.bind(mainMod .. " + SHIFT + F", hl.dsp.window.fullscreen_state({ internal = 0, client = 3 }))
hl.bind("Print", hl.dsp.exec_cmd([[grim -g "$(slurp)" - | wl-copy]]))

-- Move focus with mainMod + Colemak DH home-row keys.
hl.bind(mainMod .. " + M", hl.dsp.focus({ direction = "l" }))
hl.bind(mainMod .. " + I", hl.dsp.focus({ direction = "r" }))
hl.bind(mainMod .. " + E", hl.dsp.focus({ direction = "u" }))
hl.bind(mainMod .. " + N", hl.dsp.focus({ direction = "d" }))

hl.bind(mainMod .. " + CTRL + M", hl.dsp.window.swap({ direction = "l" }))
hl.bind(mainMod .. " + CTRL + I", hl.dsp.window.swap({ direction = "r" }))
hl.bind(mainMod .. " + CTRL + E", hl.dsp.window.swap({ direction = "u" }))
hl.bind(mainMod .. " + CTRL + N", hl.dsp.window.swap({ direction = "d" }))

hl.bind(mainMod .. " + comma", hl.dsp.focus({ monitor = "-1" }))
hl.bind(mainMod .. " + period", hl.dsp.focus({ monitor = "+1" }))
hl.bind(mainMod .. " + SHIFT + comma", hl.dsp.window.move({ monitor = "-1", follow = true }))
hl.bind(mainMod .. " + SHIFT + period", hl.dsp.window.move({ monitor = "+1", follow = true }))

for i = 1, 10 do
    local key = i % 10
    local workspace = "r~" .. i
    hl.bind(mainMod .. " + " .. key, hl.dsp.focus({ workspace = workspace }))
    hl.bind(mainMod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = workspace }))
end

hl.bind(mainMod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
hl.bind(mainMod .. " + mouse_up", hl.dsp.focus({ workspace = "e-1" }))

hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

hl.bind(mainMod .. " + h", hl.dsp.window.resize({ x = -10, y = 0, relative = true }), { repeating = true })
hl.bind(mainMod .. " + SHIFT + h", hl.dsp.window.resize({ x = 10, y = 0, relative = true }), { repeating = true })

hl.bind(mainMod .. " + R", hl.dsp.submap("resize"))
hl.define_submap("resize", function()
    hl.bind("M", hl.dsp.window.resize({ x = -20, y = 0, relative = true }), { repeating = true })
    hl.bind("I", hl.dsp.window.resize({ x = 20, y = 0, relative = true }), { repeating = true })
    hl.bind("E", hl.dsp.window.resize({ x = 0, y = -20, relative = true }), { repeating = true })
    hl.bind("N", hl.dsp.window.resize({ x = 0, y = 20, relative = true }), { repeating = true })
    hl.bind("escape", hl.dsp.submap("reset"))
    hl.bind("Return", hl.dsp.submap("reset"))
    hl.bind("Q", hl.dsp.submap("reset"))
end)

hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+"), { locked = true, repeating = true })
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"), { locked = true, repeating = true })
hl.bind("XF86AudioMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"), { locked = true, repeating = true })
hl.bind("XF86AudioMicMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"), { locked = true, repeating = true })
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("lightcontrol -d +500"), { locked = true, repeating = true })
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("lightcontrol -d -500"), { locked = true, repeating = true })

hl.bind("XF86AudioNext", hl.dsp.exec_cmd("playerctl next"), { locked = true })
hl.bind("XF86AudioPause", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPlay", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPrev", hl.dsp.exec_cmd("playerctl previous"), { locked = true })

--------------------------------
---- WINDOWS AND WORKSPACES ----
--------------------------------

hl.window_rule({
    name = "suppress-maximize-events",
    match = { class = ".*" },
    suppress_event = "maximize",
})

hl.window_rule({
    name = "fix-xwayland-drags",
    match = { class = "^$" },
    no_focus = true,
})
