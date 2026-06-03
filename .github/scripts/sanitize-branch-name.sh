#!/bin/bash
# Sanitize branch name for Azure resource naming
# Usage: ./sanitize-branch-name.sh "feature/my-branch"
# Output: feature-my-branch          (short names: emitted verbatim, no hash)
#         a-very-long-branch-na-a1b2  (long names: truncated + 4-char hash)
#
# Rules:
# - Lowercase
# - Replace / with -
# - Remove special characters (keep only a-z, 0-9, -)
# - Trim trailing dashes
# - If the sanitized name already fits the Azure budget (<= 25 chars, so the
#   derived "ca-web-<output>" stays within the 32-char Container App limit),
#   it is emitted verbatim with NO hash.
# - Only when it exceeds 25 chars is it truncated to 20 chars (trailing dash
#   trimmed) and a 4-char hash of the FULL, original branch name appended as
#   "<name>-<hash>", so distinct long branches that share the same truncated
#   20-char prefix never collide (azd keys deployment state on the env name,
#   so two long branches collapsing to the same string would clobber state).
#
# NOTE: The hash is deterministic, so cleanup-orphans.yml can re-run this
# script per live branch and match the result against an existing container
# app's name suffix.

BRANCH_NAME="$1"

if [ -z "$BRANCH_NAME" ]; then
  echo "Usage: $0 <branch-name>" >&2
  exit 1
fi

# Max output length that keeps "ca-web-<output>" within Azure's 32-char
# Container App name limit (7 + 25 = 32).
MAX_LEN=25

# Sanitized, DNS-safe name: lowercase, slashes -> dashes, strip other chars,
# then trim any trailing dash. Not length-capped yet.
FULL=$(echo "$BRANCH_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[\/]/-/g' | sed 's/[^a-z0-9-]//g' | sed 's/-*$//')

# Short, already-safe branch names are emitted verbatim with NO hash.
if [ -n "$FULL" ] && [ "${#FULL}" -le "$MAX_LEN" ]; then
  echo "$FULL"
  exit 0
fi

# Too long (or degenerate): truncate to 20 chars and append a 4-char hash of
# the FULL, original branch name so distinct long branches that share the same
# truncated prefix never collide. 20 + "-" + 4 = 25.
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(printf '%s' "$BRANCH_NAME" | sha256sum | cut -c1-4)
else
  HASH=$(printf '%s' "$BRANCH_NAME" | shasum -a 256 | cut -c1-4)
fi

NAME=$(printf '%s' "$FULL" | cut -c1-20 | sed 's/-*$//')

if [ -z "$NAME" ]; then
  # Degenerate branch names (all special chars) collapse to just the hash.
  echo "$HASH"
else
  echo "${NAME}-${HASH}"
fi
