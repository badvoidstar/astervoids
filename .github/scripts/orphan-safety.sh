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
