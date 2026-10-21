# Opt-in defaults for unattended commands, not general shell/session startup.
# Use BASH_ENV="$HOME/.bashrc.d/noninteractive.bash" bash -c '...' explicitly.
unset VISUAL
export EDITOR=false
export GIT_EDITOR="${GIT_EDITOR:-true}"
export GIT_SEQUENCE_EDITOR="${GIT_SEQUENCE_EDITOR:-false}"
export GH_EDITOR="${GH_EDITOR:-false}"
export GH_PROMPT_DISABLED=1
export SSH_ASKPASS_REQUIRE=never
export NO_COLOR=1
export GIT_PAGER=cat
export GH_PAGER=cat
export PAGER=cat
export GIT_TERMINAL_PROMPT=0
