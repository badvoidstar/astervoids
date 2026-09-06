#!/bin/bash

azd_env_value() {
  local key="$1"
  local values="${2-}"

  case "$key" in
    ''|*[!A-Z0-9_]*)
      echo "azd_env_value: invalid key '$key'" >&2
      return 2
      ;;
  esac

  if [ "$#" -lt 2 ]; then
    values=$(azd env get-values --output json) || return
  fi
  # azd's default dotenv output escapes JSON-valued settings. Read its JSON
  # object instead, letting jq decode strings exactly once.
  jq -r --arg key "$key" '.[$key] // empty' <<< "$values"
}

require_azd_env_value() {
  local key="$1"
  local value

  if [ "$#" -lt 2 ]; then
    value=$(azd_env_value "$key") || return
  else
    value=$(azd_env_value "$key" "$2") || return
  fi
  if [ -z "$value" ]; then
    echo "require_azd_env_value: '$key' is missing or empty" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

resolve_domain_verification_id() {
  local resource_group="$1"
  shift
  local resource_kind="app"
  local candidate value

  for candidate in "$@"; do
    if [ "$candidate" = "--" ]; then
      resource_kind="environment"
      continue
    fi
    [ -n "$candidate" ] || continue

    if [ "$resource_kind" = "app" ]; then
      value=$(az containerapp show \
        --name "$candidate" \
        --resource-group "$resource_group" \
        --query 'properties.customDomainVerificationId' \
        -o tsv 2>/dev/null || true)
    else
      value=$(az containerapp env show \
        --name "$candidate" \
        --resource-group "$resource_group" \
        --query 'properties.customDomainConfiguration.customDomainVerificationId' \
        -o tsv 2>/dev/null || true)
    fi

    if [ -n "$value" ]; then
      echo "Using customDomainVerificationId from $candidate (length: ${#value})" >&2
      printf '%s\n' "$value"
      return 0
    fi
  done
}

deployment_output() {
  local outputs_json="$1"
  local key_lc
  key_lc=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$outputs_json" \
    | jq -r --arg key "$key_lc" \
      'to_entries[] | select((.key | ascii_downcase) == $key) | .value.value // empty' \
    | head -1
}

deployment_output_json() {
  local outputs_json="$1"
  local key_lc
  key_lc=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$outputs_json" \
    | jq -c --arg key "$key_lc" \
      'to_entries[] | select((.key | ascii_downcase) == $key) | .value.value // empty'
}

publish_astervoids_image() {
  local acr_name="$1"
  local login_server="$2"
  local image_tag="$3"

  if [ -z "$acr_name" ] || [ -z "$login_server" ] || [ -z "$image_tag" ]; then
    echo "publish_astervoids_image: registry name, endpoint, and image tag are required" >&2
    return 2
  fi

  PUBLISHED_IMAGE="${login_server}/astervoids-web:${image_tag}"
  echo "Building and pushing image: $PUBLISHED_IMAGE"
  az acr login --name "$acr_name" || return
  docker build -t "$PUBLISHED_IMAGE" ./AstervoidsWeb || return
  docker push "$PUBLISHED_IMAGE"
}

normalize_deployment_regions() {
  local regions="${1:-[]}"
  if ! jq -ce '
    if type == "array" and all(.[];
      type == "object" and
      all(.name, .location, .displayName; type == "string" and length > 0))
    then . else error("invalid regions") end
  ' <<< "$regions" 2>/dev/null; then
    echo "::warning::REGIONS_JSON is not a region array. Falling back to single-region." >&2
    printf '[]\n'
  fi
}

primary_region_name() {
  jq -r '.[0].name // empty' <<< "${1:-[]}"
}

shared_container_environment() {
  local primary
  primary=$(primary_region_name "$1") || return
  printf '%s%s\n' "$2" "${primary:+-$primary}"
}

deployment_mode() {
  if [ "$1" != "true" ]; then
    printf 'branch\n'
  elif [ "$(jq 'length' <<< "$2")" -gt 0 ]; then
    printf 'multi-region\n'
  else
    printf 'single-region\n'
  fi
}

# Procedures take a named associative settings array and fill a named output
# array. IaC inputs come from the selected azd environment; workflow-only inputs
# (runId, imageTag, resourceGroup, appPrefix, environmentPrefix, staticDir) are
# supplied by the caller. Optional certificate/domain values remain private.
load_deployment_settings() {
  local -n settings="$1"
  local values regions
  values=$(azd env get-values --output json) || return
  settings[environmentName]=$(require_azd_env_value AZURE_ENV_NAME "$values") || return
  settings[location]=$(require_azd_env_value AZURE_LOCATION "$values") || return
  regions=$(azd_env_value REGIONS_JSON "$values") || return
  settings[regions]=$(normalize_deployment_regions "$regions") || return
  settings[useSharedInfra]=$(azd_env_value USE_SHARED_INFRA "$values")
  settings[useSharedInfra]="${settings[useSharedInfra]:-false}"
  settings[customDomainName]=$(azd_env_value CUSTOM_DOMAIN_NAME "$values")
  settings[customSubdomain]=$(azd_env_value CUSTOM_SUBDOMAIN "$values")
  settings[certKeyVaultSecretUrl]=$(azd_env_value CERT_KEY_VAULT_SECRET_URL "$values")
  settings[certKeyVaultCertName]=$(azd_env_value CERT_KEY_VAULT_CERT_NAME "$values")
  settings[certReaderIdentityId]=$(azd_env_value CERT_READER_IDENTITY_ID "$values")
  settings[domainVerificationId]=$(azd_env_value DOMAIN_VERIFICATION_ID "$values")
}

deploy_bicep() {
  local -n settings="$1"
  local deployment_name="$2" verification_id="$3" key
  local -a parameters=()
  for key in environmentName location useSharedInfra regions customDomainName customSubdomain \
    certKeyVaultSecretUrl certKeyVaultCertName certReaderIdentityId; do
    parameters+=("$key=${settings[$key]}")
  done
  parameters+=("domainVerificationId=$verification_id")
  az deployment sub create \
    --name "$deployment_name" \
    --location "${settings[location]}" \
    --template-file infra/main.bicep \
    --parameters "${parameters[@]}" \
    --output none
}

# ARM changes the case of acronym-prefixed output names. Normalize both ARM and
# azd results here so every procedure exposes the same downstream contract.
read_deployment_outputs() {
  local format="$1" values="$2" key
  local -n result="$3"
  for key in WEB_URI CONTAINER_APP_NAME CONTAINER_APPS_ENVIRONMENT RESOURCE_GROUP \
    CUSTOM_DOMAIN AZURE_CONTAINER_REGISTRY_NAME AZURE_CONTAINER_REGISTRY_ENDPOINT \
    STATIC_WEB_APP_NAME STATIC_WEB_APP_DEFAULT_HOSTNAME; do
    case "$format" in
      azd) result[$key]=$(azd_env_value "$key" "$values") || return ;;
      arm) result[$key]=$(deployment_output "$values" "$key") || return ;;
      *) echo "Unknown deployment output format" >&2; return 2 ;;
    esac
  done
  for key in REGION_ENDPOINTS STATIC_APEX_REGION_MANIFEST; do
    result[$key]='[]'
    if [ "$format" = "arm" ]; then
      result[$key]=$(deployment_output_json "$values" "$key") || return
      result[$key]="${result[$key]:-[]}"
    fi
  done
  for key in WEB_URI CONTAINER_APP_NAME CONTAINER_APPS_ENVIRONMENT RESOURCE_GROUP; do
    if [ -z "${result[$key]}" ]; then
      echo "::error::Deployment did not produce $key." >&2
      return 1
    fi
  done
}

read_bicep_deployment_outputs() {
  local values
  values=$(az deployment sub show --name "$1" --query 'properties.outputs' -o json) || return
  read_deployment_outputs arm "$values" "$2"
}

deploy_single_region_production() {
  local -n result="$2"
  local values
  azd up --no-prompt || return
  values=$(azd env get-values --output json) || return
  read_deployment_outputs azd "$values" "$2" || return
  result[IS_MULTI_REGION]=false
}

provision_multi_region() {
  local -n settings="$1"
  local deployment_name="$2" primary verification_id deploy_rc
  primary=$(primary_region_name "${settings[regions]}") || return
  verification_id=$(resolve_domain_verification_id \
    "${settings[resourceGroup]}" \
    "${settings[appPrefix]}-production-$primary" "${settings[appPrefix]}-production" \
    -- "${settings[environmentPrefix]}-$primary" "${settings[environmentPrefix]}") || return

  if deploy_bicep "$1" "$deployment_name" "$verification_id"; then
    return 0
  else
    deploy_rc=$?
  fi
  if [ -z "${settings[customDomainName]}" ] || [ -n "$verification_id" ]; then
    return "$deploy_rc"
  fi
  echo "::warning::First multi-region pass failed without domainVerificationId. Retrying once using the new primary CAE." >&2
  verification_id=$(resolve_domain_verification_id \
    "${settings[resourceGroup]}" -- "${settings[environmentPrefix]}-$primary") || return
  if [ -z "$verification_id" ]; then
    echo "::error::Retry aborted: no customDomainVerificationId on the primary CAE." >&2
    return "$deploy_rc"
  fi
  deploy_bicep "$1" "$deployment_name" "$verification_id"
}

prepare_static_apex() {
  local directory="$1" manifest="$2" bootstrap
  bootstrap=$(jq -cn --argjson regions "$manifest" \
    '{regionId: null, displayName: null, regions: $regions}') || return
  rm -rf -- "$directory" || return
  mkdir -p "$directory" || return
  cp -R AstervoidsWeb/wwwroot/. "$directory"/ || return
  printf 'window.ASTERVOIDS_REGION_BOOTSTRAP = %s;\n' "$bootstrap" > "$directory/region-bootstrap.js"
}

deploy_multi_region_production() {
  local -n settings="$1" result="$2"
  local deployment_name="production-multi-${settings[runId]}" region_names region app
  if [ -n "${settings[customDomainName]}" ] && {
    [ -z "${settings[certKeyVaultSecretUrl]}" ] || [ -z "${settings[certKeyVaultCertName]}" ];
  }; then
    echo "::error::Multi-region custom domains require a BYO certificate URL and name." >&2
    return 2
  fi
  # Production Bicep may create the cert-reader identity; an explicit ID is optional.
  settings[location]=$(jq -r '.[0].location' <<< "${settings[regions]}") || return
  provision_multi_region "$1" "$deployment_name" || return
  read_bicep_deployment_outputs "$deployment_name" "$2" || return
  publish_astervoids_image "${result[AZURE_CONTAINER_REGISTRY_NAME]}" \
    "${result[AZURE_CONTAINER_REGISTRY_ENDPOINT]}" "${settings[imageTag]}" || return
  region_names=$(jq -r '.[].name' <<< "${settings[regions]}") || return
  while IFS= read -r region; do
    app="${settings[appPrefix]}-production-$region"
    az containerapp update --name "$app" --resource-group "${settings[resourceGroup]}" \
      --image "$PUBLISHED_IMAGE" --output none || return
  done <<< "$region_names"

  prepare_static_apex "${settings[staticDir]}" "${result[STATIC_APEX_REGION_MANIFEST]}" || return
  result[STATIC_DEPLOY_DIR]="${settings[staticDir]}"
  result[IS_MULTI_REGION]=true
}

deploy_shared_infra_branch() {
  local -n settings="$1" result="$2"
  local values expected_app="${settings[appPrefix]}-${settings[environmentName]}"
  local deployment_name="fallback-${settings[environmentName]}-${settings[runId]}"
  azd provision --no-prompt || return
  if az containerapp show --name "$expected_app" \
    --resource-group "${settings[resourceGroup]}" &>/dev/null; then
    values=$(azd env get-values --output json) || return
    read_deployment_outputs azd "$values" "$2" || return
  else
    # azd can report "no changes" after a truncated environment-name collision.
    echo "::warning::Expected branch app missing after azd provision; provisioning directly with Bicep." >&2
    deploy_bicep "$1" "$deployment_name" "${settings[domainVerificationId]}" || return
    if ! az containerapp show --name "$expected_app" \
      --resource-group "${settings[resourceGroup]}" &>/dev/null; then
      echo "::error::Branch app still missing after fallback deployment." >&2
      return 1
    fi
    # Use fresh fallback outputs, not azd's potentially stale collision state.
    read_bicep_deployment_outputs "$deployment_name" "$2" || return
  fi
  publish_astervoids_image "${result[AZURE_CONTAINER_REGISTRY_NAME]}" \
    "${result[AZURE_CONTAINER_REGISTRY_ENDPOINT]}" "${settings[imageTag]}" || return
  az containerapp update --name "$expected_app" --resource-group "${settings[resourceGroup]}" \
    --image "$PUBLISHED_IMAGE" --output none || return
  result[IS_MULTI_REGION]=false
}

bootstrap_shared_certificate() {
  local resource_group="$1" environment_name="$2" subscription_id="$3"
  local secret_url="$4" cert_name="$5" identity_id="$6"
  local existing location body uri
  if ! az containerapp env show --resource-group "$resource_group" --name "$environment_name" &>/dev/null; then
    echo "::error::Shared CAE not found. Deploy production first." >&2
    return 1
  fi
  az containerapp env identity assign --resource-group "$resource_group" \
    --name "$environment_name" --user-assigned "$identity_id" --output none || return
  existing=$(az containerapp env certificate list --resource-group "$resource_group" \
    --name "$environment_name" --query "[?name=='$cert_name'].name" -o tsv) || return
  [ -z "$existing" ] || return 0
  location=$(az containerapp env show --resource-group "$resource_group" \
    --name "$environment_name" --query location -o tsv) || return
  body=$(jq -n --arg loc "$location" --arg identity "$identity_id" --arg kvurl "$secret_url" \
    '{location: $loc, properties: {certificateKeyVaultProperties: {identity: $identity, keyVaultUrl: $kvurl}}}') || return
  uri="https://management.azure.com/subscriptions/$subscription_id/resourceGroups/$resource_group/providers/Microsoft.App/managedEnvironments/$environment_name/certificates/$cert_name?api-version=2024-10-02-preview"
  az rest --method PUT --uri "$uri" --body "$body" --output none
}

write_deployment_outputs() {
  local -n result="$1"
  local output_file="$2" environment_file="$3" key
  local public_url="${result[WEB_URI]}"
  # Bicep's static-apex WEB_URI is the private custom hostname. Publish the
  # default static host instead without changing the private deployment state.
  if [ "${result[IS_MULTI_REGION]}" = true ] && [ -n "${result[STATIC_WEB_APP_DEFAULT_HOSTNAME]}" ]; then
    public_url="https://${result[STATIC_WEB_APP_DEFAULT_HOSTNAME]}"
  fi
  # Fail closed rather than letting custom-domain output become environment.url.
  if ! [[ "$public_url" =~ ^https://[a-zA-Z0-9.-]+\.azure(containerapps\.io|staticapps\.net)/?$ ]]; then
    echo "::error::Deployment URL must be a default Azure hostname." >&2
    return 1
  fi
  if [ -n "${result[STATIC_WEB_APP_DEFAULT_HOSTNAME]}" ] &&
    ! [[ "${result[STATIC_WEB_APP_DEFAULT_HOSTNAME]}" =~ ^[a-zA-Z0-9.-]+\.azurestaticapps\.net$ ]]; then
    echo "::error::Static hostname must be a default Azure hostname." >&2
    return 1
  fi
  {
    printf 'url=%s\n' "$public_url"
    printf 'static_web_app_default_hostname=%s\n' "${result[STATIC_WEB_APP_DEFAULT_HOSTNAME]}"
    printf 'static_deploy_dir=%s\n' "${result[STATIC_DEPLOY_DIR]:-}"
  } >> "$output_file" || return
  # SWA names embed CUSTOM_SUBDOMAIN too: keep them and the custom manifest in
  # runner-only environment state, never step outputs or public summaries.
  for key in CONTAINER_APP_NAME CONTAINER_APPS_ENVIRONMENT RESOURCE_GROUP \
    IS_MULTI_REGION CUSTOM_DOMAIN STATIC_WEB_APP_NAME REGION_ENDPOINTS; do
    printf '%s=%s\n' "$key" "${result[$key]}" >> "$environment_file" || return
  done
}
