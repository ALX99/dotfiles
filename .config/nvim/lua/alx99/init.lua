require("alx99.packer")
require("alx99.set")
if (not vim.g.vscode) then
    require("alx99.lsp")
    require("alx99.plugins")
end
require("alx99.remap")
