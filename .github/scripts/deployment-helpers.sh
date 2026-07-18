#!/bin/bash

azd_env_value() {
  local key="$1"
  local values="${2-}"
  local line value

  case "$key" in
    ''|*[!A-Z0-9_]*)
      echo "azd_env_value: invalid key '$key'" >&2
      return 2
      ;;
  esac

  if [ "$#" -lt 2 ]; then
    values=$(azd env get-values)
  fi
  line=$(printf '%s\n' "$values" | grep -m1 "^${key}=" || true)
  [ -n "$line" ] || return 0

  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
  esac
  printf '%s\n' "$value"
}

require_azd_env_value() {
  local key="$1"
  local value

  if [ "$#" -lt 2 ]; then
    value=$(azd_env_value "$key")
  else
    value=$(azd_env_value "$key" "$2")
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

deploy_multi_region_bicep() {
  local deployment_name="$1"
  local location="$2"
  local custom_domain_name="$3"
  local custom_subdomain="$4"
  local regions_json="$5"
  local cert_secret_url="$6"
  local cert_name="$7"
  local cert_identity_id="$8"
  local verification_id="$9"

  az deployment sub create \
    --name "$deployment_name" \
    --location "$location" \
    --template-file infra/main.bicep \
    --parameters \
      environmentName=production \
      location="$location" \
      customDomainName="$custom_domain_name" \
      customSubdomain="$custom_subdomain" \
      regions="$regions_json" \
      certKeyVaultSecretUrl="$cert_secret_url" \
      certKeyVaultCertName="$cert_name" \
      certReaderIdentityId="$cert_identity_id" \
      domainVerificationId="$verification_id" \
    --output none
}

deployment_output() {
  local outputs_json="$1"
  local key_lc
  key_lc=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$outputs_json" \
    | jq -r --arg key "$key_lc" \
      'to_entries[] | select((.key | ascii_downcase) == $key) | .value.value' \
    | head -1
}

deployment_output_json() {
  local outputs_json="$1"
  local key_lc
  key_lc=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$outputs_json" \
    | jq -c --arg key "$key_lc" \
      'to_entries[] | select((.key | ascii_downcase) == $key) | .value.value'
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
  az acr login --name "$acr_name"
  docker build -t "$PUBLISHED_IMAGE" ./AstervoidsWeb
  docker push "$PUBLISHED_IMAGE"
}
