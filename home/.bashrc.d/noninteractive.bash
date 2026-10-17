# Bash reads this file for noninteractive invocations through BASH_ENV.
# Keep it to environment defaults; interactive startup belongs in .bashrc.
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
