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

AZD_VALUES='{"FOO":"bar=baz","EMPTY":"","PLAIN":"value","ESCAPED":"quotes \"and\" backslash \\"}'
assert_equal "$(azd_env_value FOO "$AZD_VALUES")" "bar=baz"
assert_equal "$(azd_env_value EMPTY "$AZD_VALUES")" ""
assert_equal "$(azd_env_value PLAIN "$AZD_VALUES")" "value"
assert_equal "$(azd_env_value ESCAPED "$AZD_VALUES")" 'quotes "and" backslash \'
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

REGIONS='[{"name":"north","location":"northeurope","displayName":"Europe"},{"name":"west","location":"westus2","displayName":"US West"}]'
assert_equal "$(normalize_deployment_regions '')" '[]'
assert_equal "$(normalize_deployment_regions '[]')" '[]'
assert_equal "$(normalize_deployment_regions "$REGIONS")" "$REGIONS"
for invalid in 'invalid' '{}' 'null' '"north"' '[{"name":"north"}]'; do
  assert_equal "$(normalize_deployment_regions "$invalid" 2>/dev/null)" '[]'
done
assert_equal "$(deployment_mode true '[]')" single-region
assert_equal "$(deployment_mode true "$REGIONS")" multi-region
assert_equal "$(deployment_mode false "$REGIONS")" branch
assert_equal "$(shared_container_environment '[]' cae-production)" cae-production
assert_equal "$(shared_container_environment "$REGIONS" cae-production)" cae-production-north

# The CLI mocks record argument arrays across command-substitution subshells.
# All artifacts stay under this checkout and are removed even on test failure.
cd "$SCRIPT_DIR/../.."
TEST_DIR=".workflow-helper-tests-$$"
mkdir "$TEST_DIR"
trap 'rm -rf "$TEST_DIR"' EXIT
CALL_LOG="$TEST_DIR/calls.jsonl"

record_call() {
  jq -cn --args '$ARGS.positional' -- "$@" >> "$CALL_LOG"
}

call_count() {
  jq -s --args '$ARGS.positional as $prefix |
    map(select(.[0:($prefix | length)] == $prefix)) | length' -- "$@" < "$CALL_LOG"
}

assert_calls() {
  local count="$1"
  shift
  assert_equal "$(call_count "$@")" "$count"
}

assert_call_argument() {
  local argument="$1"
  shift
  jq -se --arg argument "$argument" --args '$ARGS.positional as $prefix |
    any(.[]; .[0:($prefix | length)] == $prefix and index($argument) != null)' \
    -- "$@" < "$CALL_LOG" >/dev/null || fail "missing argument '$argument' in $*"
}

has_argument() {
  local expected="$1" argument
  shift
  for argument in "$@"; do
    [ "$argument" != "$expected" ] || return 0
  done
  return 1
}

azd() {
  record_call azd "$@"
  case "$1 ${2:-}" in
    'env get-values')
      [ "$AZD_READ_RC" -eq 0 ] || return "$AZD_READ_RC"
      if [ "${3:-} ${4:-}" = '--output json' ]; then
        printf '%s\n' "$MOCK_AZD_VALUES"
      else
        # Real default output is dotenv, with embedded JSON quotes escaped.
        jq -r 'to_entries[] | "\(.key)=\(.value | @json)"' <<< "$MOCK_AZD_VALUES"
      fi
      ;;
    'up --no-prompt') return "$AZD_UP_RC" ;;
    'provision --no-prompt') return "$AZD_PROVISION_RC" ;;
    *) fail "Unexpected azd call: $*" ;;
  esac
}

az() {
  record_call az "$@"
  case "$1 ${2:-} ${3:-}" in
    'deployment sub create')
      if [ "$(call_count az deployment sub create)" -le "$BICEP_FAILURES" ]; then return 42; fi
      ;;
    'deployment sub show') printf '%s\n' "$ARM_OUTPUTS" ;;
    'containerapp show --name')
      if has_argument properties.customDomainVerificationId "$@"; then
        if has_argument "$VERIFICATION_SOURCE" "$@"; then printf '%s\n' "$EXISTING_VERIFICATION_ID"; fi
      elif [ "$APP_STATE" = missing ] || {
        [ "$APP_STATE" = after-bicep ] && [ "$(call_count az deployment sub create)" -eq 0 ];
      }; then
        return 1
      fi
      ;;
    'containerapp env show')
      [ "$CAE_EXISTS" = true ] || return 1
      if has_argument location "$@"; then
        printf 'northeurope\n'
      elif has_argument properties.customDomainConfiguration.customDomainVerificationId "$@"; then
        if has_argument "$VERIFICATION_SOURCE" "$@"; then
          printf '%s\n' "$EXISTING_VERIFICATION_ID"
        elif [ "$(call_count az deployment sub create)" -gt 0 ]; then
          printf '%s\n' "$RETRY_VERIFICATION_ID"
        fi
      fi
      ;;
    'containerapp env identity') return "$IDENTITY_RC" ;;
    'containerapp env certificate')
      [ "$CERT_LIST_RC" -eq 0 ] || return "$CERT_LIST_RC"
      printf '%s\n' "$EXISTING_CERT"
      ;;
    'containerapp update --name')
      if [ "$(call_count az containerapp update)" -eq "$UPDATE_FAILURE_AT" ]; then return 43; fi
      ;;
    'acr login --name') return "$ACR_LOGIN_RC" ;;
    'rest --method PUT') return "$CERT_PUT_RC" ;;
    *) fail "Unexpected az call: $*" ;;
  esac
}

docker() {
  record_call docker "$@"
  case "$1" in
    build) return "$DOCKER_BUILD_RC" ;;
    push) return "$DOCKER_PUSH_RC" ;;
    *) fail "Unexpected docker call: $*" ;;
  esac
}

declare -A deployment=() outputs=()
reset_deployment() {
  : > "$CALL_LOG"
  AZD_READ_RC=0 AZD_UP_RC=0 AZD_PROVISION_RC=0 BICEP_FAILURES=0 UPDATE_FAILURE_AT=0
  ACR_LOGIN_RC=0 DOCKER_BUILD_RC=0 DOCKER_PUSH_RC=0
  APP_STATE=present CAE_EXISTS=true EXISTING_CERT='' IDENTITY_RC=0 CERT_LIST_RC=0 CERT_PUT_RC=0
  VERIFICATION_SOURCE=ca-web-production-north EXISTING_VERIFICATION_ID=existing-verification RETRY_VERIFICATION_ID=''
  MOCK_AZD_VALUES=$(jq -cn --arg regions "$REGIONS" '{
    AZURE_ENV_NAME: "production",
    AZURE_LOCATION: "westus2",
    REGIONS_JSON: $regions,
    USE_SHARED_INFRA: "false",
    CUSTOM_DOMAIN_NAME: "example.com",
    CUSTOM_SUBDOMAIN: "app",
    CERT_KEY_VAULT_SECRET_URL: "https://example.vault.azure.net/secrets/wildcard-example-com",
    CERT_KEY_VAULT_CERT_NAME: "wildcard-example-com",
    CERT_READER_IDENTITY_ID: "",
    DOMAIN_VERIFICATION_ID: "seeded-verification",
    WEB_URI: "https://primary.azurecontainerapps.io",
    CONTAINER_APP_NAME: "ca-web-production",
    CONTAINER_APPS_ENVIRONMENT: "cae-production",
    RESOURCE_GROUP: "rg-production",
    CUSTOM_DOMAIN: "app.example.com",
    AZURE_CONTAINER_REGISTRY_NAME: "registry",
    AZURE_CONTAINER_REGISTRY_ENDPOINT: "registry.azurecr.io"
  }')
  ARM_OUTPUTS='{
    "weB_URI":{"value":"https://app.example.com"},
    "containeR_APP_NAME":{"value":"ca-web-production-north"},
    "containeR_APPS_ENVIRONMENT":{"value":"cae-production-north"},
    "resourcE_GROUP":{"value":"rg-production"},
    "custoM_DOMAIN":{"value":"app.example.com"},
    "azurE_CONTAINER_REGISTRY_NAME":{"value":"armregistry"},
    "azurE_CONTAINER_REGISTRY_ENDPOINT":{"value":"armregistry.azurecr.io"},
    "statiC_WEB_APP_NAME":{"value":"swa-app-private"},
    "statiC_WEB_APP_DEFAULT_HOSTNAME":{"value":"public.azurestaticapps.net"},
    "regioN_ENDPOINTS":{"value":[{"id":"north","displayName":"Europe","containerAppName":"ca-web-production-north","fqdn":"north.azurecontainerapps.io","customDomain":"app-north.example.com"}]},
    "statiC_APEX_REGION_MANIFEST":{"value":[{"id":"north","displayName":"Europe","apiBaseUrl":"https://app-north.example.com"}]}
  }'
  deployment=(
    [runId]=123 [imageTag]=test-sha [resourceGroup]=rg-production
    [appPrefix]=ca-web [environmentPrefix]=cae-production [staticDir]="$TEST_DIR/static"
  )
  outputs=()
  rm -rf "$TEST_DIR/static"
  load_deployment_settings deployment
}

branch_settings() {
  deployment[environmentName]=feature-login
  deployment[useSharedInfra]=true
  deployment[customSubdomain]=app-feature-login
  deployment[certReaderIdentityId]=example-identity
  MOCK_AZD_VALUES="${MOCK_AZD_VALUES//ca-web-production/ca-web-feature-login}"
}

expect_failure() {
  local expected="$1" actual=0
  shift
  "$@" >/dev/null 2>&1 || actual=$?
  assert_equal "$actual" "$expected"
}

reset_deployment
assert_calls 1 azd env get-values --output json
assert_equal "${deployment[regions]}" "$REGIONS"
assert_equal "$(deployment_mode true "${deployment[regions]}")" multi-region
DOTENV_VALUES=$(azd env get-values)
grep -Fq 'REGIONS_JSON="[{\"name\":\"north\"' <<< "$DOTENV_VALUES" || fail "dotenv fixture must escape JSON"
assert_equal "$(azd_env_value REGIONS_JSON)" "$REGIONS"
assert_equal "$(azd_env_value CERT_KEY_VAULT_SECRET_URL)" https://example.vault.azure.net/secrets/wildcard-example-com
QUOTED_REGIONS='[{"name":"north","location":"northeurope","displayName":"Europe \"North\""}]'
MOCK_AZD_VALUES=$(jq --arg regions "$QUOTED_REGIONS" '.REGIONS_JSON = $regions' <<< "$MOCK_AZD_VALUES")
load_deployment_settings deployment
assert_equal "${deployment[regions]}" "$QUOTED_REGIONS"
assert_equal "$(deployment_mode true "${deployment[regions]}")" multi-region

reset_deployment
AZD_READ_RC=7
expect_failure 7 load_deployment_settings deployment
MOCK_AZD_VALUES=''
AZD_READ_RC=0
expect_failure 1 load_deployment_settings deployment

reset_deployment
deploy_single_region_production deployment outputs
assert_calls 1 azd up --no-prompt
assert_calls 0 az
assert_equal "${outputs[WEB_URI]}" https://primary.azurecontainerapps.io
assert_equal "${outputs[IS_MULTI_REGION]}" false
write_deployment_outputs outputs "$TEST_DIR/single-public" "$TEST_DIR/single-private"
grep -qx 'url=https://primary.azurecontainerapps.io' "$TEST_DIR/single-public" || fail "single-region default URL missing"
AZD_UP_RC=9
expect_failure 9 deploy_single_region_production deployment outputs
assert_calls 2 azd env get-values
AZD_UP_RC=0
MOCK_AZD_VALUES=$(jq 'del(.WEB_URI)' <<< "$MOCK_AZD_VALUES")
expect_failure 1 deploy_single_region_production deployment outputs

reset_deployment
deploy_multi_region_production deployment outputs
assert_calls 1 az deployment sub create
assert_calls 1 az deployment sub show
assert_calls 1 docker build
assert_calls 1 docker push
assert_calls 2 az containerapp update
assert_call_argument environmentName=production az deployment sub create
assert_call_argument location=northeurope az deployment sub create
assert_call_argument useSharedInfra=false az deployment sub create
assert_call_argument "regions=$REGIONS" az deployment sub create
assert_call_argument certReaderIdentityId= az deployment sub create
assert_call_argument domainVerificationId=existing-verification az deployment sub create
assert_call_argument ca-web-production-north az containerapp update
assert_call_argument ca-web-production-west az containerapp update
assert_call_argument armregistry.azurecr.io/astervoids-web:test-sha az containerapp update
assert_equal "${outputs[IS_MULTI_REGION]}" true
assert_equal "${outputs[CONTAINER_APPS_ENVIRONMENT]}" cae-production-north
cmp AstervoidsWeb/wwwroot/index.html "$TEST_DIR/static/index.html" || fail "static shell not copied"
BOOTSTRAP=$(sed 's/^window.ASTERVOIDS_REGION_BOOTSTRAP = //; s/;$//' "$TEST_DIR/static/region-bootstrap.js")
assert_equal "$(jq -c '.regions' <<< "$BOOTSTRAP")" "${outputs[STATIC_APEX_REGION_MANIFEST]}"
assert_equal "$(jq '.regionId, .displayName' <<< "$BOOTSTRAP")" $'null\nnull'

write_deployment_outputs outputs "$TEST_DIR/public" "$TEST_DIR/private"
assert_equal "${outputs[WEB_URI]}" https://app.example.com
grep -qx 'url=https://public.azurestaticapps.net' "$TEST_DIR/public" || fail "default static URL missing"
grep -qx 'STATIC_WEB_APP_NAME=swa-app-private' "$TEST_DIR/private" || fail "private SWA state missing"
grep -qx 'CUSTOM_DOMAIN=app.example.com' "$TEST_DIR/private" || fail "private domain missing"
if grep -Eq 'example.com|swa-app-private|STATIC_WEB_APP_NAME|static_web_app_name|apiBaseUrl' "$TEST_DIR/public"; then
  fail "custom-domain data leaked into public outputs"
fi
outputs[STATIC_WEB_APP_DEFAULT_HOSTNAME]=''
expect_failure 1 write_deployment_outputs outputs "$TEST_DIR/rejected" "$TEST_DIR/rejected-env"
test ! -e "$TEST_DIR/rejected" || fail "unsafe URL was written"
outputs[WEB_URI]=https://north.azurecontainerapps.io
outputs[STATIC_WEB_APP_DEFAULT_HOSTNAME]=app.example.com
expect_failure 1 write_deployment_outputs outputs "$TEST_DIR/rejected" "$TEST_DIR/rejected-env"
test ! -e "$TEST_DIR/rejected" || fail "unsafe static hostname was written"

for source in ca-web-production cae-production-north cae-production; do
  reset_deployment
  VERIFICATION_SOURCE="$source"
  deploy_multi_region_production deployment outputs >/dev/null
  assert_call_argument domainVerificationId=existing-verification az deployment sub create
done

reset_deployment
EXISTING_VERIFICATION_ID='' RETRY_VERIFICATION_ID=retry-verification BICEP_FAILURES=1
deploy_multi_region_production deployment outputs
assert_calls 2 az deployment sub create
assert_call_argument domainVerificationId= az deployment sub create
assert_call_argument domainVerificationId=retry-verification az deployment sub create
# The retry must change only the verification token, not any other IaC input.
assert_equal "$(jq -sc '[.[] | select(.[0:4] == ["az","deployment","sub","create"]) |
  map(select(startswith("domainVerificationId=") | not))] | .[0] == .[1]' "$CALL_LOG")" true

for failure_case in existing-token no-retry-token retry-fails no-domain; do
  reset_deployment
  BICEP_FAILURES=2
  case "$failure_case" in
    existing-token) ;;
    no-retry-token) EXISTING_VERIFICATION_ID='' ;;
    retry-fails) EXISTING_VERIFICATION_ID='' RETRY_VERIFICATION_ID=retry-verification ;;
    no-domain) EXISTING_VERIFICATION_ID=''; deployment[customDomainName]='' ;;
  esac
  expect_failure 42 deploy_multi_region_production deployment outputs
  if [ "$failure_case" = retry-fails ]; then assert_calls 2 az deployment sub create
  else assert_calls 1 az deployment sub create; fi
  assert_calls 0 docker
done

for missing in certKeyVaultSecretUrl certKeyVaultCertName; do
  reset_deployment
  deployment[$missing]=''
  expect_failure 2 deploy_multi_region_production deployment outputs
  assert_calls 0 az deployment
done

reset_deployment
deployment[customDomainName]='' deployment[customSubdomain]=''
deployment[certKeyVaultSecretUrl]='' deployment[certKeyVaultCertName]=''
ARM_OUTPUTS=$(jq '.weB_URI.value = "https://north.azurecontainerapps.io" |
  del(.statiC_WEB_APP_NAME, .statiC_WEB_APP_DEFAULT_HOSTNAME,
  .statiC_APEX_REGION_MANIFEST, .custoM_DOMAIN)' <<< "$ARM_OUTPUTS")
deploy_multi_region_production deployment outputs >/dev/null
assert_equal "${outputs[STATIC_WEB_APP_NAME]}" ''
assert_equal "${outputs[STATIC_APEX_REGION_MANIFEST]}" '[]'
write_deployment_outputs outputs "$TEST_DIR/regional-public" "$TEST_DIR/regional-private"
grep -qx 'url=https://north.azurecontainerapps.io' "$TEST_DIR/regional-public" || fail "regional default URL missing"

for failure_case in acr build push update missing-registry; do
  reset_deployment
  expected=8
  case "$failure_case" in
    acr) ACR_LOGIN_RC=8 ;;
    build) DOCKER_BUILD_RC=8 ;;
    push) DOCKER_PUSH_RC=8 ;;
    update) UPDATE_FAILURE_AT=1; expected=43 ;;
    missing-registry) ARM_OUTPUTS=$(jq 'del(.azurE_CONTAINER_REGISTRY_NAME)' <<< "$ARM_OUTPUTS"); expected=2 ;;
  esac
  expect_failure "$expected" deploy_multi_region_production deployment outputs
  if [ "$failure_case" = update ]; then assert_calls 1 az containerapp update
  else assert_calls 0 az containerapp update; fi
  if [ "$failure_case" = build ] || [ "$failure_case" = acr ]; then assert_calls 0 docker push; fi
  test ! -d "$TEST_DIR/static" || fail "static payload prepared after failed deployment"
done

for regions in '[]' "$REGIONS"; do
  reset_deployment
  branch_settings
  deployment[regions]="$regions"
  deploy_shared_infra_branch deployment outputs
  assert_calls 1 azd provision --no-prompt
  assert_calls 0 az deployment sub create
  assert_calls 1 docker build
  assert_calls 1 az containerapp update
  assert_call_argument ca-web-feature-login az containerapp update
  assert_equal "${outputs[IS_MULTI_REGION]}" false
done

reset_deployment
branch_settings
APP_STATE=after-bicep
ARM_OUTPUTS=$(jq '.weB_URI.value="https://preview.azurecontainerapps.io" |
  .containeR_APP_NAME.value="ca-web-feature-login" |
  .custoM_DOMAIN.value="app-feature-login.example.com"' <<< "$ARM_OUTPUTS")
deploy_shared_infra_branch deployment outputs
assert_calls 1 az deployment sub create
assert_calls 2 az containerapp show
assert_call_argument fallback-feature-login-123 az deployment sub create
assert_call_argument environmentName=feature-login az deployment sub create
assert_call_argument useSharedInfra=true az deployment sub create
assert_call_argument location=westus2 az deployment sub create
assert_call_argument customSubdomain=app-feature-login az deployment sub create
assert_call_argument certReaderIdentityId=example-identity az deployment sub create
assert_call_argument domainVerificationId=seeded-verification az deployment sub create
assert_call_argument "regions=$REGIONS" az deployment sub create
assert_equal "${outputs[WEB_URI]}" https://preview.azurecontainerapps.io
assert_equal "${outputs[CUSTOM_DOMAIN]}" app-feature-login.example.com
assert_call_argument armregistry.azurecr.io/astervoids-web:test-sha az containerapp update

for failure_case in provision fallback missing-app; do
  reset_deployment
  branch_settings
  expected=1
  case "$failure_case" in
    provision) AZD_PROVISION_RC=6; expected=6 ;;
    fallback) APP_STATE=after-bicep BICEP_FAILURES=1; expected=42 ;;
    missing-app) APP_STATE=missing ;;
  esac
  expect_failure "$expected" deploy_shared_infra_branch deployment outputs
  assert_calls 0 docker
  assert_calls 0 az containerapp update
done

reset_deployment
bootstrap_shared_certificate rg-production cae-production-north example-subscription \
  https://example.vault.azure.net/secrets/wildcard-example-com wildcard-example-com example-identity
assert_calls 1 az containerapp env identity assign
assert_calls 1 az rest
CERT_BODY=$(jq -sr '.[] | select(.[0:2] == ["az","rest"]) | .[index("--body")+1]' "$CALL_LOG")
assert_equal "$(jq -r '.location' <<< "$CERT_BODY")" northeurope
assert_equal "$(jq -r '.properties.certificateKeyVaultProperties.identity' <<< "$CERT_BODY")" example-identity
assert_equal "$(jq -r '.properties.certificateKeyVaultProperties.keyVaultUrl' <<< "$CERT_BODY")" \
  https://example.vault.azure.net/secrets/wildcard-example-com

reset_deployment
EXISTING_CERT=wildcard-example-com
bootstrap_shared_certificate rg-production cae-production example-subscription \
  https://example.vault.azure.net/secrets/wildcard-example-com wildcard-example-com example-identity
assert_calls 1 az containerapp env identity assign
assert_calls 0 az rest

for failure_case in environment identity list put; do
  reset_deployment
  expected=5
  case "$failure_case" in
    environment) CAE_EXISTS=false; expected=1 ;;
    identity) IDENTITY_RC=5 ;;
    list) CERT_LIST_RC=5 ;;
    put) CERT_PUT_RC=5 ;;
  esac
  expect_failure "$expected" bootstrap_shared_certificate rg-production cae-production example-subscription \
    https://example.vault.azure.net/secrets/wildcard-example-com wildcard-example-com example-identity
  if [ "$failure_case" != put ]; then assert_calls 0 az rest; fi
done

echo "Workflow helper tests passed"
