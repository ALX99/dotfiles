local colemak = {}

-- Colemak-DH remaps
-- :h map-overview
local mappings = {
  -- Up/Down/Left/Right (normal/visual only, not operator-pending)
  -- This preserves text objects like 'iw', 'aw' in operator-pending mode
  { modes = { "n", "x" }, lhs = "m",      rhs = "h",     desc = "Left (h)" },
  { modes = { "n", "x" }, lhs = "n",      rhs = "j",     desc = "Down (j)" },
  { modes = { "n", "x" }, lhs = "e",      rhs = "k",     desc = "Up (k)" },
  { modes = { "n" },      lhs = "i",      rhs = "l",     desc = "Right (l)" },

  -- Displaced keys
  { modes = { "n", "x" }, lhs = "l",      rhs = "n",     desc = "Next search (n)" },
  { modes = { "n", "x" }, lhs = "L",      rhs = "N",     desc = "Prev search (N)" },
  { modes = { "n", "x" }, lhs = "h",      rhs = "e",     desc = "End of word (e)" },
  { modes = { "n", "x" }, lhs = "H",      rhs = "E",     desc = "End of WORD (E)" },
  { modes = { "n" },           lhs = "j",      rhs = "m",     desc = "Set mark (m)" },
  { modes = { "n" },           lhs = "k",      rhs = "i",     desc = "Insert (i)" },
  -- { modes = { "n" },           lhs = "K",      rhs = "I",     desc = "Insert at start (I)" },

  -- Window navigation
  { modes = { "n" },           lhs = "<C-w>m", rhs = "<C-w>h" },
  { modes = { "n" },           lhs = "<C-w>n", rhs = "<C-w>j" },
  { modes = { "n" },           lhs = "<C-w>e", rhs = "<C-w>k" },
  { modes = { "n" },           lhs = "<C-w>i", rhs = "<C-w>l" },
  { modes = { "n" },           lhs = "<C-w>M", rhs = "<C-w>H" },
  { modes = { "n" },           lhs = "<C-w>N", rhs = "<C-w>J" },
  { modes = { "n" },           lhs = "<C-w>E", rhs = "<C-w>K" },
  { modes = { "n" },           lhs = "<C-w>I", rhs = "<C-w>L" },
}

function colemak.setup(_)
  colemak.apply()

  vim.api.nvim_create_user_command(
    "ColemakEnable",
    colemak.apply,
    { desc = "Applies Colemak mappings" }
  )
  vim.api.nvim_create_user_command(
    "ColemakDisable",
    colemak.unapply,
    { desc = "Removes Colemak mappings" }
  )
end

function colemak.apply()
  for _, mapping in pairs(mappings) do
    local desc = mapping.desc
    if desc then
      desc = desc .. ' [COLEMAK]'
    end
    vim.keymap.set(
      mapping.modes,
      mapping.lhs,
      mapping.rhs,
      { desc = desc, noremap = true, silent = true }
    )
  end
end

function colemak.unapply()
  for _, mapping in pairs(mappings) do
    vim.keymap.del(mapping.modes, mapping.lhs)
  end
end

return colemak
