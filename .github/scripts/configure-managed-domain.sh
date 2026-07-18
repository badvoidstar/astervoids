#!/bin/bash
set -euo pipefail

: "${CUSTOM_DOMAIN:?CUSTOM_DOMAIN is required}"
: "${PRODUCTION_RG:?PRODUCTION_RG is required}"
: "${CONTAINER_APPS_ENVIRONMENT:?CONTAINER_APPS_ENVIRONMENT is required}"
: "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID is required}"

echo "Configuring custom domain: $CUSTOM_DOMAIN (single-region managed-cert flow)"

check_dns() {
  local cname_result txt_result
  echo "Checking DNS propagation for $CUSTOM_DOMAIN..."
  cname_result=$(nslookup "$CUSTOM_DOMAIN" 2>/dev/null | grep -i "canonical name" || true)
  txt_result=$(nslookup -type=TXT "asuid.$CUSTOM_DOMAIN" 2>/dev/null | grep -i "text" || true)
  if [ -n "$cname_result" ] && [ -n "$txt_result" ]; then
    echo "DNS records found"
    return 0
  fi
  echo "DNS not yet propagated (CNAME: ${cname_result:-not found}, TXT: ${txt_result:-not found})"
  return 1
}

bind_single_region() {
  local existing_binding hostname_exists cert_name cert_exists cert_id
  local cert_ready=false

  echo "::group::Binding $CUSTOM_DOMAIN on $CONTAINER_APP_NAME"
  existing_binding=$(az containerapp hostname list \
    --resource-group "$PRODUCTION_RG" --name "$CONTAINER_APP_NAME" \
    --query "[?name=='$CUSTOM_DOMAIN'].bindingType" -o tsv 2>/dev/null || true)
  if [ "$existing_binding" = "SniEnabled" ]; then
    echo "Already SniEnabled - skipping"
    echo "::endgroup::"
    return 0
  fi

  hostname_exists=$(az containerapp hostname list \
    --resource-group "$PRODUCTION_RG" --name "$CONTAINER_APP_NAME" \
    --query "[?name=='$CUSTOM_DOMAIN'].name" -o tsv 2>/dev/null || true)
  if [ -z "$hostname_exists" ]; then
    echo "Adding custom hostname..."
    if ! az containerapp hostname add \
      --resource-group "$PRODUCTION_RG" --name "$CONTAINER_APP_NAME" \
      --hostname "$CUSTOM_DOMAIN" 2>&1; then
      echo "::warning::Failed to add hostname on $CONTAINER_APP_NAME"
      echo "::endgroup::"
      return 1
    fi
  else
    echo "Hostname already exists, skipping add..."
  fi

  cert_name="cert-${CUSTOM_DOMAIN//./-}"
  cert_exists=$(az containerapp env certificate list \
    --resource-group "$PRODUCTION_RG" --name "$CONTAINER_APPS_ENVIRONMENT" \
    --query "[?name=='$cert_name'].name" -o tsv 2>/dev/null || true)
  if [ -z "$cert_exists" ]; then
    echo "Creating managed certificate (CNAME validation)..."
    if ! az containerapp env certificate create \
      --resource-group "$PRODUCTION_RG" --name "$CONTAINER_APPS_ENVIRONMENT" \
      --certificate-name "$cert_name" \
      --hostname "$CUSTOM_DOMAIN" \
      --validation-method CNAME 2>&1; then
      echo "::warning::Failed to create certificate on $CONTAINER_APPS_ENVIRONMENT"
      echo "::endgroup::"
      return 1
    fi
  fi

  cert_id="/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/$PRODUCTION_RG/providers/Microsoft.App/managedEnvironments/$CONTAINER_APPS_ENVIRONMENT/managedCertificates/$cert_name"
  for i in $(seq 1 30); do
    local state
    state=$(az resource show --ids "$cert_id" --query "properties.provisioningState" -o tsv 2>/dev/null || echo "NotFound")
    echo "Cert state: $state (check $i/30)"
    if [ "$state" = "Succeeded" ]; then
      cert_ready=true
      break
    fi
    if [ "$state" = "Failed" ]; then
      echo "::warning::Cert provisioning Failed on $CONTAINER_APPS_ENVIRONMENT"
      break
    fi
    sleep 10
  done

  if [ "$cert_ready" = "true" ]; then
    echo "Binding certificate..."
    if az containerapp hostname bind \
      --resource-group "$PRODUCTION_RG" --name "$CONTAINER_APP_NAME" \
      --hostname "$CUSTOM_DOMAIN" \
      --environment "$CONTAINER_APPS_ENVIRONMENT" \
      --validation-method CNAME 2>&1; then
      echo "HTTPS enabled for $CUSTOM_DOMAIN on $CONTAINER_APP_NAME"
      echo "::endgroup::"
      return 0
    fi
  fi

  echo "::warning::Cert not ready / bind failed for $CONTAINER_APP_NAME"
  echo "::endgroup::"
  return 1
}

max_retries=3
retry_delay=120
for attempt in $(seq 1 "$max_retries"); do
  echo ""
  echo "Custom domain setup attempt $attempt of $max_retries"

  if [ "$attempt" -gt 1 ] || ! check_dns; then
    if [ "$attempt" -gt 1 ]; then
      wait_time=$((retry_delay * (attempt - 1)))
      echo "Waiting ${wait_time}s before retry..."
      sleep "$wait_time"
    fi
    if ! check_dns; then
      echo "DNS not propagated yet, will retry..."
      if [ "$attempt" -eq "$max_retries" ]; then
        echo "::warning::DNS not propagated after $max_retries attempts. Custom domain setup incomplete."
        exit 0
      fi
      continue
    fi
  fi

  if bind_single_region; then
    echo "Single-region custom domain bound on attempt $attempt"
    exit 0
  fi
  echo "Bind attempt $attempt failed; will retry..."
done

echo "::warning::Custom domain setup incomplete after $max_retries attempts."
echo "The deployment succeeded but HTTPS is not yet configured."
echo "Usually resolves on the next deployment after DNS propagates."
