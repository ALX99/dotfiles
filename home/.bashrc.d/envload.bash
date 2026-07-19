# Load the nearest .env from the current directory or an ancestor. This is a
# data-only dotenv parser: it never evaluates values as shell code.
__dotenv_active_file=
__dotenv_active_signature=
__dotenv_active_names=()
__dotenv_active_values=()
__dotenv_active_had_values=()
__dotenv_active_exported=()
__dotenv_last_pwd=

__dotenv_find() {
  local __dotenv__dir=$PWD

  while :; do
    if [[ -f $__dotenv__dir/.env ]]; then
      __dotenv_found_file=$__dotenv__dir/.env
      return
    fi
    [[ $__dotenv__dir == / ]] && break
    __dotenv__dir=${__dotenv__dir%/*}
    [[ -n $__dotenv__dir ]] || __dotenv__dir=/
  done

  __dotenv_found_file=
}

__dotenv_signature() {
  if [[ ${OSTYPE:-} == darwin* || ${OSTYPE:-} == freebsd* ]]; then
    /usr/bin/stat -f '%m:%i' "$1"
  else
    /usr/bin/stat -c '%Y:%i' "$1"
  fi
}

__dotenv_has_active_name() {
  local __dotenv__name=$1 __dotenv__active_name

  for __dotenv__active_name in "${__dotenv_active_names[@]}"; do
    [[ $__dotenv__active_name == "$__dotenv__name" ]] && return 0
  done
  return 1
}

__dotenv_unload() {
  local __dotenv__index __dotenv__name

  for ((__dotenv__index = 0; __dotenv__index < ${#__dotenv_active_names[@]}; __dotenv__index++)); do
    __dotenv__name=${__dotenv_active_names[__dotenv__index]}
    unset "$__dotenv__name"
    if [[ ${__dotenv_active_had_values[__dotenv__index]} == 1 ]]; then
      printf -v "$__dotenv__name" '%s' "${__dotenv_active_values[__dotenv__index]}"
      if [[ ${__dotenv_active_exported[__dotenv__index]} == 1 ]]; then
        export "${__dotenv__name?}"
      else
        export -n "${__dotenv__name?}"
      fi
    fi
  done

  __dotenv_active_file=
  __dotenv_active_signature=
  __dotenv_active_names=()
  __dotenv_active_values=()
  __dotenv_active_had_values=()
  __dotenv_active_exported=()
}

__dotenv_expand() {
  local __dotenv__input=$1 __dotenv__output='' __dotenv__character __dotenv__name __dotenv__rest

  while [[ -n $__dotenv__input ]]; do
    __dotenv__character=${__dotenv__input:0:1}
    __dotenv__input=${__dotenv__input:1}
    if [[ $__dotenv__character != '$' ]]; then
      __dotenv__output+=$__dotenv__character
      continue
    fi

    if [[ $__dotenv__input == \{* ]]; then
      __dotenv__rest=${__dotenv__input:1}
      if [[ $__dotenv__rest == *\}* ]]; then
        __dotenv__name=${__dotenv__rest%%\}*}
        if [[ $__dotenv__name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
          __dotenv__output+=${!__dotenv__name}
          __dotenv__input=${__dotenv__rest#*\}}
          continue
        fi
      fi
    elif [[ $__dotenv__input =~ ^([A-Za-z_][A-Za-z0-9_]*) ]]; then
      __dotenv__name=${BASH_REMATCH[1]}
      __dotenv__output+=${!__dotenv__name}
      __dotenv__input=${__dotenv__input:${#__dotenv__name}}
      continue
    fi

    __dotenv__output+='$'
  done

  printf '%s' "$__dotenv__output"
}

__dotenv_load() {
  local __dotenv__file=$1 __dotenv__signature=$2
  local __dotenv__line __dotenv__key __dotenv__value __dotenv__expand_value
  local __dotenv__declaration __dotenv__old_value __dotenv__line_number=0 __dotenv__was_exported

  while IFS= read -r __dotenv__line || [[ -n $__dotenv__line ]]; do
    ((__dotenv__line_number++))
    __dotenv__line=${__dotenv__line%$'\r'}
    __dotenv__line="${__dotenv__line#"${__dotenv__line%%[![:space:]]*}"}"
    [[ -z $__dotenv__line || $__dotenv__line == \#* ]] && continue

    if [[ $__dotenv__line == export[[:space:]]* ]]; then
      __dotenv__line=${__dotenv__line#export}
      __dotenv__line="${__dotenv__line#"${__dotenv__line%%[![:space:]]*}"}"
    fi
    if [[ $__dotenv__line != *=* ]]; then
      printf 'envload: %s:%d: expected KEY=value\n' "$__dotenv__file" "$__dotenv__line_number" >&2
      continue
    fi

    __dotenv__key=${__dotenv__line%%=*}
    __dotenv__key="${__dotenv__key%"${__dotenv__key##*[![:space:]]}"}"
    __dotenv__value=${__dotenv__line#*=}
    __dotenv__value="${__dotenv__value#"${__dotenv__value%%[![:space:]]*}"}"
    __dotenv__value="${__dotenv__value%"${__dotenv__value##*[![:space:]]}"}"

    if [[ ! $__dotenv__key =~ ^[A-Za-z_][A-Za-z0-9_]*$ || $__dotenv__key == __dotenv_* ]]; then
      printf 'envload: %s:%d: invalid or reserved variable name %q\n' "$__dotenv__file" "$__dotenv__line_number" "$__dotenv__key" >&2
      continue
    fi

    __dotenv__expand_value=1
    case $__dotenv__value in
    \"*)
      if [[ $__dotenv__value =~ ^\"(.*)\"([[:space:]]*\#.*)?$ ]]; then
        __dotenv__value=${BASH_REMATCH[1]}
      else
        printf 'envload: %s:%d: unterminated double-quoted value\n' "$__dotenv__file" "$__dotenv__line_number" >&2
        continue
      fi
      ;;
    \'*)
      if [[ $__dotenv__value =~ ^\'(.*)\'([[:space:]]*\#.*)?$ ]]; then
        __dotenv__value=${BASH_REMATCH[1]}
        __dotenv__expand_value=0
      else
        printf 'envload: %s:%d: unterminated single-quoted value\n' "$__dotenv__file" "$__dotenv__line_number" >&2
        continue
      fi
      ;;
    *)
      __dotenv__value=${__dotenv__value%%[[:space:]]\#*}
      __dotenv__value="${__dotenv__value%"${__dotenv__value##*[![:space:]]}"}"
      ;;
    esac
    [[ $__dotenv__expand_value == 1 ]] && __dotenv__value=$(__dotenv_expand "$__dotenv__value")

    __dotenv_has_active_name "$__dotenv__key" && continue
    __dotenv__declaration=$(declare -p "$__dotenv__key" 2>/dev/null)
    if [[ $__dotenv__declaration =~ ^declare\ -[^[:space:]]*r ]]; then
      printf 'envload: %s:%d: refusing to replace readonly %s\n' "$__dotenv__file" "$__dotenv__line_number" "$__dotenv__key" >&2
      continue
    fi

    __dotenv__old_value=${!__dotenv__key}
    __dotenv__was_exported=0
    [[ $__dotenv__declaration =~ ^declare\ -[^[:space:]]*x ]] && __dotenv__was_exported=1
    if ! export "$__dotenv__key=$__dotenv__value"; then
      printf 'envload: %s:%d: could not set %s\n' "$__dotenv__file" "$__dotenv__line_number" "$__dotenv__key" >&2
      continue
    fi

    __dotenv_active_names+=("$__dotenv__key")
    if [[ -n $__dotenv__declaration ]]; then
      __dotenv_active_values+=("$__dotenv__old_value")
      __dotenv_active_had_values+=(1)
      __dotenv_active_exported+=("$__dotenv__was_exported")
    else
      __dotenv_active_values+=("")
      __dotenv_active_had_values+=(0)
      __dotenv_active_exported+=(0)
    fi
  done < "$__dotenv__file"

  __dotenv_active_file=$__dotenv__file
  __dotenv_active_signature=$__dotenv__signature
  printf 'envload: loaded %s\n' "$__dotenv__file"
}

__dotenv_update() {
  local __dotenv__force=${1:-} __dotenv__signature

  if [[ -z $__dotenv__force && $__dotenv_last_pwd == "$PWD" ]]; then
    return
  fi
  __dotenv_last_pwd=$PWD

  __dotenv_find
  if [[ -n $__dotenv_found_file ]]; then
    __dotenv__signature=$(__dotenv_signature "$__dotenv_found_file")
  fi

  if [[ -z $__dotenv__force && $__dotenv_found_file == "$__dotenv_active_file" && $__dotenv__signature == "$__dotenv_active_signature" ]]; then
    return
  fi

  [[ -n $__dotenv_active_file ]] && __dotenv_unload
  [[ -n $__dotenv_found_file ]] && __dotenv_load "$__dotenv_found_file" "$__dotenv__signature"
}

envload() {
  case ${1:-status} in
  reload) __dotenv_update force ;;
  status)
    if [[ -n $__dotenv_active_file ]]; then
      printf 'envload: %s\n' "$__dotenv_active_file"
    else
      printf 'envload: no active .env\n'
    fi
    ;;
  *)
    printf 'usage: envload [status|reload]\n' >&2
    return 2
    ;;
  esac
}
