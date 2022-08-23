local utils = require('core.utils')

local toggle_term = utils.require('toggleterm')
if not toggle_term then return end

toggle_term.setup {}
