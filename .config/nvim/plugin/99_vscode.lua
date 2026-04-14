-- VS Code-specific keybindings (only load in VS Code)
if not vim.g.vscode then return end

local map = require("utils").map
local vscode = require("vscode")

vim.notify = vscode.notify

-- Show hover
map("n", "K", function()
  vscode.action("editor.action.showHover")
end, { desc = "Show Hover" })

-- Close editor group
map("n", "<leader>q", function()
  vscode.action("workbench.action.closeEditorsInGroup")
end, { desc = "Close Editor Group" })

map("n", "<leader>!", function()
  vscode.action("workbench.action.reloadWindow")
end, { desc = "Reload Window" })

map("n", "zta", function()
  vscode.notify("Close Active Editor")
end, { desc = "Close Active Editor" })

-- Window navigation
map("n", "<leader>wi", function()
  vscode.action("workbench.action.navigateRight")
end, { desc = "Navigate Right" })

map("n", "<leader>wm", function()
  vscode.action("workbench.action.navigateLeft")
end, { desc = "Navigate Left" })

map("n", "<leader>wn", function()
  vscode.action("workbench.action.navigateDown")
end, { desc = "Navigate Down" })

map("n", "<leader>we", function()
  vscode.action("workbench.action.navigateUp")
end, { desc = "Navigate Up" })

-- Split editors
map("n", "<leader>wv", function()
  vscode.action("workbench.action.splitEditor")
end, { desc = "Split Editor" })

map("n", "<leader>ws", function()
  vscode.action("workbench.action.splitEditorOrthogonal")
end, { desc = "Split Editor Orthogonal" })

-- Search and navigation
map("n", "<leader>/", function()
  vscode.action("workbench.action.findInFiles")
end, { desc = "Find in Files" })

-- File navigation
map("n", "<leader>fo", function()
  vscode.action("workbench.action.quickOpen")
end, { desc = "Quick Open" })

map("n", "<leader>?", function()
  vscode.action("workbench.action.showCommands")
end, { desc = "Show Commands" })

-- LSP Key Mappings
map("n", "gD", function()
  vscode.action("editor.action.goToDeclaration")
end, { desc = "Go to declaration" })

map("n", "gd", function()
  vscode.action("editor.action.revealDefinition")
end, { desc = "Go to definition" })

map("n", "gi", function()
  vscode.action("editor.action.goToImplementation")
end, { desc = "Go to implementation" })

map("n", "gr", function()
  vscode.action("editor.action.goToReferences")
end, { desc = "Go to references" })

map("n", "gt", function()
  vscode.action("editor.action.goToTypeDefinition")
end, { desc = "Go to type definition" })

map("n", "gS", function()
  vscode.action("workbench.action.gotoSymbol")
end, { desc = "Go to workspace symbols" })

map("n", "gs", function()
  vscode.action("workbench.action.showSymbolPicker")
end, { desc = "Go to symbols" })

map("i", "<C-k>", function()
  vscode.action("editor.action.triggerSignatureHelp")
end, { desc = "Signature help" })

map("n", "<leader>rn", function()
  vscode.action("editor.action.rename")
end, { desc = "Rename symbol" })

map({ "n", "x" }, "<leader>ca", function()
  vscode.action("editor.action.codeAction")
end, { desc = "Code action" })

map({ "n", "x" }, "=", function()
  vscode.action("editor.action.formatDocument")
end, { desc = "Format file" })

map("n", "<leader>ft", function()
  vscode.action("workbench.view.explorer")
end, { desc = "Focus File Explorer" })
