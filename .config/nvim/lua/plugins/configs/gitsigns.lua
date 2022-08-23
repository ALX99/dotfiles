local utils = require('alx99.utils')

local gitsigns = utils.require('gitsigns')
if not gitsigns then return end

gitsigns.setup {
  on_attach = function(bufnr)
    local gs = package.loaded.gitsigns
    utils.map({ 'n', 'v' }, '<leader>sh', ':Gitsigns stage_hunk<CR>')
    utils.map({ 'n', 'v' }, '<leader>sr', ':Gitsigns reset_hunk<CR>')
    utils.map('n', '<leader>sf', gs.stage_buffer)
    utils.map('n', '<leader>su', gs.undo_stage_hunk)
    utils.map('n', '<leader>sR', gs.reset_buffer)
    utils.map('n', '<leader>sp', gs.preview_hunk)
    utils.map('n', '<leader>slb', function() gs.blame_line { full = true } end)
    utils.map('n', '<leader>stlb', gs.toggle_current_line_blame)
    utils.map('n', '<leader>sd', gs.diffthis)
    utils.map('n', '<leader>sD', function() gs.diffthis('~') end)
    utils.map('n', '<leader>std', gs.toggle_deleted)
  end
}
