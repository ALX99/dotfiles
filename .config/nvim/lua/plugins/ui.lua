return {
  {
    -- which-key for remembering keybindings
    "folke/which-key.nvim",
    event = "VeryLazy",
    config = function()
      local wk = require("which-key")

      vim.o.timeout = true
      vim.o.timeoutlen = 1000
      wk.register({
        mode = { "n", "v" },
        ["<leader>f"] = { name = "+file(s)" },
        ["<leader>g"] = { name = "+git" },
        ["<leader>w"] = { name = "+windows" },
      })
    end,
  },

  -- gitsigns for git gutter
  {
    "lewis6991/gitsigns.nvim",
    config = function()
      local utils = require('core.utils')

      local gitsigns = require('gitsigns')

      -- :h gitsigns.setup
      gitsigns.setup {
        on_attach = function(_)
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
  },

  -- nvim-tree for a file tree
  {
    "kyazdani42/nvim-tree.lua",
    keys = {
      { "<leader>ft", "<cmd>NvimTreeFindFile<CR>", desc = "Open filetree" },
    },
    config = function()
      local api = require('nvim-tree.api')

      local on_attach = function(bufnr)
        local opts = function(desc)
          return { desc = 'nvim-tree: ' .. desc, buffer = bufnr, noremap = true, silent = true, nowait = true }
        end

        vim.keymap.set('n', '<C-]>', api.tree.change_root_to_node, opts('CD'))
        vim.keymap.set('n', '<C-e>', api.node.open.replace_tree_buffer, opts('Open: In Place'))
        vim.keymap.set('n', '<C-k>', api.node.show_info_popup, opts('Info'))
        vim.keymap.set('n', '<C-r>', api.fs.rename_sub, opts('Rename: Omit Filename'))
        vim.keymap.set('n', '<C-t>', api.node.open.tab, opts('Open: New Tab'))
        -- vim.keymap.set('n', 'v', api.node.open.vertical, opts('Open: Vertical Split'))
        vim.keymap.set('n', 's', api.node.open.horizontal, opts('Open: Horizontal Split'))
        vim.keymap.set('n', '<BS>', api.node.navigate.parent_close, opts('Close Directory'))
        vim.keymap.set('n', '<CR>', api.node.open.edit, opts('Open'))
        vim.keymap.set('n', '<Tab>', api.node.open.preview, opts('Open Preview'))
        vim.keymap.set('n', '>', api.node.navigate.sibling.next, opts('Next Sibling'))
        vim.keymap.set('n', '<', api.node.navigate.sibling.prev, opts('Previous Sibling'))
        vim.keymap.set('n', '.', api.node.run.cmd, opts('Run Command'))
        vim.keymap.set('n', '-', api.tree.change_root_to_parent, opts('Up'))
        vim.keymap.set('n', 'a', api.fs.create, opts('Create'))
        vim.keymap.set('n', 'bmv', api.marks.bulk.move, opts('Move Bookmarked'))
        vim.keymap.set('n', 'B', api.tree.toggle_no_buffer_filter, opts('Toggle No Buffer'))
        vim.keymap.set('n', 'c', api.fs.copy.node, opts('Copy'))
        vim.keymap.set('n', 'C', api.tree.toggle_git_clean_filter, opts('Toggle Git Clean'))
        vim.keymap.set('n', '[c', api.node.navigate.git.prev, opts('Prev Git'))
        vim.keymap.set('n', ']c', api.node.navigate.git.next, opts('Next Git'))
        vim.keymap.set('n', 'd', api.fs.remove, opts('Delete'))
        vim.keymap.set('n', 'D', api.fs.trash, opts('Trash'))
        vim.keymap.set('n', 'ge', api.tree.expand_all, opts('Expand All'))
        -- vim.keymap.set('n', 'e', api.fs.rename_basename, opts('Rename: Basename'))
        vim.keymap.set('n', ']e', api.node.navigate.diagnostics.next, opts('Next Diagnostic'))
        vim.keymap.set('n', '[e', api.node.navigate.diagnostics.prev, opts('Prev Diagnostic'))
        vim.keymap.set('n', 'F', api.live_filter.clear, opts('Clean Filter'))
        vim.keymap.set('n', 'f', api.live_filter.start, opts('Filter'))
        vim.keymap.set('n', '?', api.tree.toggle_help, opts('Help'))
        vim.keymap.set('n', 'gy', api.fs.copy.absolute_path, opts('Copy Absolute Path'))
        vim.keymap.set('n', '.', api.tree.toggle_hidden_filter, opts('Toggle Dotfiles'))
        vim.keymap.set('n', 'I', api.tree.toggle_gitignore_filter, opts('Toggle Git Ignore'))
        vim.keymap.set('n', 'N', api.node.navigate.sibling.last, opts('Last Sibling'))
        vim.keymap.set('n', 'E', api.node.navigate.sibling.first, opts('First Sibling'))
        vim.keymap.set('n', 'm', api.marks.toggle, opts('Toggle Bookmark'))
        vim.keymap.set('n', 'o', api.node.open.edit, opts('Open'))
        vim.keymap.set('n', 'O', api.node.open.no_window_picker, opts('Open: No Window Picker'))
        vim.keymap.set('n', 'p', api.fs.paste, opts('Paste'))
        vim.keymap.set('n', 'P', api.node.navigate.parent, opts('Parent Directory'))
        vim.keymap.set('n', 'q', api.tree.close, opts('Close'))
        vim.keymap.set('n', 'r', api.fs.rename, opts('Rename'))
        vim.keymap.set('n', 'R', api.tree.reload, opts('Refresh'))
        -- vim.keymap.set('n', 's', api.node.run.system, opts('Run System'))
        vim.keymap.set('n', 'S', api.tree.search_node, opts('Search'))
        vim.keymap.set('n', 'U', api.tree.toggle_custom_filter, opts('Toggle Hidden'))
        vim.keymap.set('n', 'W', api.tree.collapse_all, opts('Collapse'))
        vim.keymap.set('n', 'x', api.fs.cut, opts('Cut'))
        vim.keymap.set('n', 'y', api.fs.copy.filename, opts('Copy Name'))
        vim.keymap.set('n', 'Y', api.fs.copy.relative_path, opts('Copy Relative Path'))
        vim.keymap.set('n', '<2-LeftMouse>', api.node.open.edit, opts('Open'))
        vim.keymap.set('n', '<2-RightMouse>', api.tree.change_root_to_node, opts('CD'))
      end

      require("nvim-tree").setup({
        on_attach = on_attach,
        view = {
          width = {
            min = "10%",
            max = "40%"
          },
        },
        diagnostics = {
          enable = true,
          show_on_dirs = true,
        },
      })
    end
  },

  -- markdown-previwe for markdown previews
  {
    "iamcco/markdown-preview.nvim",
    cmd = { "MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle" },
    enabled = vim.fn.executable("yarn") == 1,
    build = "cd app && yarn install",
  },

}
