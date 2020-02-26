general_config:
	mkdir -p ~/.local/bin ~/.config
	stow .config/ -t ~/.config/
	stow bin/ -t ~/.local/bin/
	chmod +x bin/*
	cp .gitconfig ~/
	lesskey misc/lesskey
	# Added || true, since WSL won't have these paths
	# Keymap
	sudo ln -sf $(CURDIR)/keymaps/colemak /usr/share/X11/xkb/symbols/colemak || true
	# Touchpad
	sudo ln -sf $(CURDIR)/misc/40-libinput.conf /etc/X11/xorg.conf.d/40-libinput.conf || true
	# Sudo config
	sudo ln -sf $(CURDIR)/shell/.bashrc /root/.bashrc
	sudo ln -sf $(CURDIR)/shell/.aliasrc /root/.aliasrc

arch_config: general_config
	cd ~ || exit && \
    rm -f .xinitrc .bashrc .config/gtk3-0/settings.ini .zshrc .bash_profile
	stow x/
	stow shell/
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

git_config:
	git config --global user.name "ALX99"
	git config --global user.email "46844683+ALX99@users.noreply.github.com"

kali_dep:
	sudo apt -y install xorg xbacklight alsa-utils fonts-hack-ttf htop neovim stow sxhkd xinput dunst tldr fzf gobuster libx11-dev libxft-dev libxinerama-dev dmenu ssh
	mkdir -p ~/.local/bin
	wget -O ~/.local/bin/diff-so-fancy https://raw.githubusercontent.com/so-fancy/diff-so-fancy/master/third_party/build_fatpack/diff-so-fancy
	chmod +x ~/.local/bin/diff-so-fancy

kali: kali_dep kali_config 
	curl https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > microsoft.gpg
	sudo mv microsoft.gpg /etc/apt/trusted.gpg.d/microsoft.gpg
	sudo su -c 'echo "deb [arch=amd64] https://packages.microsoft.com/repos/vscode stable main" > /etc/apt/sources.list.d/vscode.list'
	sudo apt update && sudo apt install code
	
arch: arch_config arch_dep dash dwm
	sudo sed -i '/Color/s/^#//g' /etc/pacman.conf
	sudo sed -i '/TotalDownload/s/^#//g' /etc/pacman.conf
	sudo sed -i '/VerbosePkgLists/s/^#//g' /etc/pacman.conf
