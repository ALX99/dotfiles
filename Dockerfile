FROM alpine:edge

COPY .local/bin /home/owo/.local/bin
COPY .config /home/owo/.config
COPY shell/* /home/owo/

# https://wiki.alpinelinux.org/wiki/How_to_get_regular_stuff_working
RUN set -x && apk add --no-cache \
  util-linux coreutils binutils findutils grep docker \
  util-linux-doc coreutils-doc binutils-doc findutils-doc bash-doc man-pages grep-doc \
  neovim gcc libstdc++ g++ \
  bat fd fzf git jq ripgrep curl delta \
  go gopls \
  python3 py3-pip \
  shfmt shellcheck bash-completion \
  npm \
  && npm i -g \
  dockerfile-language-server-nodejs \
  yaml-language-server \
  pyright \
  && adduser --disabled-password -h /home/owo -s /bin/bash owo \
  && chown -R owo:owo /home/owo

USER owo
WORKDIR /home/owo

RUN set -x \
  && nvim --headless -c "Lazy install" -c q \
  && nvim --headless -c "TSUpdate" -c q \
  && mkdir ~/tmp && cd ~/tmp \
  && curl -L \
  "https://github.com/derailed/k9s/releases/download/v0.27.0/k9s_Linux_amd64.tar.gz" | \
  tar xz \
  && mv ./k9s ~/.local/k9s \
  && rm -rf ~/tmp

USER root
RUN apk del g++

USER owo
ENV USER=owo
ENV TERM="xterm-256color"
ENV HOME=/home/owo
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
