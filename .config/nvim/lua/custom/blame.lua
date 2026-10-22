local M = {}
local api = vim.api
local ns = api.nvim_create_namespace('custom.blame')
local views = {}

local function notify(message, level)
  vim.notify('Git blame: ' .. message, level or vim.log.levels.WARN)
end

local function close(state)
  if views[state.source] ~= state then return end
  views[state.source] = nil
  if state.job then state.job:kill(15) end
  api.nvim_del_augroup_by_id(state.group)
  local shared = false
  for _, other in pairs(views) do
    if other.filebuf == state.filebuf then shared = true; break end
  end
  if not shared and api.nvim_buf_is_valid(state.filebuf) then
    if state.diagnostics then vim.diagnostic.enable(true, { bufnr = state.filebuf }) end
    if state.codelens then vim.lsp.codelens.enable(true, { bufnr = state.filebuf }) end
  end
  if api.nvim_win_is_valid(state.source) then
    for name, value in pairs(state.saved) do
      vim.wo[state.source][name] = value
    end
  end
  -- Neovim cannot close its last window; deleting the scratch buffer below
  -- leaves a normal empty buffer in that case.
  if api.nvim_win_is_valid(state.win) then pcall(api.nvim_win_close, state.win, true) end
  if api.nvim_buf_is_valid(state.buf) then api.nvim_buf_delete(state.buf, { force = true }) end
end

local function parse(output)
  local rows, row = {}, nil
  for line in output:gmatch('[^\n]+') do
    local hash, number = line:match('^(%x+) %d+ (%d+)')
    if hash then
      row = { hash = hash, number = tonumber(number) }
    elseif row then
      local key, value = line:match('^(%S+) (.*)')
      if line:sub(1, 1) == '\t' then
        rows[row.number] = row
        row = nil
      elseif key then
        row[key] = value
      end
    end
  end
  return rows
end

local function clean(value)
  return (value or ''):gsub('%c', ' ')
end

local function render(state, rows)
  local lines, marks, width = {}, {}, 0
  for i = 1, api.nvim_buf_line_count(state.filebuf) do
    local row = rows[i]
    if not row then
      lines[i] = '' -- Git emits no record for an empty buffer.
    else
      local uncommitted = row.hash:match('^0+$') ~= nil
      local hash = uncommitted and 'working ' or row.hash:sub(1, 8)
      local date = uncommitted and '' or (' ' .. os.date('%Y-%m-%d', tonumber(row['author-time'])))
      local author = vim.fn.strcharpart(clean(uncommitted and 'You' or row.author), 0, 16)
      lines[i] = string.format(' %s%s %s', hash, date, author)
      local author_col = 10 + #date
      marks[#marks + 1] = { i - 1, 1, 9, uncommitted and 'DiagnosticWarn' or 'Identifier' }
      if not uncommitted then marks[#marks + 1] = { i - 1, 10, 20, 'Comment' } end
      marks[#marks + 1] = { i - 1, author_col, author_col + #author, 'String' }
    end
    width = math.max(width, vim.fn.strdisplaywidth(lines[i]))
  end
  local available = api.nvim_win_get_width(state.source) + api.nvim_win_get_width(state.win)
  api.nvim_win_set_width(state.win, math.min(width + 1, math.max(20, math.floor(available * 0.45))))
  state.rows = rows
  vim.bo[state.buf].modifiable = true
  api.nvim_buf_set_lines(state.buf, 0, -1, false, lines)
  api.nvim_buf_clear_namespace(state.buf, ns, 0, -1)
  for _, mark in ipairs(marks) do
    api.nvim_buf_set_extmark(state.buf, ns, mark[1], mark[2], {
      end_col = mark[3], hl_group = mark[4],
    })
  end
  vim.bo[state.buf].modifiable = false
  -- Start both windows at the same line, even when opening halfway down a file.
  local view = api.nvim_win_call(state.source, vim.fn.winsaveview)
  api.nvim_win_set_cursor(state.win, { view.lnum, 0 })
  api.nvim_win_call(state.win, function()
    vim.fn.winrestview({ topline = view.topline, lnum = view.lnum, col = 0 })
  end)
  api.nvim_win_call(state.source, function() vim.cmd('syncbind') end)
end

local function refresh(state)
  state.request = state.request + 1
  local request = state.request
  state.rows = {} -- Never open an old commit while new attribution is pending.
  if state.job then state.job:kill(15); state.job = nil end
  vim.defer_fn(function()
    if views[state.source] ~= state or state.request ~= request then return end
    local contents = table.concat(api.nvim_buf_get_lines(state.filebuf, 0, -1, false), '\n')
    if vim.bo[state.filebuf].endofline then contents = contents .. '\n' end
    local tick = api.nvim_buf_get_changedtick(state.filebuf)
    state.job = vim.system({
      'git', '--no-pager', 'blame', '--line-porcelain', '--encoding=UTF-8',
      '--contents', '-', '--', state.repo.relative_file,
    }, { cwd = state.repo.root, text = true, stdin = contents }, function(result)
      vim.schedule(function()
        if views[state.source] ~= state or state.request ~= request then return end
        state.job = nil
        if api.nvim_buf_get_changedtick(state.filebuf) ~= tick then refresh(state); return end
        if result.code ~= 0 then
          close(state)
          notify(vim.trim(result.stderr or 'Unable to read history'), vim.log.levels.ERROR)
          return
        end
        render(state, parse(result.stdout))
      end)
    end)
  end, 120)
end

local function show_commit(state)
  local row = state.rows[api.nvim_win_get_cursor(state.win)[1]]
  if not row then return end
  if row.hash:match('^0+$') then notify('This line has not been committed'); return end
  local repo = state.repo
  -- Fall back to the whole commit for renames and paths absent at this revision.
  local scoped = vim.system({ 'git', 'cat-file', '-e', row.hash .. ':' .. repo.relative_file },
    { cwd = repo.root, text = true }):wait().code == 0
  local cmd = { 'git', '--paginate', 'show', '--no-ext-diff', '--no-textconv', row.hash }
  if scoped then vim.list_extend(cmd, { '--', repo.relative_file }) end
  vim.cmd('tabnew')
  -- Delta renders into Neovim's terminal scrollback, without a nested pager.
  vim.fn.jobstart(cmd, { cwd = repo.root, term = true, env = { GIT_PAGER = 'delta --paging=never' } })
  vim.keymap.set('t', 'q', '<C-\\><C-n>:tabclose<CR>', { buffer = 0 })
  vim.keymap.set('n', 'q', '<cmd>tabclose<CR>', { buffer = 0 })
end

function M.toggle()
  local source = api.nvim_get_current_win()
  for _, state in pairs(views) do
    if source == state.source or source == state.win then close(state); return end
  end
  local filebuf = api.nvim_get_current_buf()
  if vim.bo[filebuf].buftype ~= '' then notify('Open a file first'); return end
  local repo, err = require('custom.gitgud').file_repo()
  if not repo then notify(err); return end

  local state = {
    source = source, filebuf = filebuf, repo = repo, saved = {}, rows = {}, request = 0,
    buf = api.nvim_create_buf(false, true),
    group = api.nvim_create_augroup('custom-blame-' .. source, { clear = true }),
  }
  state.win = api.nvim_open_win(state.buf, false, { split = 'left', win = source, width = 30 })
  state.diagnostics = vim.diagnostic.is_enabled({ bufnr = filebuf })
  state.codelens = vim.lsp.codelens.is_enabled({ bufnr = filebuf })
  for _, other in pairs(views) do
    if other.filebuf == filebuf then
      state.diagnostics, state.codelens = other.diagnostics, other.codelens
      break
    end
  end
  views[source] = state
  -- Virtual lines break row alignment. Restore these after the last view closes.
  vim.diagnostic.enable(false, { bufnr = filebuf })
  vim.lsp.codelens.enable(false, { bufnr = filebuf })
  vim.bo[state.buf].buftype = 'nofile'
  vim.bo[state.buf].bufhidden = 'wipe'
  vim.bo[state.buf].filetype = 'gitblame'
  vim.bo[state.buf].modifiable = false
  for name, value in pairs({ scrollbind = true, cursorbind = true, wrap = false, foldenable = false }) do
    state.saved[name] = vim.wo[source][name]
    vim.wo[source][name] = value
    vim.wo[state.win][name] = value
  end
  for name, value in pairs({
    number = false, relativenumber = false, signcolumn = 'no', foldcolumn = '0',
    statuscolumn = '', colorcolumn = '', winbar = '', list = false, spell = false,
    cursorline = true, cursorlineopt = 'line', winfixwidth = true,
    statusline = ' Blame%=%<↵ show · q close ',
  }) do
    vim.wo[state.win][name] = value
  end
  -- Equal text areas are needed for bound scrolling if the source has a winbar.
  if vim.wo[source].winbar ~= '' then vim.wo[state.win].winbar = ' Git blame' end
  vim.keymap.set('n', 'q', function() close(state) end, { buffer = state.buf, desc = 'Close blame' })
  vim.keymap.set('n', '<CR>', function() show_commit(state) end,
    { buffer = state.buf, desc = 'Show commit' })
  api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'BufWritePost' }, {
    group = state.group, buffer = filebuf, callback = function() refresh(state) end,
  })
  api.nvim_create_autocmd({ 'WinClosed', 'BufWinEnter', 'BufWinLeave' }, {
    group = state.group,
    callback = function()
      vim.schedule(function()
        if views[source] ~= state then return end
        if not api.nvim_win_is_valid(source) or not api.nvim_win_is_valid(state.win)
          or api.nvim_win_get_buf(source) ~= filebuf or api.nvim_win_get_buf(state.win) ~= state.buf then
          close(state)
        end
      end)
    end,
  })
  refresh(state)
end

return M
