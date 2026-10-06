---
name: Easy Auth secret rotation
about: Rotate the Easy Auth client secret on the ACMEbot Function App before it expires
title: 'Rotate Easy Auth client secret for func-astervoids'
labels: maintenance, easy-auth-rotation
assignees: ''
---

## Why

The `func-astervoids-easyauth` Entra app registration has a client secret
that gates access to the ACMEbot dashboard at
`https://func-astervoids.azurewebsites.net/`. By default, secrets are
created with a 6-month expiry. When it expires, the dashboard returns
401 (login loop) and no human can manually trigger a cert renewal from
the UI — though scheduled auto-renewals already triggered by ACMEbot
inside the Function App keep working until their own auth path breaks.

This issue is auto-opened by `.github/workflows/check-easy-auth-secret.yml`
when the secret has <= 30 days to live (or via manual dispatch). Close the
issue once you've rotated.

Monitor setup and permission-denied troubleshooting are documented in
[CICD_SETUP.md → Graph admin-consent portal runbook](https://github.com/badvoidstar/astervoids/blob/main/CICD_SETUP.md#graph-admin-consent-portal-runbook).
`EASYAUTH_APP_ID` is a repository **secret**, not a variable. Its target
registration is different from the deployment OIDC app that needs the Graph
**Application** permission and tenant admin consent. Enabling that read-only
monitor does not rotate credentials; rotation below is a separate operation.

## How to rotate

```bash
# 1. Sign in to the subscription that holds the Entra app reg.
az login

# 2. Find the app reg's object ID (NOT the client/app ID).
# Read only the existing registration's client ID; never post it in this issue.
APP_CLIENT_ID=$(az rest --method get \
  --url "https://management.azure.com$(az functionapp show \
    --resource-group sg-acmebot --name func-astervoids --query id -o tsv)/config/authsettingsV2?api-version=2022-03-01" \
  --query properties.identityProviders.azureActiveDirectory.registration.clientId -o tsv)
APP_OBJECT_ID=$(az ad app show --id "$APP_CLIENT_ID" --query id -o tsv)

# 3. List existing credentials and note the keyId of the one about to expire.
az ad app credential list --id "$APP_CLIENT_ID" \
  --query "[].{keyId:keyId,displayName:displayName,endDateTime:endDateTime}" -o table

# 4. Create a new client secret (6-month lifetime).
NEW_SECRET=$(az ad app credential reset \
  --id "$APP_CLIENT_ID" \
  --append \
  --display-name "rotation-$(date +%Y-%m)" \
  --years 0 \
  --end-date "$(date -u -d '+180 days' +%Y-%m-%dT%H:%M:%SZ)" \
  --query password -o tsv)
echo "New secret created (length: ${#NEW_SECRET})"

# 5. Update the Function App's app setting that backs Easy Auth.
#    The Authentication blade in the Portal stores the secret in this
#    well-known app setting; updating it here rotates the live dashboard
#    auth in seconds (no restart needed; Easy Auth re-reads on next request).
az functionapp config appsettings set \
  --resource-group sg-acmebot \
  --name func-astervoids \
  --settings MICROSOFT_PROVIDER_AUTHENTICATION_SECRET="$NEW_SECRET" \
  --output none

# 6. Verify: open the dashboard in a private window and sign in.
#    https://func-astervoids.azurewebsites.net/
#    If you get AADSTS700054, the rotation worked but ID tokens got
#    disabled — re-check the Authentication blade on the app reg has
#    "ID tokens (used for implicit and hybrid flows)" enabled.

# 7. Once verified, delete the OLD credential (keep the new one only).
OLD_KEY_ID=<keyId from step 3 that just expired>
az ad app credential delete --id "$APP_CLIENT_ID" --key-id "$OLD_KEY_ID"
```

## After rotation

- [ ] New secret is live on the Function App's `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`
- [ ] Old credential is deleted from the Entra app reg
- [ ] Dashboard at `https://func-astervoids.azurewebsites.net/` loads with auth
- [ ] Close this issue
