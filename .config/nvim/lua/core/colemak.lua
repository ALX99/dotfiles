local colemak = {}

-- Colemak-DH remaps
-- :h map-overview
local mappings = {
  -- Up/Down/Left/Right
  { modes = { "n", "o", "x" }, lhs = "m",      rhs = "h",     desc = "Left (h)" },
  { modes = { "n", "o", "x" }, lhs = "n",      rhs = "j",     desc = "Down (j)" },
  { modes = { "n", "o", "x" }, lhs = "e",      rhs = "k",     desc = "Up (k)" },
  { modes = { "n", "o", "x" }, lhs = "i",      rhs = "l",     desc = "Right (l)" },

  -- Top/Bottom of screen
  { modes = { "n", "o", "x" }, lhs = "M",      rhs = "H",     desc = "Cursor to top of screen" },
  { modes = { "n", "o", "x" }, lhs = "I",      rhs = "L",     desc = "Cursor to bottom of screen" },

  -- Search
  { modes = { "n", "o", "x" }, lhs = "l",      rhs = "n" },
  { modes = { "n", "o", "x" }, lhs = "L",      rhs = "N" },

  -- Substitute
  { modes = { "n", "o", "x" }, lhs = "j",      rhs = "S",     desc = "Substitute line" },

  -- Insert
  { modes = { "n" },           lhs = "s",      rhs = "i",     desc = "Insert mode" },
  { modes = { "n", "v" },      lhs = "S",      rhs = "I",     desc = "Insert mode" },

  -- Mark
  { modes = { "n", "o", "x" }, lhs = "k",      rhs = "m",     desc = "Create mark" },

  -- End of word
  { modes = { "n", "o", "x" }, lhs = "h",      rhs = "e",     desc = "End of word" },
  { modes = { "n", "o", "x" }, lhs = "H",      rhs = "E",     desc = "End of WORD" },
  { modes = { "n", "o", "x" }, lhs = "gh",     rhs = "ge",    desc = "Previous end of word" },
  { modes = { "n", "o", "x" }, lhs = "gH",     rhs = "gE",    desc = "Previous end of WORD" },
  { modes = { "n", "o", "x" }, lhs = "ge",     rhs = "gk",    desc = "Go up by screen lines" },
  { modes = { "n", "o", "x" }, lhs = "gn",     rhs = "gj",    desc = "Go down by screen lines" },
  { modes = { "n", "o", "x" }, lhs = "gE",     rhs = "<nop>", desc = "<nop>" },
  { modes = { "n", "o", "x" }, lhs = "gN",     rhs = "<nop>", desc = "<nop>" },

  -- Text objects
  { modes = { "o", "x" },      lhs = "s",      rhs = "i",     desc = "O/V mode: inner (i)" },

  -- Jumplist navigation
  -- { modes = { "n" },           lhs = "<C-u>",      rhs = "<C-i>",      desc = "Jumplist forward" },
  -- { modes = { "n" },           lhs = "<C-e>",      rhs = "<C-o>",      desc = "Jumplist forward" },

  -- Macros (replay the macro recorded by qq)
  -- { modes = { "n" },           lhs = "Q",          rhs = "@q",    desc = "replay the 'q' macro" },

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
