#!/bin/bash
# Sanitize branch name for Azure resource naming
# Usage: ./sanitize-branch-name.sh "feature/my-branch"
# Output: feature-my-branch-a1b2
#
# Rules:
# - Lowercase
# - Replace / with -
# - Remove special characters (keep only a-z, 0-9, -)
# - Readable name truncated to 20 characters (trailing dashes trimmed)
# - A 4-char hash of the FULL, original branch name is appended as
#   "<name>-<hash>" so distinct branches that share the same truncated
#   20-char prefix never collide. This matters because azd keys its
#   deployment state on the env name; two long branches collapsing to the
#   same truncated string would otherwise clobber each other's state.
# - Total length <= 25 chars, keeping the derived Azure Container App name
#   ("ca-web-<output>") within the 32-char limit.
#
# NOTE: The hash is deterministic, so cleanup-orphans.yml can still re-run
# this script per live branch and match the result against an existing
# container app's name suffix.

BRANCH_NAME="$1"

if [ -z "$BRANCH_NAME" ]; then
  echo "Usage: $0 <branch-name>" >&2
  exit 1
fi

# 4-char hash of the full, original branch name (pre-sanitization) so that
# long branches sharing a truncated prefix still produce distinct names.
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(printf '%s' "$BRANCH_NAME" | sha256sum | cut -c1-4)
else
  HASH=$(printf '%s' "$BRANCH_NAME" | shasum -a 256 | cut -c1-4)
fi

# Readable, DNS-safe name: lowercase, slashes -> dashes, strip other chars,
# cap at 20 chars, then trim any trailing dash so we never emit "name--hash"
# or a trailing-dash (both invalid Azure resource names).
NAME=$(echo "$BRANCH_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[\/]/-/g' | sed 's/[^a-z0-9-]//g' | cut -c1-20 | sed 's/-*$//')

if [ -z "$NAME" ]; then
  # Degenerate branch names (all special chars) collapse to just the hash.
  echo "$HASH"
else
  echo "${NAME}-${HASH}"
fi
