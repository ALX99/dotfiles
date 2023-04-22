require('core.opts')

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", -- latest stable release
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

vim.g.mapleader = " " -- make sure to set `mapleader` before lazy so your mappings are correct

require('lazy').setup('plugins',
  {
    change_detection = { notify = false },
    performance = {
      rtp = {
        disabled_plugins = {
          "gzip",
          "matchit",
          "netrwPlugin",
          "tarPlugin",
          "tohtml",
          "zipPlugin",
          "rplugin",
        },
      },
    },
  })
require('core.keymap')
require('core.autocmds')
