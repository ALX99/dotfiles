FROM archlinux:base

# DisableSandboxSyscalls lets pacman run under Docker's seccomp profile.
# Only bootstrap essentials live here; every versioned tool comes from the
# stowed ~/.config/mise/config.toml via `mise install` in bootstrap.sh.
RUN sed -i '/^#DisableSandboxSyscalls/s/^#//' /etc/pacman.conf \
    && pacman -Syu --noconfirm --needed \
      base-devel \
      ca-certificates \
      git \
      less \
      mise \
      openssh \
      stow \
      sudo \
      tmux \
      unzip \
    && pacman -Scc --noconfirm

RUN useradd --create-home --shell /bin/bash codespace \
    && rm -f /home/codespace/.bash_logout /home/codespace/.bash_profile /home/codespace/.bashrc \
    && usermod --append --groups wheel codespace \
    && printf '%s\n' '%wheel ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/codespace \
    && chmod 0440 /etc/sudoers.d/codespace

# Inert until bootstrap.sh runs `mise install`; interactive shells get
# `mise activate` from ~/.bashrc instead.
ENV PATH="/home/codespace/.local/share/mise/shims:${PATH}"

USER codespace
WORKDIR /workspaces
