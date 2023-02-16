return {
  "echasnovski/mini.nvim",
  version = "^0.7.0",
  config = function()
    require('mini.trailspace').setup({})
    require('mini.starter').setup({
      header = function()
        local choices = {
          "    |\\__/,|   (`\\\n  _.|o o  |_   ) )\n-(((---(((--------",
          "    /\\_/\\           ___\n   = o_o =_______    \\ \\\n    __^      __(  \\.__) )\n(@)<_____>__(_____)____/",
          "  /\\_/\\  (\n ( ^.^ ) _)\n   \\\"/  (\n ( | | )\n(__d b__)",
          "         o  o   o  o\n         |\\/ \\^/ \\/|\n         |,-------.|\n       ,-.(|)   (|),-.\n       \\_*._ ' '_.* _/\n        /`-.`--' .-'\\\n   ,--./    `---'    \\,--.\n   \\   |(  )     (  )|   /\n    \\  | ||       || |  /\n     \\ | /|\\     /|\\ | /\n     /  \\-._     _,-/  \\\n    //| \\\\  `---'  // |\\\\\n   /,-.,-.\\       /,-.,-.\\\n  o   o   o      o   o    o",
          "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣄⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⣶⣾⣿⣿⣿⣿⣿⣶⡆⠀⠀⠀⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⡏⢤⡎⣿⣿⢡⣶⢹⣧⠀⠀⠀⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣶⣶⣇⣸⣷⣶⣾⣿⠀⠀⠀⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⢨⣿⣿⣿⢟⣿⣿⣿⣿⣿⣧⡀⠀⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⡏⣿⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⣿⣿⣜⠿⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀\n⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⣷⣿⡿⣷⣮⣙⠿⣿⣿⣿⣿⣿⡄⠀\n⠀⠀⠠⢄⣀⡀⠀⠀⠀⠀⠀⠈⠫⡯⢿⣿⣿⣿⣶⣯⣿⣻⣿⣿⠀\n⠀⠀⠤⢆⠆⠈⠉⠳⠤⣄⡀⠀⠀⠀⠙⢻⣿⣿⠿⠿⠿⢻⣿⠙⠇\n⠠⠤⠀⣉⣁⣢⣄⣀⣀⣤⣿⠷⠦⠤⣠⡶⠿⣟⠀⠀⠀⠀⠻⡀⠀\n⠀⠀⠔⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠃⠃⠉⠉⠛⠛⠿⢷⡶⠀⠀",
          "      .---.        .-----------\n     /     \\  __  /    ------\n    / /     \\(  )/    -----\n   //////   ' \\/ `   ---\n  //// / // :    : ---\n // /   /  /`    '--\n//          //..\\\\\n       ====UU====UU====\n           '//||\\\\`\n             ''``",
          "                 /i\n                //,\n               ///i\n             ,/ ).'i\n              |   )-i\n              |   )i\n              '   )i\n             /    |-\n        _.-./-.  /z_\n         `-. >._\\ _ );i.\n          / `-'/`k-'`u)-'`\n         /    )-\n  ,.----'   ) '\n  /      )1`\n ///v`-v\\v\n/v",
          "     ,*-~\"`^\"*u_                                _u*\"^`\"~-*,\n  p!^       /  jPw                            w9j \\        ^!p\nw^.._      /      \"\\_                      _/\"     \\        _.^w\n     *_   /          \\_      _    _      _/         \\     _*\n       q /           / \\q   ( `--` )   p/ \\          \\   p\n       jj5****._    /    ^\\_) o  o (_/^    \\    _.****6jj\n                *_ /      \"==) ;; (==\"      \\ _*\n                 `/.w***,   /(    )\\   ,***w.\\\"\n                  ^      ^c/ )    ( \\c^      ^\n                          'V')_)(_('V'\n                              `` ``",
          "    =/\\                 /\\=\n    / \\'._   (\\_/)   _.'/ \\\n   / .''._'--(o.o)--'_.''. \\\n  /.' _/ |`'=/ \" \\='`| \\_ `.\\\n /` .' `\\;-,'\\___/',-;/` '. '\\\n/.-'       `\\(-V-)/`       `-.\\\n`            \"   \"            `",
        }
        math.randomseed(os.time())
        return choices[math.random(1, #choices)]
      end
    })

    -- require('mini.pairs').setup({})
    require('mini.tabline').setup({})
    require('mini.cursorword').setup({})
    require('mini.statusline').setup({})
    require('mini.align').setup({
      mappings = {
        start = '<leader>Pa',
        start_with_preview = '<leader>PA'
      },
    })
    require('mini.indentscope').setup({
      mappings = {
        object_scope = 'o',
        object_scope_with_border = 'ao',
      },
    })
  end,
}
