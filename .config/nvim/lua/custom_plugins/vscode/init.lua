local M = {}

function M.setup()
  local map = require("core.utils").map
  local vscode = require("vscode")

  -- Show hover
  map("n", "K", function()
    vscode.action("editor.action.showHover")
  end, { desc = "Show Hover" })

  -- Close active editor
  map("n", "<leader>q", function()
    vscode.action("workbench.action.closeActiveEditor")
  end, { desc = "Close Active Editor" })

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

  -- Code navigation
  map("n", "gd", function()
    vscode.action("editor.action.revealDefinition")
  end, { desc = "Go to Definition" })

  map("n", "gr", function()
    vscode.action("editor.action.goToReferences")
  end, { desc = "Go to References" })

  map("n", "gi", function()
    vscode.action("editor.action.goToImplementation")
  end, { desc = "Go to Implementation" })

  -- Quick actions
  map("n", "<leader>ca", function()
    vscode.action("editor.action.quickFix")
  end, { desc = "Quick Fix" })

  map("n", "<leader>rn", function()
    vscode.action("editor.action.rename")
  end, { desc = "Rename Symbol" })

  -- File navigation
  map("n", "<leader>fo", function()
    vscode.action("workbench.action.quickOpen")
  end, { desc = "Quick Open" })

  map("n", "<leader>?", function()
    vscode.action("workbench.action.showCommands")
  end, { desc = "Show Commands" })

  -- LSP Key Mappings
  -- Go to Declaration
  map("n", "gD", function()
    vscode.action("editor.action.goToDeclaration")
  end, { desc = "Go to declaration" })

  -- Go to Definition
  map("n", "gd", function()
    vscode.action("editor.action.revealDefinition")
  end, { desc = "Go to definition" })

  -- Go to Implementation
  map("n", "gi", function()
    vscode.action("editor.action.goToImplementation")
  end, { desc = "Go to implementation" })

  -- Go to References
  map("n", "gr", function()
    vscode.action("editor.action.goToReferences")
  end, { desc = "Go to references" })

  -- Go to Type Definition
  map("n", "gt", function()
    vscode.action("editor.action.goToTypeDefinition")
  end, { desc = "Go to type definition" })

  -- Go to Symbol (Workspace)
  map("n", "gS", function()
    vscode.action("workbench.action.gotoSymbol")
  end, { desc = "Go to workspace symbols" })

  -- Show Symbols
  map("n", "gs", function()
    vscode.action("workbench.action.showSymbolPicker")
  end, { desc = "Go to symbols" })

  -- Signature Help
  map("i", "<C-k>", function()
    vscode.action("editor.action.triggerSignatureHelp")
  end, { desc = "Signature help" })

  -- Rename Symbol
  map("n", "<leader>rn", function()
    vscode.action("editor.action.rename")
  end, { desc = "Rename symbol" })

  -- Code Action
  map({ "n", "x" }, "<leader>ca", function()
    vscode.action("editor.action.codeAction")
  end, { desc = "Code action" })

  -- Format Document
  map({ "n", "x" }, "=", function()
    vscode.action("editor.action.formatDocument")
  end, { desc = "Format file" })
end

return M
