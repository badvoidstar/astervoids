#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW_SOURCE=$(tr -d '\r' < "$SCRIPT_DIR/../workflows/check-easy-auth-secret.yml")

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -Fxq '  EASYAUTH_APP_ID: ${{ secrets.EASYAUTH_APP_ID }}' <<< "$WORKFLOW_SOURCE" \
  || fail "monitor must source the app ID from a masked secret"
grep -Fxq '    environment: production' <<< "$WORKFLOW_SOURCE" \
  || fail "monitor must use the existing production OIDC federation"
if grep -Eq 'vars\.EASYAUTH_APP_ID|gh variable set EASYAUTH_APP_ID' <<< "$WORKFLOW_SOURCE"; then
  fail "monitor must not use an unmasked app-ID variable"
fi
[ "$(grep -c "if: env.EASYAUTH_APP_ID" <<< "$WORKFLOW_SOURCE")" -eq 6 ] \
  || fail "all configuration gates must use the secret-backed environment"
if grep -E 'echo.*\$EASYAUTH_APP_ID' <<< "$WORKFLOW_SOURCE"; then
  fail "monitor must not print the app ID"
fi

COMPUTE=$(awk '
  /- name: Compute days until secret expires/ { found=1; next }
  found && /        run: \|/ { script=1; next }
  script && /^      - name:/ { exit }
  script { sub(/^          /, ""); print }
' <<< "$WORKFLOW_SOURCE")
[ -n "$COMPUTE" ] || fail "credential-check script must be extracted"

# Exercise the production script with metadata only, without Azure or file output.
az() {
  case "$MOCK_MODE" in
    success)
      date -u -d '+45 days' +%Y-%m-%dT%H:%M:%SZ
      date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ
      ;;
    empty) return 0 ;;
    denied)
      echo "private-auth-error-sentinel" >&2
      return 1
      ;;
  esac
}
export -f az
export EASYAUTH_APP_ID=private-app-id-sentinel GITHUB_OUTPUT=/dev/null

OUTPUT=$(MOCK_MODE=success bash -c "$COMPUTE")
grep -Eq 'Days until expiration: (89|90)$' <<< "$OUTPUT" \
  || fail "monitor must continue selecting the latest credential"
for mode in empty denied; do
  if OUTPUT=$(MOCK_MODE="$mode" bash -c "$COMPUTE" 2>&1); then
    fail "$mode metadata lookup must fail, not pass as a successful check"
  fi
  grep -Fq '::error::' <<< "$OUTPUT" || fail "$mode lookup must report failure"
  if grep -Eq 'private-app-id-sentinel|private-auth-error-sentinel' <<< "$OUTPUT"; then
    fail "$mode lookup must not leak identifiers or raw Azure errors"
  fi
done

echo "Easy Auth monitor tests passed"
