#!/bin/sh

PROMPT_COMMAND='history -a'                     # Record each line as it gets issued
HISTIGNORE="&:[ ]*:exit:ls:bg:fg:history:clear" # Don't record some commands
HISTSIZE=-1                                     # Infinite history
HISTFILESIZE=-1                                 # Infinite history
HISTCONTROL=ignoreboth                          # Don't record duplicate stuff & stuff that starts with space in history

# autocd autocd
# cdspell fix minor spelling mistakes in dirname of a cd command
# dirspell Bash attempts spelling correction on directory names during word completion if the directory name initially supplied does not exist.
# histappend append to $HISTFILE instead of overwriting it
# checkjobs check if there are any stopped or running jobs before exiting an interactive shell
# checkwinsize check the window size after each external command and, if necessary, updates the values of $LINES and $COLUMNSk
# cmdhist Ues one command per line

# We should be running bash in this if condition
# shellcheck disable=SC3044
shopt -s autocd cdspell dirspell histappend checkjobs direxpand checkwinsize cmdhist

. ~/.profile

