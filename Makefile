general_config:
	mkdir -p ~/.local ~/.config
	stow .config/ -t ~/.config/
	ln -s $(CURDIR)/.local/bin/ ~/.local/
	ln -s $(CURDIR)/.local/applications/ ~/.local/share/
	ln -s $(CURDIR).gitconfig ~/
	lesskey misc/lesskey
	# Added || true, since WSL won't have these paths
	# Keymap
	sudo ln -sf $(CURDIR)/keymaps/colemak /usr/share/X11/xkb/symbols/colemak || true
	# Touchpad
	sudo ln -sf $(CURDIR)/misc/40-libinput.conf /etc/X11/xorg.conf.d/40-libinput.conf || true
	# Root config
	sudo ln -sf $(CURDIR)/shell/.bashrc /root/.bashrc
	sudo ln -sf $(CURDIR)/shell/.aliasrc /root/.aliasrc

ssh_agent:
	echo "AddKeysToAgent yes" >> ~/.ssh/config
	ln -s $(CURDIR)/misc/.pam_environment ~/
	sudo systemctl --user enable ssh-agent
	sudo systemctl --start ssh-agent


arch_config: general_config
	cd ~ || exit && \
    rm -f .xinitrc .bashrc .config/gtk3-0/settings.ini .zshrc .bash_profile
	stow x/
	stow shell/
	sudo ln -s $(CURDIR)/hooks /etc/pacman.d/
	ln -s $(CURDIR)/.gitconfig ~/


kali_config: general_config
	ln -sf $(CURDIR)/kali/.bashrc ~/.bashrc
	ln -sf $(CURDIR)/kali/.aliasrc ~/.aliasrc
	ln -sf $(CURDIR)/kali/.profile ~/.profile
	ln -sf $(CURDIR)/x/.xinitrc ~/.xinitrc
	sudo ln -sf $(CURDIR)/kali/xorg.conf /etc/X11/xorg.conf

dwm:
	rm -rf ~/dwm
	git clone git://git.suckless.org/dwm ~/dwm
	cd ~/dwm || exit && \
	git apply $(CURDIR)/suckless/dwm/dwm.diff && \
	git add . && \
	git commit -m "patch applied" && \
	sudo make install && \
	make clean

dash:
	sudo ln -sfT dash /usr/bin/sh

# TODO not working
zsh:
	wget https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh
	sh install.sh
	git clone https://github.com/zsh-users/zsh-completions ${ZSH_CUSTOM:=~/.oh-my-zsh/custom}/plugins/zsh-completions
	git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
	git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
	wget -P ~/.oh-my-zsh/custom/plugins/forgit https://raw.githubusercontent.com/wfxr/forgit/master/forgit.plugin.zsh
	# Remove dumb aliases
	sed -i '/^alias/ d' ~/.oh-my-zsh/plugins/git/git.plugin.zsh
	rm -f ~/.oh-my-zsh/lib/directories.zsh
	ln -sf shell/myTheme.zsh-theme ~/.oh-my-zsh/themes/
	chsh -s /bin/zsh

arch_dep:
	~/.local/bin/paccy -ia

kali_dep:
	sudo apt -y install xorg xbacklight alsa-utils libnotify-bin fonts-hack-ttf htop neovim stow sxhkd xinput dunst tldr fzf gobuster libx11-dev libxft-dev libxinerama-dev dmenu ssh
	mkdir -p ~/.local/bin
	wget -O ~/.local/bin/diff-so-fancy https://raw.githubusercontent.com/so-fancy/diff-so-fancy/master/third_party/build_fatpack/diff-so-fancy
	chmod +x ~/.local/bin/diff-so-fancy

kali: kali_dep kali_config 
	curl https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > microsoft.gpg
	sudo mv microsoft.gpg /etc/apt/trusted.gpg.d/microsoft.gpg
	sudo su -c 'echo "deb [arch=amd64] https://packages.microsoft.com/repos/vscode stable main" > /etc/apt/sources.list.d/vscode.list'
	sudo apt update && sudo apt install code
	
arch: arch_config ssh_agent arch_dep dash dwm
	sudo sed -i '/Color/s/^#//g' /etc/pacman.conf
	sudo sed -i '/TotalDownload/s/^#//g' /etc/pacman.conf
	sudo sed -i '/VerbosePkgLists/s/^#//g' /etc/pacman.conf

