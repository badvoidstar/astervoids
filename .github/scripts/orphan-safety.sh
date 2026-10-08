#!/bin/bash

is_protected_deployment_suffix() {
  local suffix="$1"
  local active_suffixes="${2-}"
  local active

  case "$suffix" in
    production|production-*)
      return 0
      ;;
  esac

  for active in $active_suffixes; do
    if [ "$suffix" = "$active" ]; then
      return 0
    fi
  done
  return 1
}

# The cleanup runner uses the same predicate as shell workflow helpers.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -ne 2 ]; then
    echo "Usage: orphan-safety.sh <suffix> <active-suffixes>" >&2
    exit 2
  fi
  if is_protected_deployment_suffix "$1" "$2"; then
    echo protected
  else
    echo orphan
  fi
fi
