return {
  on_init = function(client)
    local path = client.workspace_folders[1].name
    if vim.uv.fs_stat(path .. '/.luarc.json') or vim.uv.fs_stat(path .. '/.luarc.jsonc') then
      return
    end
    client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua, {
      workspace = {
        checkThirdParty = false,
        library = {
          vim.env.VIMRUNTIME
        }
        -- This pulls in a lot or more files
        -- library = vim.api.nvim_get_runtime_file("", true)
      }
    })
  end,
  settings = {
    Lua = {
      runtime = {
        version = 'LuaJIT'
      },
    }
  }
}
