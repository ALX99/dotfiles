# dotfiles

this is my personal dotfiles repo. mostly a place to keep the config i use
across machines, but there are a few aliases and scripts in here that might be
useful to you as well.

## skills

i like to keep things fairly minimal. if you are interested in my skills,
check them out in the [skills directory](home/.agents/skills/) or run
`npx skills add ALX99/dotfiles --list`.

## checks

Run `mise run check` for the Pi, Herdr, and shell checks. Pi requires Node 26+
and the pnpm version pinned in its package manifest; the script tests require
Python 3.10+, Bash, and Git. Checks do not install dotfiles into your home directory.

| Command | Coverage |
| --- | --- |
| `mise run pi:check` | Locked dependencies, formatting, types, lint, dead code, and Pi tests |
| `mise run herdr:test` | Herdr plugin tests using CLI fixtures and temporary Git repositories |
| `mise run shell:test` | Shell syntax and integration-cache behavior |

Without mise, run the script tests with `bash .mise/tasks/herdr/test` and
`bash .mise/tasks/shell/test` from the repository root. ShellCheck runs separately
in CI; Karabiner changes also need `mise run karabiner:check`.

## software i like

- distro: [arch](https://archlinux.org/)
- compositor: [hyprland](https://hypr.land/)
- agent harness: [pi](https://pi.dev/)
- browser: [brave](https://brave.com/)
- editor: [neovim](https://neovim.io/)
- terminal emulator: [ghostty](https://ghostty.org/)
- terminal multiplexer: [tmux](https://github.com/tmux/tmux)
- shell: [bash](https://www.gnu.org/software/bash/)

## pictures

![preview](./preview.png)

## keyboard

[colemak dh](https://colemakmods.github.io/mod-dh/) is nice

![keyboard](./keyboard.png)

## map

for reference, here's roughly what's in here:

- [.profile](https://github.com/ALX99/dotfiles/blob/master/home/.profile)
      - Generic profile
- [.bashrc](https://github.com/ALX99/dotfiles/blob/master/home/.bashrc)
      - Bashrc
- [.bashrc.d/](https://github.com/ALX99/dotfiles/tree/master/home/.bashrc.d)
      - Bashrc includes
- [.aliasrc](https://github.com/ALX99/dotfiles/blob/master/home/.aliasrc)
      - Aliases
- [bin/](https://github.com/ALX99/dotfiles/tree/master/.local/bin)
      - Shell scripts
- [.config/](https://github.com/ALX99/dotfiles/tree/master/.config)
      - Program configs
- [.config/nvim](https://github.com/ALX99/dotfiles/tree/master/.config/nvim)
      - Neovim config
- [skills/](https://github.com/ALX99/dotfiles/tree/master/home/.agents/skills)
      - Agent skills
- [misc/](https://github.com/ALX99/dotfiles/tree/master/misc)
      - System-level configs (systemd, keymaps, pacman-hooks)
