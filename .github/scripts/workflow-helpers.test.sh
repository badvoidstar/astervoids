#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/deployment-helpers.sh"
. "$SCRIPT_DIR/orphan-safety.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

is_protected_deployment_suffix production "" || fail "production must be protected"
is_protected_deployment_suffix production-westus "" || fail "regional production must be protected"
is_protected_deployment_suffix feature-a "feature-a feature-b" || fail "active suffix must be protected"
if is_protected_deployment_suffix orphan "feature-a feature-b"; then
  fail "unknown suffix must not be protected"
fi

AZD_VALUES=$(printf 'FOO="bar=baz"\nEMPTY=""\nPLAIN=value\n')
assert_equal "$(azd_env_value FOO "$AZD_VALUES")" "bar=baz"
assert_equal "$(azd_env_value EMPTY "$AZD_VALUES")" ""
assert_equal "$(azd_env_value PLAIN "$AZD_VALUES")" "value"
assert_equal "$(azd_env_value MISSING "$AZD_VALUES")" ""
assert_equal "$(require_azd_env_value PLAIN "$AZD_VALUES")" "value"
if require_azd_env_value MISSING "$AZD_VALUES" >/dev/null 2>&1; then
  fail "required missing azd value must fail"
fi
if require_azd_env_value EMPTY "$AZD_VALUES" >/dev/null 2>&1; then
  fail "required empty azd value must fail"
fi

OUTPUTS='{"azurE_CONTAINER_REGISTRY_NAME":{"value":"registry"},"regions":{"value":["west","east"]}}'
assert_equal "$(deployment_output "$OUTPUTS" AZURE_CONTAINER_REGISTRY_NAME)" "registry"
assert_equal "$(deployment_output_json "$OUTPUTS" REGIONS)" '["west","east"]'

echo "Workflow helper tests passed"
