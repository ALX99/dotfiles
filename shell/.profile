#!/bin/bash
# shellcheck disable=SC2034

set -a

PATH="$PATH:$HOME/go/bin:$PATH:$HOME/.cargo/bin:$HOME/.local/bin/"

# XDG
XDG_CACHE_HOME="$HOME/.cache"
XDG_CONFIG_HOME="$HOME/.config"
XDG_DATA_HOME="$HOME/.local/share"
XDG_STATE_HOME="$HOME/.local/state"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
XDG_RUNTIME_DIR="$(ls -d /tmp/runtime-"$USER".???* 2>/dev/null || mktemp -d /tmp/runtime-"$USER".XXX | tee)"

stty -ixon # Disable ctrl-s and ctrl-q.

# Stuff that I want to conditionally set
if true; then
  # Default programs
  TERMINAL="st"
  TERM="st-256color"
  EDITOR="nvim"
  VISUAL="nvim"
  BROWSER="brave"
  FILE="pcmanfm"
fi

# Program settings
LS_COLORS='sg=0:su=0:rs=0:mh=0:cd=0;38;2;255;106;193;48;2;51;51;51:*~=0;38;2;102;102;102:di=0;38;2;87;199;255:so=0;38;2;0;0;0;48;2;255;106;193:mi=0;38;2;0;0;0;48;2;255;92;87:bd=0;38;2;154;237;254;48;2;51;51;51:ca=0:pi=0;38;2;0;0;0;48;2;87;199;255:ln=0;38;2;255;106;193:ow=0:or=0;38;2;0;0;0;48;2;255;92;87:ex=1;38;2;255;92;87:fi=0:do=0;38;2;0;0;0;48;2;255;106;193:st=0:no=0:tw=0:*.a=1;38;2;255;92;87:*.r=0;38;2;90;247;142:*.m=0;38;2;90;247;142:*.o=0;38;2;102;102;102:*.t=0;38;2;90;247;142:*.c=0;38;2;90;247;142:*.d=0;38;2;90;247;142:*.z=4;38;2;154;237;254:*.p=0;38;2;90;247;142:*.h=0;38;2;90;247;142:*css=0;38;2;90;247;142:*.jl=0;38;2;90;247;142:*.el=0;38;2;90;247;142:*.py=0;38;2;90;247;142:*.bc=0;38;2;102;102;102:*.ll=0;38;2;90;247;142:*.pp=0;38;2;90;247;142:*.ts=0;38;2;90;247;142:*.td=0;38;2;90;247;142:*.ex=0;38;2;90;247;142:*.as=0;38;2;90;247;142:*.kt=0;38;2;90;247;142:*.di=0;38;2;90;247;142:*.hs=0;38;2;90;247;142:*.rm=0;38;2;255;180;223:*.ui=0;38;2;243;249;157:*.xz=4;38;2;154;237;254:*.sh=0;38;2;90;247;142:*.js=0;38;2;90;247;142:*.gv=0;38;2;90;247;142:*.vb=0;38;2;90;247;142:*.nb=0;38;2;90;247;142:*.cp=0;38;2;90;247;142:*.lo=0;38;2;102;102;102:*.ps=0;38;2;255;92;87:*.cc=0;38;2;90;247;142:*.la=0;38;2;102;102;102:*.pl=0;38;2;90;247;142:*.so=1;38;2;255;92;87:*.ko=1;38;2;255;92;87:*.mn=0;38;2;90;247;142:*.wv=0;38;2;255;180;223:*.7z=4;38;2;154;237;254:*.go=0;38;2;90;247;142:*.cs=0;38;2;90;247;142:*.hh=0;38;2;90;247;142:*.pm=0;38;2;90;247;142:*.bz=4;38;2;154;237;254:*.cr=0;38;2;90;247;142:*.hi=0;38;2;102;102;102:*.gz=4;38;2;154;237;254:*.rb=0;38;2;90;247;142:*.ml=0;38;2;90;247;142:*.fs=0;38;2;90;247;142:*.rs=0;38;2;90;247;142:*.md=0;38;2;243;249;157:*.mov=0;38;2;255;180;223:*.csx=0;38;2;90;247;142:*.blg=0;38;2;102;102;102:*.eps=0;38;2;255;180;223:*.dmg=4;38;2;154;237;254:*.kex=0;38;2;255;92;87:*.idx=0;38;2;102;102;102:*.pkg=4;38;2;154;237;254:*.tml=0;38;2;243;249;157:*.tsx=0;38;2;90;247;142:*.vim=0;38;2;90;247;142:*.dpr=0;38;2;90;247;142:*.bst=0;38;2;243;249;157:*.php=0;38;2;90;247;142:*.wmv=0;38;2;255;180;223:*.doc=0;38;2;255;92;87:*.arj=4;38;2;154;237;254:*.inc=0;38;2;90;247;142:*.xlr=0;38;2;255;92;87:*.com=1;38;2;255;92;87:*.aif=0;38;2;255;180;223:*.exs=0;38;2;90;247;142:*.odt=0;38;2;255;92;87:*.swp=0;38;2;102;102;102:*.apk=4;38;2;154;237;254:*.mkv=0;38;2;255;180;223:*.gvy=0;38;2;90;247;142:*.git=0;38;2;102;102;102:*.flv=0;38;2;255;180;223:*.ppt=0;38;2;255;92;87:*.fon=0;38;2;255;180;223:*.xls=0;38;2;255;92;87:*.ico=0;38;2;255;180;223:*.toc=0;38;2;102;102;102:*.cpp=0;38;2;90;247;142:*.inl=0;38;2;90;247;142:*.erl=0;38;2;90;247;142:*.xcf=0;38;2;255;180;223:*.h++=0;38;2;90;247;142:*.mpg=0;38;2;255;180;223:*.wma=0;38;2;255;180;223:*.pgm=0;38;2;255;180;223:*.tar=4;38;2;154;237;254:*.wav=0;38;2;255;180;223:*.lua=0;38;2;90;247;142:*.elm=0;38;2;90;247;142:*.mp3=0;38;2;255;180;223:*.ps1=0;38;2;90;247;142:*.xml=0;38;2;243;249;157:*.tgz=4;38;2;154;237;254:*.bmp=0;38;2;255;180;223:*.bcf=0;38;2;102;102;102:*.bag=4;38;2;154;237;254:*.iso=4;38;2;154;237;254:*.pid=0;38;2;102;102;102:*.fsx=0;38;2;90;247;142:*.dox=0;38;2;165;255;195:*.ilg=0;38;2;102;102;102:*.bbl=0;38;2;102;102;102:*.fnt=0;38;2;255;180;223:*.vob=0;38;2;255;180;223:*.mir=0;38;2;90;247;142:*.aux=0;38;2;102;102;102:*.fsi=0;38;2;90;247;142:*.ltx=0;38;2;90;247;142:*.rtf=0;38;2;255;92;87:*.rst=0;38;2;243;249;157:*.sxi=0;38;2;255;92;87:*.asa=0;38;2;90;247;142:*.psd=0;38;2;255;180;223:*.awk=0;38;2;90;247;142:*.htc=0;38;2;90;247;142:*.mli=0;38;2;90;247;142:*.bat=1;38;2;255;92;87:*.ppm=0;38;2;255;180;223:*.mp4=0;38;2;255;180;223:*.tmp=0;38;2;102;102;102:*.sty=0;38;2;102;102;102:*.zip=4;38;2;154;237;254:*.bak=0;38;2;102;102;102:*.svg=0;38;2;255;180;223:*.csv=0;38;2;243;249;157:*.epp=0;38;2;90;247;142:*.ics=0;38;2;255;92;87:*.pyc=0;38;2;102;102;102:*.cxx=0;38;2;90;247;142:*.pod=0;38;2;90;247;142:*.clj=0;38;2;90;247;142:*.bsh=0;38;2;90;247;142:*.pyd=0;38;2;102;102;102:*.out=0;38;2;102;102;102:*.pps=0;38;2;255;92;87:*.mid=0;38;2;255;180;223:*.cgi=0;38;2;90;247;142:*.m4a=0;38;2;255;180;223:*.png=0;38;2;255;180;223:*.zst=4;38;2;154;237;254:*.pyo=0;38;2;102;102;102:*.ogg=0;38;2;255;180;223:*.pdf=0;38;2;255;92;87:*.sxw=0;38;2;255;92;87:*.rar=4;38;2;154;237;254:*.vcd=4;38;2;154;237;254:*hgrc=0;38;2;165;255;195:*.dot=0;38;2;90;247;142:*.hpp=0;38;2;90;247;142:*.txt=0;38;2;243;249;157:*.bin=4;38;2;154;237;254:*.tex=0;38;2;90;247;142:*TODO=1:*.pro=0;38;2;165;255;195:*.pbm=0;38;2;255;180;223:*.gif=0;38;2;255;180;223:*.bz2=4;38;2;154;237;254:*.jar=4;38;2;154;237;254:*.odp=0;38;2;255;92;87:*.def=0;38;2;90;247;142:*.swf=0;38;2;255;180;223:*.pas=0;38;2;90;247;142:*.sbt=0;38;2;90;247;142:*.tif=0;38;2;255;180;223:*.htm=0;38;2;243;249;157:*.kts=0;38;2;90;247;142:*.sql=0;38;2;90;247;142:*.tbz=4;38;2;154;237;254:*.dll=1;38;2;255;92;87:*.hxx=0;38;2;90;247;142:*.ttf=0;38;2;255;180;223:*.rpm=4;38;2;154;237;254:*.ind=0;38;2;102;102;102:*.log=0;38;2;102;102;102:*.ods=0;38;2;255;92;87:*.bib=0;38;2;243;249;157:*.exe=1;38;2;255;92;87:*.xmp=0;38;2;243;249;157:*.deb=4;38;2;154;237;254:*.m4v=0;38;2;255;180;223:*.ipp=0;38;2;90;247;142:*.ini=0;38;2;243;249;157:*.otf=0;38;2;255;180;223:*.tcl=0;38;2;90;247;142:*.nix=0;38;2;243;249;157:*.zsh=0;38;2;90;247;142:*.yml=0;38;2;243;249;157:*.c++=0;38;2;90;247;142:*.avi=0;38;2;255;180;223:*.fls=0;38;2;102;102;102:*.jpg=0;38;2;255;180;223:*.cfg=0;38;2;243;249;157:*.img=4;38;2;154;237;254:*.html=0;38;2;243;249;157:*.yaml=0;38;2;243;249;157:*.lock=0;38;2;102;102;102:*.docx=0;38;2;255;92;87:*.less=0;38;2;90;247;142:*.conf=0;38;2;243;249;157:*.dart=0;38;2;90;247;142:*.epub=0;38;2;255;92;87:*.tbz2=4;38;2;154;237;254:*.purs=0;38;2;90;247;142:*.bash=0;38;2;90;247;142:*.hgrc=0;38;2;165;255;195:*.psd1=0;38;2;90;247;142:*.orig=0;38;2;102;102;102:*.jpeg=0;38;2;255;180;223:*.java=0;38;2;90;247;142:*.h264=0;38;2;255;180;223:*.json=0;38;2;243;249;157:*.mpeg=0;38;2;255;180;223:*.diff=0;38;2;90;247;142:*.toml=0;38;2;243;249;157:*.xlsx=0;38;2;255;92;87:*.tiff=0;38;2;255;180;223:*.flac=0;38;2;255;180;223:*.opus=0;38;2;255;180;223:*.psm1=0;38;2;90;247;142:*.rlib=0;38;2;102;102;102:*.make=0;38;2;165;255;195:*.pptx=0;38;2;255;92;87:*.lisp=0;38;2;90;247;142:*.webm=0;38;2;255;180;223:*.fish=0;38;2;90;247;142:*.swift=0;38;2;90;247;142:*.patch=0;38;2;90;247;142:*.ipynb=0;38;2;90;247;142:*.toast=4;38;2;154;237;254:*.mdown=0;38;2;243;249;157:*.xhtml=0;38;2;243;249;157:*.cache=0;38;2;102;102;102:*.scala=0;38;2;90;247;142:*.shtml=0;38;2;243;249;157:*.cabal=0;38;2;90;247;142:*.cmake=0;38;2;165;255;195:*shadow=0;38;2;243;249;157:*.class=0;38;2;102;102;102:*passwd=0;38;2;243;249;157:*README=0;38;2;40;42;54;48;2;243;249;157:*.dyn_o=0;38;2;102;102;102:*.matlab=0;38;2;90;247;142:*.dyn_hi=0;38;2;102;102;102:*.flake8=0;38;2;165;255;195:*LICENSE=0;38;2;153;153;153:*COPYING=0;38;2;153;153;153:*.gradle=0;38;2;90;247;142:*.groovy=0;38;2;90;247;142:*.ignore=0;38;2;165;255;195:*INSTALL=0;38;2;40;42;54;48;2;243;249;157:*TODO.md=1:*.config=0;38;2;243;249;157:*Doxyfile=0;38;2;165;255;195:*TODO.txt=1:*.desktop=0;38;2;243;249;157:*Makefile=0;38;2;165;255;195:*.gemspec=0;38;2;165;255;195:*setup.py=0;38;2;165;255;195:*.DS_Store=0;38;2;102;102;102:*.markdown=0;38;2;243;249;157:*.cmake.in=0;38;2;165;255;195:*.kdevelop=0;38;2;165;255;195:*README.md=0;38;2;40;42;54;48;2;243;249;157:*COPYRIGHT=0;38;2;153;153;153:*.fdignore=0;38;2;165;255;195:*.rgignore=0;38;2;165;255;195:*configure=0;38;2;165;255;195:*INSTALL.md=0;38;2;40;42;54;48;2;243;249;157:*.scons_opt=0;38;2;102;102;102:*README.txt=0;38;2;40;42;54;48;2;243;249;157:*.localized=0;38;2;102;102;102:*SConscript=0;38;2;165;255;195:*SConstruct=0;38;2;165;255;195:*CODEOWNERS=0;38;2;165;255;195:*.gitignore=0;38;2;165;255;195:*Dockerfile=0;38;2;243;249;157:*.gitconfig=0;38;2;165;255;195:*LICENSE-MIT=0;38;2;153;153;153:*Makefile.in=0;38;2;102;102;102:*Makefile.am=0;38;2;165;255;195:*MANIFEST.in=0;38;2;165;255;195:*.travis.yml=0;38;2;90;247;142:*.synctex.gz=0;38;2;102;102;102:*INSTALL.txt=0;38;2;40;42;54;48;2;243;249;157:*.gitmodules=0;38;2;165;255;195:*.fdb_latexmk=0;38;2;102;102;102:*.applescript=0;38;2;90;247;142:*appveyor.yml=0;38;2;90;247;142:*configure.ac=0;38;2;165;255;195:*CONTRIBUTORS=0;38;2;40;42;54;48;2;243;249;157:*.clang-format=0;38;2;165;255;195:*CMakeLists.txt=0;38;2;165;255;195:*LICENSE-APACHE=0;38;2;153;153;153:*CMakeCache.txt=0;38;2;102;102;102:*.gitattributes=0;38;2;165;255;195:*CONTRIBUTORS.md=0;38;2;40;42;54;48;2;243;249;157:*requirements.txt=0;38;2;165;255;195:*CONTRIBUTORS.txt=0;38;2;40;42;54;48;2;243;249;157:*.sconsign.dblite=0;38;2;102;102;102:*package-lock.json=0;38;2;102;102;102:*.CFUserTextEncoding=0;38;2;102;102;102'
FZF_DEFAULT_COMMAND="rg --files --hidden"
FZF_LEGACY_KEYBINDINGS="0"
_JAVA_AWT_WM_NONREPARENTING="1"
QT_QPA_PLATFORMTHEME=qt6ct
DOCKER_BUILDKIT="1"
CGO_ENABLED="0"
LESSKEYIN="$HOME/dotfiles/misc/lesskey"
TASK_TEMP_DIR="/tmp/.task"
CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"
[ -x "$(command -v bat)" ] && MANPAGER="sh -c 'col -bx | bat -l man -p'"

# Clean up ~/
# https://wiki.archlinux.org/title/XDG_Base_Directory
# The XAUTHORITY line will break some DMs.
ZDOTDIR="$XDG_CONFIG_HOME/.config}/zsh"
LESSHISTFILE="-"
LESSKEY="$XDG_CONFIG_HOME/less/lesskey"
XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority"
WGETRC="$XDG_CONFIG_HOME/wget/wgetrc"
GTK2_RC_FILES="$XDG_CONFIG_HOME/gtk-2.0/gtkrc"

# IM
GTK_IM_MODULE="fcitx"
QT_IM_MODULE="fcitx"
XMODIFIERS="@im=fcitx"

# Bash stuff
PROMPT_COMMAND='history -a'                     # Record each line as it gets issued
HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear" # Don't record some commands
HISTSIZE=-1                                     # Infinite history
HISTFILESIZE=-1                                 # Infinite history
HISTCONTROL=ignoreboth                          # Don't record duplicate stuff & stuff that starts with space in history

set +a

