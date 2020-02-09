general_config:
	mkdir -p ~/.local/bin
	stow .config/ -t ~/.config/
	stow bin/ -t ~/.local/bin/
	chmod +x bin/*
	cp .gitconfig ~/

arch_config: general_config
	cd ~ || exit && \
    rm -f .xinitrc .bashrc .config/gtk3-0/settings.ini .zshrc .bash_profile
	stow x/
	stow shell/


kali_config: general_config
	ln -sf $(CURDIR)/kali/.bashrc ~/.bashrc
	ln -sf $(CURDIR)/shell/.aliasrc ~/.aliasrc
	ln -sf $(CURDIR)/shell/.profile ~/.profile

keymap:
	sudo ln -s $(CURDIR)/keymaps/colemak /usr/share/X11/xkb/symbols/colemak

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

kali_dep:
	sudo apt -y install neovim stow tldr fzf gobuster
	wget -O ~/.local/bin/diff-so-fancy https://raw.githubusercontent.com/so-fancy/diff-so-fancy/master/third_party/build_fatpack/diff-so-fancy
	chmod +x ~/.local/bin/diff-so-fancy

kali: kali_dep keymap kali_config
	
arch: keymap arch_config
