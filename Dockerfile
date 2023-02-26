FROM alpine:edge

COPY .local/bin /home/hai/.local/bin
COPY .config /home/hai/.config
COPY shell/* /home/hai/

# https://wiki.alpinelinux.org/wiki/How_to_get_regular_stuff_working
RUN set -x && apk add --no-cache \
  util-linux coreutils binutils findutils grep docker \
  docs \
  neovim make g++ \
  bat fzf git jq yq ripgrep curl \
  go gopls \
  python3 py3-pip \
  shfmt shellcheck bash-completion \
  npm \
  && npm i -g \
  dockerfile-language-server-nodejs \
  yaml-language-server \
  pyright \
  && adduser --disabled-password -h /home/hai -s /bin/bash hai \
  && chown -R hai:hai /home/hai \
  && apk del npm

USER hai
WORKDIR /home/hai

RUN set -x \
  && nvim --headless -c "Lazy install" -c q \
  && nvim --headless -c "TSUpdate" -c q \
  && mkdir ~/tmp && cd ~/tmp \
  && curl -L \
  "https://github.com/derailed/k9s/releases/download/v0.27.3/k9s_Linux_amd64.tar.gz" | \
  tar xz \
  && curl -L \
  "https://github.com/jesseduffield/lazygit/releases/download/v0.37.0/lazygit_0.37.0_Linux_x86_64.tar.gz" | \
  tar xz \
  && curl -L \
  "https://dl.k8s.io/release/v1.23.16/bin/linux/amd64/kubectl" \
  -o ~/.local/bin/kubectl \
  && mv ./k9s ~/.local/bin/k9s \
  && mv ./lazygit ~/.local/bin/lazygit \
  && rm -rf ~/tmp

USER hai
ENV USER=hai
ENV TERM="xterm-256color"
ENV HOME=/home/hai
ENV PATH="$PATH:${HOME}/go/bin:$PATH:${HOME}/.cargo/bin:${HOME}/.local/bin/"
ENV EDITOR=nvim
ENV VISUAL=nvim
ENV FZF_DEFAULT_COMMAND="rg --files --hidden"
ENV FZF_LEGACY_KEYBINDINGS=0

CMD [ "bash" ]

# dockerfile-language-server-nodejs is used by docker-vscode
# https://github.com/microsoft/vscode-docker/blob/main/package.json

# yaml-language-server is used by vscode-yaml
# https://github.com/redhat-developer/vscode-yaml/blob/main/package.json

# vscode-langservers-extracted is maintained by the guy who maintains nvim-cmp
# https://github.com/hrsh7th/vscode-langservers-extracted

# removed for now:
# vscode-langservers-extracted  \
# bash-language-server \
