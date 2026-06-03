#!/bin/bash
# Resolve the PRIVATE custom deployment URL for a branch.
#
# The branch name and its derived <name>-<hash> segment are public (anyone can
# recompute them from the repo). The subdomain and domain are SECRET — they live
# only in the GitHub secrets CUSTOM_SUBDOMAIN / CUSTOM_DOMAIN_NAME and must never
# be committed or printed in public CI (GitHub masks secrets in logs but NOT in
# job summaries). This script assembles the full URL locally, on your machine,
# from secrets you supply out-of-band.
#
# Provide the secret parts via environment variables, or an untracked file
# `.deploy.local` at the repo root (git-ignored) of the form:
#
#     CUSTOM_SUBDOMAIN=app
#     CUSTOM_DOMAIN_NAME=example.com
#
# Usage:
#   ./.github/scripts/branch-url.sh             # current branch
#   ./.github/scripts/branch-url.sh my-branch   # a specific branch
#   ./.github/scripts/branch-url.sh --sanitized my-branch  # just <name>-<hash>
#
# Alternative (no local secret needed) — ask Azure for the bound hostname:
#   az containerapp show -g rg-production \
#     -n "ca-web-$(./.github/scripts/branch-url.sh --sanitized my-branch)" \
#     --query "properties.configuration.ingress.customDomains[].name" -o tsv

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || pwd)"

# Load untracked local secrets if present.
if [ -f "$REPO_ROOT/.deploy.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.deploy.local"
  set +a
fi

SANITIZED_ONLY=false
if [ "${1:-}" = "--sanitized" ]; then
  SANITIZED_ONLY=true
  shift
fi

BRANCH="${1:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"
SANITIZED="$("$SCRIPT_DIR/sanitize-branch-name.sh" "$BRANCH")"

if [ "$SANITIZED_ONLY" = true ]; then
  echo "$SANITIZED"
  exit 0
fi

if [ -z "${CUSTOM_SUBDOMAIN:-}" ] || [ -z "${CUSTOM_DOMAIN_NAME:-}" ]; then
  echo "error: CUSTOM_SUBDOMAIN and CUSTOM_DOMAIN_NAME must be set (env vars or .deploy.local)." >&2
  echo "       These are secret; never commit them. See the header of this script." >&2
  exit 1
fi

# main deploys to the apex subdomain (no branch suffix); branches get the suffix.
if [ "$BRANCH" = "main" ]; then
  HOST="${CUSTOM_SUBDOMAIN}.${CUSTOM_DOMAIN_NAME}"
else
  HOST="${CUSTOM_SUBDOMAIN}-${SANITIZED}.${CUSTOM_DOMAIN_NAME}"
fi

echo "https://${HOST}"
