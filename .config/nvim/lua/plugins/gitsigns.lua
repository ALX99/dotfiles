return {
  "lewis6991/gitsigns.nvim",
  config = function()
    local utils = require('core.utils')

    local gitsigns = require('gitsigns')

    gitsigns.setup {
      on_attach = function(bufnr)
        local gs = package.loaded.gitsigns
        utils.map({ 'n', 'v' }, '<leader>gs', ':Gitsigns stage_hunk<CR>', { desc = "Stage hunk" })
        utils.map('n', '<leader>gS', gs.stage_buffer, { desc = "Stage file" })
        utils.map('n', '<leader>gU', gs.reset_buffer_index, { desc = "Unstage file" })
        utils.map('n', '<leader>gu', gs.undo_stage_hunk, { desc = "Undo stage hunk" })
        utils.map({ 'n', 'v' }, '<leader>gr', ':Gitsigns reset_hunk<CR>', { desc = "Reset hunk" })
        utils.map('n', '<leader>gR', gs.reset_buffer, { desc = "Reset file" })
        utils.map('n', '<leader>gP', gs.preview_hunk, { desc = "Preview hunk" })
        utils.map('n', '<leader>gb', function() gs.blame_line({ full = true }) end, { desc = "Blame line" })
        utils.map('n', '<leader>gB', gs.toggle_current_line_blame, { desc = "Toggle line blame" })
        utils.map('n', '<leader>gd', gs.diffthis, { desc = "Diff against index" })
        utils.map('n', '<leader>gD', function() gs.diffthis("~1") end, { desc = "Diff against ~1" })
        utils.map('n', '<leader>gx', gs.toggle_deleted, { desc = "Toggle deleted lines" })
      end
    }
  end,
}
