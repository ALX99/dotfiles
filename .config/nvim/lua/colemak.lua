local colemak = {}

-- Colemak-DH remaps
-- :h map-overview
local mappings = {
  -- Up/Down/Left/Right (normal/visual only, not operator-pending)
  -- This preserves text objects like 'iw', 'aw' in operator-pending mode
  { modes = { "n", "x" }, lhs = "m",      rhs = "h",     desc = "Left (h)" },
  { modes = { "n", "x" }, lhs = "n",      rhs = "j",     desc = "Down (j)" },
  { modes = { "n", "x" }, lhs = "e",      rhs = "k",     desc = "Up (k)" },
  -- Keep visual-mode 'i' for inner text objects and 'l' for moving right.
  { modes = { "n" },      lhs = "i",      rhs = "l",     desc = "Right (l)" },

  -- Displaced keys
  { modes = { "n" },      lhs = "l",      rhs = "nzzzv", desc = "Next search (n)" },
  { modes = { "n" },      lhs = "L",      rhs = "Nzzzv", desc = "Prev search (N)" },
  { modes = { "n", "x" }, lhs = "h",      rhs = "e",     desc = "End of word (e)" },
  { modes = { "n", "x" }, lhs = "j",      rhs = "m",     desc = "Set mark (m)" },
  { modes = { "n" },      lhs = "k",      rhs = "i",     desc = "Insert (i)" },
}

function colemak.setup()
  colemak.apply()

  vim.api.nvim_create_user_command(
    "ColemakEnable",
    colemak.apply,
    { desc = "Applies Colemak mappings", force = true }
  )
  vim.api.nvim_create_user_command(
    "ColemakDisable",
    colemak.unapply,
    { desc = "Removes Colemak mappings", force = true }
  )
end

local function mapping_desc(mapping)
  return mapping.desc and mapping.desc .. ' [COLEMAK]' or nil
end

function colemak.apply()
  for _, mapping in ipairs(mappings) do
    vim.keymap.set(
      mapping.modes,
      mapping.lhs,
      mapping.rhs,
      { desc = mapping_desc(mapping), noremap = true, silent = true }
    )
  end
end

function colemak.unapply()
  for _, mapping in ipairs(mappings) do
    for _, mode in ipairs(mapping.modes) do
      local active = vim.fn.maparg(mapping.lhs, mode, false, true)
      if active.desc == mapping_desc(mapping) then
        vim.keymap.del(mode, mapping.lhs)
      end
    end
  end
end

return colemak
