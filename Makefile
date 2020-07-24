general_config:
	mkdir -p ~/.local ~/.config
	stow .config/ -t ~/.config/
	ln -sf $(CURDIR)/.local/bin/ ~/.local/
	ln -sf $(CURDIR)/.local/applications/ ~/.local/share/
	ln -sf $(CURDIR).gitconfig ~/
	# Specify keybindings for less
	lesskey $(CURDIR)/misc/lesskey
	# Added || true, since WSL won't have these paths
	# Keymap
	sudo ln -sf $(CURDIR)/keymaps/colemak /usr/share/X11/xkb/symbols/colemak || true
	# Touchpad
	sudo ln -sf $(CURDIR)/misc/40-libinput.conf /etc/X11/xorg.conf.d/40-libinput.conf || true
	# Prefer RAM over swap
	sudo ln -s $(CURDIR)/misc/99-swappiness.conf /etc/sysctl.d/
	# Root config
	sudo ln -sf $(CURDIR)/shell/.bashrc /root/.bashrc
	sudo ln -sf $(CURDIR)/shell/.aliasrc /root/.aliasrc

arch_config: general_config
	cd ~ || exit && \
    rm -f .xinitrc .bashrc .config/gtk3-0/settings.ini .zshrc .bash_profile
	stow x/
	stow shell/
	stow spectr/
	sudo ln -sf $(CURDIR)/hooks /etc/pacman.d/
	ln -sf $(CURDIR)/.gitconfig ~/

# Arch dependencies are handeled by paccy
arch_dep:
	~/.local/bin/paccy -ia


arch: arch_config  arch_dep ssh_agent dash
	sudo sed -i '/Color/s/^#//g' /etc/pacman.conf
	sudo sed -i '/TotalDownload/s/^#//g' /etc/pacman.conf
	sudo sed -i '/VerbosePkgLists/s/^#//g' /etc/pacman.conf
	sudo systemctl enable tlp
	sudo pacman -S fish
	chsh -s /bin/fish
	fish .config/fish/setup.fish

# Cache keys
ssh_agent:
	echo "AddKeysToAgent yes" > ~/.ssh/config
	ln -sf $(CURDIR)/misc/.pam_environment ~/
	systemctl --user enable ssh-agent
	systemctl --user start ssh-agent

# Since dash is faster than bash
dash:
	sudo pacman -S dash
	sudo ln -sfT dash /usr/bin/sh


# Get rid of the stupid KDE wallet thing
kde:
	kwriteconfig5 --file kwalletrc --group 'Wallet' --key 'Enabled' 'false'
	kwriteconfig5 --file kwalletrc --group 'Wallet' --key 'First Use' 'false'
	
