# Custom Domain + TLS Setup

## Overview

Custom-domain behavior now depends on deployment form and certificate mode:

1. **Single-region production (`main`, empty `REGIONS_JSON`)**
   - Supports legacy managed-cert flow (DigiCert via Azure Container Apps), or BYO cert.
2. **Multi-region production (`main`, non-empty `REGIONS_JSON`)**
   - Uses **static apex** hosting (Static Web App for `<subdomain>.<domain>`).
   - Regional gameplay endpoints use per-region hostnames (`<subdomain>-<region>.<domain>`).
   - If custom domain is enabled, this path is expected to run with **BYO wildcard cert**.
3. **Branch previews (non-`main`)**
   - Reuse production shared infra/CAE and bind branch hostnames with the shared wildcard cert when BYO vars are set.

## Required Secrets and Variables

### Secrets

| Name | Purpose |
|---|---|
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | OIDC auth for workflow |
| `CUSTOM_DOMAIN_NAME` | Root domain (example: `example.com`) |
| `CUSTOM_SUBDOMAIN` | Base subdomain (example: `app`) |

### Optional BYO cert variables (recommended for multi-region and branch previews)

| Variable | Purpose |
|---|---|
| `CERT_KEY_VAULT_SECRET_URL` | Versionless KV secret URL for wildcard cert |
| `CERT_KEY_VAULT_CERT_NAME` | Certificate resource name used on CAE(s) |
| `CERT_READER_IDENTITY_ID` | Cert-reader user-assigned identity resource ID (required for branch BYO bootstrap) |

## ACMEbot Relationship

This repository does **not** deploy ACMEbot itself. ACMEbot (Function App + Key Vault) is a one-time external setup, commonly via:
- https://github.com/shibayan/keyvault-acmebot

What IaC in this repo can manage (production path, default `manageAcmebotPermissions=true`):

- Creates/adopts `id-acme-cert-reader` in `rg-production`.
- Grants **DNS Zone Contributor** on the production DNS zone to ACMEbot's managed identity.
- Grants **Key Vault Certificate User** on the ACMEbot Key Vault to `id-acme-cert-reader`.

If you set `manageAcmebotPermissions=false`, you must manage those permissions and identity wiring yourself.

## How Deployments Handle Custom Domains

### BYO cert path

When BYO vars are set, bicep creates/uses `Microsoft.App/managedEnvironments/certificates` on each relevant CAE and binds hostnames with `bindingType: SniEnabled`.

- Production single-region: binds `<subdomain>.<domain>`.
- Production multi-region: binds `<subdomain>-<region>.<domain>` on each regional app; apex is served by Static Web App.
- Branch previews: workflow bootstraps cert resource on shared CAE (if needed), then bicep binds `<subdomain>-<branch>.<domain>`.

The legacy "Configure Custom Domain" managed-cert step is skipped when BYO vars are provided.

### Managed-cert path (legacy)

If BYO vars are not set, workflow falls back to `az containerapp env certificate create` + hostname bind in the single-region flow. This mode is not the intended path for multi-region custom-domain rollouts.

## DNS Expectations

- **Single-region custom domain**: CNAME `<subdomain>.<domain>` -> container app hostname.
- **Multi-region static apex**: CNAME `<subdomain>.<domain>` -> Static Web App default hostname; each regional hostname CNAME points to its regional container app.
- **BYO + additional hostnames**: `asuid.<host>` TXT records may be emitted/required for hostname validation depending on flow and whether `domainVerificationId` is available.

## Cert Rotation

ACMEbot rotates the wildcard certificate in Key Vault, but Container Apps picks up new versions on redeploy. A regular production redeploy (or scheduled deployment) is required to refresh bound cert material.
