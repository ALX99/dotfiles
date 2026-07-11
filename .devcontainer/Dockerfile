FROM archlinux:base

RUN sed -i '/^#DisableSandboxSyscalls/s/^#//' /etc/pacman.conf \
    && pacman -Syu --noconfirm --needed \
      base-devel \
      bash \
      ca-certificates \
      fd \
      fzf \
      git \
      go \
      github-cli \
      jq \
      just \
      neovim \
      nodejs \
      npm \
      openssh \
      python \
      python-pip \
      ripgrep \
      rust \
      shellcheck \
      stow \
      sudo \
      tmux \
      unzip \
      less \
    && pacman -Scc --noconfirm

RUN useradd --create-home --shell /bin/bash codespace \
    && usermod --append --groups wheel codespace \
    && printf '%s\n' '%wheel ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/codespace \
    && chmod 0440 /etc/sudoers.d/codespace

ENV EDITOR=nvim \
    VISUAL=nvim \
    SHELL=/bin/bash

USER codespace
WORKDIR /workspaces
