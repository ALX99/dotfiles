-- https://github.com/windwp/nvim-autopairs
local utils = require('core.utils')

local autopairs = utils.require('nvim-autopairs')
if not autopairs then return end

autopairs.setup {}
