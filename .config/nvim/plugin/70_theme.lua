if vim.g.vscode then return end

-- Kanagawa maps 'background' to wave (dark) and lotus (light). Leaving Normal
-- backgroundless lets the terminal theme show through instead of painting
-- Kanagawa's own background over it.
local twilight_surfaces = {
  dark = {
    current_line = '#251a2f',
    color_column = '#2b2037',
  },
  light = {
    current_line = '#f1e9f9',
    color_column = '#ede4f7',
  },
}

require('kanagawa').setup({
  transparent = true,
  colors = {
    theme = {
      all = {
        ui = {
          bg_gutter = 'none',
        },
      },
    },
  },
  overrides = function()
    local surfaces = twilight_surfaces[vim.o.background] or twilight_surfaces.dark

    return {
      NormalFloat = { bg = 'none' },
      FloatBorder = { bg = 'none' },
      FloatTitle = { bg = 'none' },
      CursorLine = { bg = surfaces.current_line },
      CursorColumn = { bg = surfaces.current_line },
      CursorLineNr = { bg = surfaces.current_line },
      ColorColumn = { bg = surfaces.color_column },
      Folded = { bg = 'none' },
    }
  end,
})

vim.cmd.colorscheme('kanagawa')

-- Ghostty follows the desktop appearance, so ask the host terminal for its
-- background color. Neovim's own OSC 11 handler (vim/_core/defaults.lua) reads
-- the reply, sets 'background' from the color's luminance, and reloads the
-- colorscheme, which picks the matching Kanagawa flavor. A terminal that does
-- not reply leaves 'background' alone.
local function query_background()
  if not vim.o.ttyfast or #vim.api.nvim_list_uis() == 0 then
    return
  end
  vim.api.nvim_ui_send('\027]11;?\007')
end

_G.Config.new_autocmd('FocusGained', {
  desc = "Refresh 'background' from the terminal after regaining focus",
  callback = query_background,
})

local poll = assert(vim.uv.new_timer())
poll:start(30000, 30000, function()
  vim.schedule(query_background)
end)

_G.Config.new_autocmd('VimLeavePre', {
  desc = 'Stop polling the terminal background on exit',
  callback = function()
    poll:stop()
    poll:close()
  end,
})
