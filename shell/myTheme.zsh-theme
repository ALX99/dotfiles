PROMPT='%{$fg[blue]%}%B%c/%b%{$reset_color%} $(git_prompt_info)%{$fg[white]%}%(!.#.$)%{$reset_color%} '
RPROMPT='[%*]'

# git theming
ZSH_THEME_GIT_PROMPT_PREFIX="%{$fg_bold[cyan]%}(%{$fg_no_bold[white]%}%B"
ZSH_THEME_GIT_PROMPT_SUFFIX="%b%{$fg_bold[cyan]%})%{$reset_color%} "
ZSH_THEME_GIT_PROMPT_CLEAN=" %{$fg_bold[green]%}✔"
ZSH_THEME_GIT_PROMPT_DIRTY=" %{$fg_bold[red]%}✗"

