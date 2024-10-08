vim.b.ts_fip = { "%_test%.go", "%_mock%.go" }

---Get all test names under the given node
---@param node TSNode
---@param bufnr number
---@return table
local function get_test_names(node, bufnr)
  local names = {}
  local lang = require("nvim-treesitter.parsers").ft_to_lang(vim.bo.ft)
  local query_text = [[
      (function_declaration
        name: (identifier) @name
        parameters: (parameter_list
          (parameter_declaration
            type: (pointer_type
              (qualified_type
                (package_identifier) @_package (#eq? @_package "testing")
                (type_identifier) @_type) (#eq? @_type "T")
              )
            )
          )
        )
    ]]

  local query = vim.treesitter.query.parse(lang, query_text)

  for _, match, _ in query:iter_matches(node, bufnr, 0, -1, { all = true }) do
    for id, nodes in pairs(match) do
      local name = query.captures[id]
      if name ~= "name" then
        goto continue
      end

      for _, node in ipairs(nodes) do
        table.insert(names, vim.treesitter.get_node_text(node, bufnr))
      end
    end
    ::continue::
  end
  return names
end


vim.api.nvim_create_user_command('Test', function()
    local bufnr = vim.api.nvim_get_current_buf()
    local node = require('nvim-treesitter.ts_utils').get_node_at_cursor()
    while node and node:type() ~= "function_declaration" do
      node = node:parent()
    end
    if not node then return end
    local test_names = get_test_names(node, bufnr)

    vim.schedule(function()
      vim.lsp.buf.execute_command({
        command = 'gopls.run_tests',
        arguments = { { URI = vim.uri_from_bufnr(bufnr), Tests = test_names } },
      })
    end)
  end,
  { desc = "Run the test under the cursor" }
)

vim.api.nvim_create_user_command('Tests', function()
    local bufnr = vim.api.nvim_get_current_buf()
    local parser = vim.treesitter.get_parser(bufnr)
    local node = parser:parse()[1]:root()
    local test_names = get_test_names(node, bufnr)

    vim.schedule(function()
      vim.lsp.buf.execute_command({
        command = 'gopls.run_tests',
        arguments = { { URI = vim.uri_from_bufnr(bufnr), Tests = test_names } },
      })
    end)
  end,
  { desc = "Run the tests in the buffer" }
)

-- https://github.com/golang/tools/blob/e5e8aa847293f750c1b3b46832d8074bcb874739/gopls/internal/cmd/execute.go#L38-L46
-- https://pkg.go.dev/golang.org/x/tools/gopls/internal/protocol/command#Interface
vim.api.nvim_create_user_command('GoDoc', function()
    local bufnr = vim.api.nvim_get_current_buf()
    vim.schedule(function()
      vim.lsp.buf.execute_command({
        command = 'gopls.doc',
        arguments = {
          {
            URI = vim.uri_from_bufnr(bufnr),
            start = {
              line = vim.api.nvim_win_get_cursor(0)[1],
              character = vim.api.nvim_win_get_cursor(0)[2],
            },
            end_ = {
              line = vim.api.nvim_win_get_cursor(0)[1],
              character = vim.api.nvim_win_get_cursor(0)[2],
            },
          }
        },
      })
    end)
  end,
  { desc = "Browse the Go documentation" }
)
