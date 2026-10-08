# Bash reads this file for noninteractive invocations through BASH_ENV.
# Keep it to environment defaults; interactive startup belongs in .bashrc.
unset VISUAL
export GIT_EDITOR=false
export GIT_SEQUENCE_EDITOR=false
export GIT_PAGER=cat
export GH_PAGER=cat
export PAGER=cat
export GIT_TERMINAL_PROMPT=0
