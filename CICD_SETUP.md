# GitHub Actions CI/CD Setup Guide

This document explains how to configure the GitHub Actions workflow for automatic build and deployment to Azure.

## Overview

The CI/CD pipeline automatically:
- **Builds** the .NET application on every push and pull request
- **Tests** the application to ensure code quality
- **Deploys** to Azure Container Apps when code is pushed to any branch
- **Creates preview environments** with custom subdomains when configured
- **Cleans up** orphaned branch resources on a daily schedule or manual run

## Prerequisites

Before the workflow can run successfully, you need:

1. An Azure subscription
2. Azure CLI installed locally (for setup)
3. Appropriate permissions to create service principals or configure workload identity federation

## Setup Instructions

### Step 1: Create an Azure AD App Registration

```bash
# Login to Azure
az login

# Set your subscription
az account set --subscription "<your-subscription-id>"

# Create an App Registration
az ad app create --display-name "GitHub-Astervoids-Deploy"
```

Note the `appId` from the output - this is your `AZURE_CLIENT_ID`.

### Step 2: Create a Service Principal

```bash
# Create service principal (replace <app-id> with the appId from step 1)
az ad sp create --id <app-id>
```

### Step 3: Assign Contributor Role

```bash
# Get your subscription ID
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Assign Contributor role to the service principal
az role assignment create \
  --role Contributor \
  --assignee <app-id> \
  --scope /subscriptions/$SUBSCRIPTION_ID
```

### Step 4: Create GitHub Environment

The workflow uses a GitHub environment for deployment protection and OIDC authentication.

1. Go to your repository Settings → Environments
2. Click "New environment"
3. Name it `production`
4. Optionally configure protection rules (e.g., required reviewers)

### Step 5: Configure Federated Credentials

```bash
# Get your GitHub repository information
GITHUB_ORG="badvoidstar"
GITHUB_REPO="astervoids"

# Create federated credential for the production environment
az ad app federated-credential create \
  --id <app-id> \
  --parameters '{
    "name": "github-astervoids-production",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:'"$GITHUB_ORG/$GITHUB_REPO"':environment:production",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Step 6: Add GitHub Secrets

Add the following secrets to your GitHub repository (Settings → Secrets and variables → Actions):

**Required for deployment:**
1. `AZURE_CLIENT_ID` - The appId from step 1
2. `AZURE_TENANT_ID` - Your Azure AD tenant ID (get it with `az account show --query tenantId -o tsv`)
3. `AZURE_SUBSCRIPTION_ID` - Your subscription ID (get it with `az account show --query id -o tsv`)

No separate Static Web Apps deployment token secret is required. The workflow fetches the SWA API token at runtime via Azure CLI using OIDC credentials.

**Optional for custom domain:**
4. `CUSTOM_DOMAIN_NAME` - Your root domain (e.g., `yourdomain.com`)
5. `CUSTOM_SUBDOMAIN` - Subdomain for the app (e.g., `app`)

If the custom domain secrets are configured, the workflow will automatically set up HTTPS. See [Custom Domain Setup](infra/CUSTOM_DOMAIN_SETUP.md) for detailed instructions on DNS configuration.

## Testing the Workflow

Deployment orchestration lives in `.github/scripts/deployment-helpers.sh`, with
separate procedures for single-region production (`azd up`), multi-region
production (Bicep, one image publish, regional updates, static payload), and
shared-infrastructure branches (`azd provision`, verified Bicep fallback, app
update). The workflow selects a procedure rather than implementing those paths.
The procedures share named settings from the selected azd environment, one
Bicep parameter builder, and normalized deployment outputs; `infra/main.bicep`
remains the infrastructure source of truth. The multi-region first-deploy retry
changes only the domain verification ID.

Region entries require unique `name` and `location` values; `name` is a
lowercase alphanumeric deployment ID of at most 14 characters, while
`location` is the lowercase Azure location identifier. Use a short ID such as
`euwest` when the Azure location name is longer. `displayName` remains
optional, with missing/null labels defaulted by Bicep to the region name;
provided labels must not be blank. CI verifies each location is enabled for
the subscription before Bicep runs, so typos and resource-name collisions stop
before Azure resources or images are created.

Production multi-region requires all of the following: a nonempty
`REGIONS_JSON`, both custom-domain secrets, and the BYO certificate URL/name
pair. The workflow rejects an incomplete request before it mutates Azure. A
direct Bicep/azd invocation with an incomplete regional request safely uses
the single-region production path and emits `DEPLOYMENT_WARNING` rather than
creating an unroutable regional deployment.

Complete BYO certificate inputs without a complete custom-domain configuration
are intentionally ignored. CI records that decision in the job summary; a
direct Bicep/azd invocation exposes the same reason through
`DEPLOYMENT_WARNING`.

CI writes custom-domain values, all three certificate inputs, the ACMEbot
management flag, and the domain verification ID into the selected azd
environment even when values are empty. This prevents restored environments
from retaining removed domain or certificate configuration. Local standalone
azd inputs are unchanged.
After a multi-region rollout, the workflow refreshes azd's `WEB_URI`,
`CONTAINER_APP_NAME`, `CONTAINER_APPS_ENVIRONMENT`, `RESOURCE_GROUP`, and
`CUSTOM_DOMAIN` from ARM outputs. These remain private azd state; the public URL
continues to use only a default Azure hostname.

Run `bash .github/scripts/workflow-helpers.test.sh` to compile/check the Bicep
origin wiring and exercise these procedures with mocked Azure/Docker commands,
including provisioning failures, retries, branch fallback, restored azd state,
certificate bootstrap, and public-output privacy. The generated static bootstrap
is also loaded by the production region client to check regional request routing.
These checks do not establish live DNS/certificate readiness, permissions
propagation, or successful Azure deployment. Custom
hostnames, region manifests, and secret-derived Static Web App names stay in
runner-local state; only default Azure hostnames are published in URL outputs.
For multi-region static-apex deployments, the public link uses the default
`*.azurestaticapps.net` host. Bicep adds that exact HTTPS origin to each regional
app's `Region__AdditionalAllowedOrigins` settings so its picker/API/SignalR
requests work, while retaining the custom apex and peer-region origins. No
wildcard origin is allowed.

For a managed-certificate path, the deployment summary reports
**Custom-domain activation pending** if DNS or certificate binding is not yet
ready. The app remains available through its default Azure hostname; review
the custom-domain step and rerun after DNS propagation instead of treating the
app deployment as failed.

### Automatic Trigger

The workflow will automatically run when:
- Code is pushed to **any branch** (builds, tests, and deploys)
- A pull request is opened against `main` (builds and tests only)
- The orphan cleanup schedule runs daily

### Manual Trigger

You can manually trigger the workflow:
1. Go to the "Actions" tab in your GitHub repository
2. Select the "Build and Deploy to Azure" workflow
3. Click "Run workflow"

## Branch Deployments

### How It Works

When you push to any branch, the workflow automatically:
1. Builds and tests the application
2. Deploys to a branch-specific Container App
3. Creates DNS records for a branch-specific subdomain
4. Binds HTTPS using the shared BYO wildcard certificate (when BYO cert variables are configured)

### Subdomain Naming

Branch deployments get subdomains following this pattern:
- **Production (main):** `{subdomain}.{domain}` (e.g., `app.yourdomain.com`)
- **Feature branches:** `{subdomain}-{branch}.{domain}` (e.g., `app-feature-login.yourdomain.com`)

Branch names are sanitized for DNS compatibility:
- Converted to lowercase
- `/` replaced with `-` (e.g., `feature/login` → `feature-login`)
- Special characters removed; trailing dashes trimmed
- **Short names are used as-is, with no hash.** If the sanitized name fits
  within 25 characters (e.g., `feature/login` → `feature-login`), it is emitted
  verbatim. This keeps the derived Container App name (`ca-web-{sanitized}`)
  within Azure's 32-character limit.
- **Only over-long names get a hash.** When the sanitized name exceeds 25
  characters, it is truncated to 20 characters and a 4-character hash of the
  full branch name is appended as `{name}-{hash}` (e.g. a long branch →
  `feature-super-long-b-71b3`). The hash guarantees that two long branches
  sharing the same truncated 20-char prefix never collide.

### Resource Naming

| Resource | Production single-region | Production multi-region | Branch (feature/login) |
|---|---|---|---|
| Container App | `ca-web-production` | `ca-web-production-<region>` | `ca-web-feature-login` (long branches: `ca-web-<name>-<hash>`) |
| Container Apps Environment | `cae-production` | `cae-production-<primary-region>` and peers | shared production CAE (`cae-production` or `cae-production-<primary-region>`) |
| Subdomain | `app.domain.com` | `app.domain.com` (static apex) + `app-<region>.domain.com` (regional ACA) | `app-feature-login.domain.com` (long branches: `app-<name>-<hash>.domain.com`) |

### Prerequisites for Branch Deployments

1. **Production must be deployed first** - Branch deployments use the shared Container Apps Environment created by the production deployment
2. **Custom domain is optional** - When configured,
   `CUSTOM_DOMAIN_NAME` and `CUSTOM_SUBDOMAIN` must both be set. With a
   regional production topology, previews inherit the configured primary
   region's Container Apps Environment and location.

### Finding a branch's custom URL (privately)

This repository is public, and **GitHub does not mask secrets in job summaries**
(only in logs). The deploy job therefore never prints a branch's full custom
hostname — it embeds the secret `CUSTOM_SUBDOMAIN`/`CUSTOM_DOMAIN_NAME`. The
branch name and its derived `{name}-{hash}` segment are public; only the
subdomain and domain stay secret.

Each deploy job instead publishes two non-secret values in its job summary and
`deploy` job outputs:

- `custom_subdomain_suffix` is the public branch-derived suffix, including its
  leading hyphen (for example, `-feature-login` or
  `-feature-super-long-b-71b3`). Production has no suffix because it uses the
  base subdomain.
- `custom_url_template` is a literal format such as
  `https://<CUSTOM_SUBDOMAIN>-feature-login.<CUSTOM_DOMAIN_NAME>`. The
  placeholder tokens are never replaced in CI and are not a live endpoint.

An administrator can copy those values to determine the expected custom URL
format, then replace the two placeholder tokens only in a private environment.

To resolve the full URL yourself, use either method below.

**Option A — local helper (offline, needs the secrets):**
Provide the secret parts via environment variables, or an untracked
`.deploy.local` file at the repo root (git-ignored):

```
CUSTOM_SUBDOMAIN=app
CUSTOM_DOMAIN_NAME=example.com
```

Then run:

```bash
./.github/scripts/branch-url.sh                # current branch
./.github/scripts/branch-url.sh feature/login  # a specific branch
# => https://app-feature-login.example.com
```

**Option B — ask Azure (no local secrets):**

```bash
az containerapp show -g rg-production \
  -n "ca-web-$(./.github/scripts/branch-url.sh --sanitized feature/login)" \
  --query "properties.configuration.ingress.customDomains[].name" -o tsv
```

> **Security invariant (don't reintroduce the leak):** because the repo is
> public and GitHub does **not** mask secrets in `$GITHUB_STEP_SUMMARY`, PR
> comments, the deployment `environment.url`, job/step names, or workflow
> outputs, no workflow may write `CUSTOM_DOMAIN` — or any value derived from
> `CUSTOM_DOMAIN_NAME`/`CUSTOM_SUBDOMAIN` (including the full custom hostname or
> cert names built from it) — to any of those surfaces. Public surfaces may only
> show the non-secret default `*.azurecontainerapps.io`/`*.azurestaticapps.net`
> FQDNs. Logs are fine (the secret substrings are auto-masked there).

### Greenfield expectations

- `main` deploys are expected to work from a clean app-stack state (no pre-existing app resource groups) when required inputs are supplied.
- Branch deploys are expected to provision from scratch against shared production infra and clean up on the next orphan-cleanup run after the branch is removed.

### Optional ACMEbot behavior

- ACMEbot integration is optional. Production deployments without a BYO
  certificate do not reference ACMEbot, its Function App, or its Key Vault.
- In production, `MANAGE_ACMEBOT_PERMISSIONS=true` is consulted only when the
  custom-domain pair and BYO certificate URL/name are supplied and
  `CERT_READER_IDENTITY_ID` is empty. In that explicit path, IaC creates the
  cert-reader identity and ACMEbot-related role assignments.
- Set `MANAGE_ACMEBOT_PERMISSIONS=false` and provide
  `CERT_READER_IDENTITY_ID` when the cert reader and permissions are managed
  outside of this template.
- The deployment identity needs **User Access Administrator** or **Owner** at
  the relevant production and certificate-Key-Vault scopes when
  `MANAGE_ACMEBOT_PERMISSIONS=true`, because that path creates Azure role
  assignments. The normal Contributor role is sufficient when using an
  externally managed reader identity.

### BYO wildcard certificate (ACMEbot) runbook

Operational procedure for the BYO wildcard certificate path described in
[ARCHITECTURE.md → BYO wildcard cert for regional hostnames](ARCHITECTURE.md#byo-wildcard-cert-for-regional-hostnames).
Only needed when you deploy with a custom domain; production without BYO
certificate inputs never touches ACMEbot.

#### One-time setup (~10 min)

Steps 1 and 3 below are manual (one-time external setup that doesn't fit
bicep). Steps 2, 4, and 5 are bicep-managed only when a production BYO
deployment supplies the custom-domain pair and certificate URL/name, omits
`CERT_READER_IDENTITY_ID`, and leaves `MANAGE_ACMEBOT_PERMISSIONS=true` (the
default). That explicit ACMEbot path provisions `id-acme-cert-reader` in
`rg-production`, grants ACMEbot DNS Zone Contributor on the production DNS
zone, and grants the cert reader Key Vault Certificate User on the ACMEbot KV.
Production deployments without BYO certificate inputs do not reference
ACMEbot resources. The deployment identity needs User Access Administrator or
Owner at the production and certificate-Key-Vault scopes for this opt-in path,
because it creates role assignments; use an externally managed reader identity
instead when the normal Contributor role should remain sufficient.

```bash
# 1. [MANUAL, ONE-TIME] Deploy ACMEbot via its ARM template (use the README button):
#    https://github.com/shibayan/keyvault-acmebot
#    Pick: subscription, resource group (default: sg-acmebot), Key Vault name (default: kv-astervoids).
#    Configure: DNS provider = Azure DNS, mailbox for Let's Encrypt notifications.
#
#    Enabling Easy Auth (REQUIRED before the dashboard works — the ARM
#    template does NOT auto-enable it; visiting the dashboard pre-auth
#    returns 401 with a JSON error body):
#
#      a. In the Azure Portal: Function App → Authentication → Add
#         identity provider → Microsoft.
#      b. App registration: "Create new app registration" with name
#         `<acmebot-function-app>-easyauth`.
#         IMPORTANT: pick "Workforce" tenant (default) — NOT "Customers"
#         (B2C is a separate product and the Function App can't use it).
#      c. Restrict access: "Require authentication". Unauthenticated
#         request action: "HTTP 401 Unauthorized".
#      d. After it saves, go to Entra ID → App registrations → find
#         the new `<acmebot-function-app>-easyauth` app:
#           • Authentication → enable "ID tokens (used for implicit
#             and hybrid flows)" checkbox. Save. Without this you'll
#             hit AADSTS700054 (response_type 'id_token' is not enabled).
#           • Manifest → confirm `accessTokenAcceptedVersion: 2` and
#             that the Function App's authsettingsV2 uses the v2 issuer
#             URL `https://login.microsoftonline.com/<tenant-id>/v2.0`.
#             (The Portal sometimes wires the v1 URL by default; v1
#             rejects v2 tokens and you'll get login-loop 401s.)
#           • Certificates & secrets → "New client secret" → 6-month
#             expiry. Copy the value.
#           • In the Function App → Configuration, set
#             `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` to that value.
#             (The portal stores it on the Authentication blade but
#             also exposes it as an app setting under this name.)
#
#      Calendar reminder: rotate `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`
#      before the 6-month expiry, or the dashboard locks you out. The
#      scheduled workflow `.github/workflows/check-easy-auth-secret.yml`
#      checks weekly and auto-opens a GitHub issue (with the rotation
#      runbook from `.github/ISSUE_TEMPLATE/easy-auth-secret-rotation.md`)
#      when < 30 days remain — set the repo variable `EASYAUTH_APP_ID` to
#      the app reg's client ID to enable it.

# 2. [BICEP-MANAGED — provided here for disaster recovery only]
#    DNS Zone Contributor on the production DNS zone for ACMEbot's identity,
#    so it can write _acme-challenge TXT records for the DNS-01 challenge.
DNS_ZONE_RG=rg-production
DNS_ZONE_NAME=<your-domain.com>
ACMEBOT_IDENTITY_ID=$(az functionapp identity show \
  --resource-group sg-acmebot --name func-astervoids \
  --query principalId -o tsv)
az role assignment create \
  --assignee "$ACMEBOT_IDENTITY_ID" \
  --role "DNS Zone Contributor" \
  --scope "$(az network dns zone show \
    --resource-group "$DNS_ZONE_RG" --name "$DNS_ZONE_NAME" --query id -o tsv)"

# 3. [MANUAL, ONE-TIME] Issue the wildcard cert via the ACMEbot dashboard:
#    Open https://<acmebot-function-app>.azurewebsites.net/
#    (the Polymind fork serves the dashboard at the ROOT URL, NOT /dashboard
#    as the upstream wiki says — visiting /dashboard returns 404 / blank).
#    Sign in with the Entra ID account that has access to the app reg from step 1.
#    Click "Add" → enter "*.<your-domain.com>" → wait ~2 min.
#    Cert lands in Key Vault as a secret (name it `wildcard-<sanitised-domain>`,
#    where dots are replaced with dashes — e.g. wildcard-example-com).

# 4. [BICEP-MANAGED — provided here for disaster recovery only]
#    User-assigned identity that production CAEs use to read the cert from KV.
az identity create \
  --resource-group rg-production \
  --name id-acme-cert-reader \
  --location <primary-region>

# 5. [BICEP-MANAGED — provided here for disaster recovery only]
#    Grant the identity 'Key Vault Certificate User' role on the KV.
CERT_READER_PRINCIPAL_ID=$(az identity show \
  --resource-group rg-production --name id-acme-cert-reader \
  --query principalId -o tsv)
KV_NAME=kv-astervoids
KV_ID=$(az keyvault show --name "$KV_NAME" --query id -o tsv)
az role assignment create \
  --assignee-object-id "$CERT_READER_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Certificate User" \
  --scope "$KV_ID"

# 6. [REQUIRED, ONE-TIME] Get the cert's Key Vault secret URL (versionless so renewals pick up automatically):
KV_NAME=kv-astervoids
CERT_NAME=wildcard-<sanitised-domain>  # whatever you named it in step 3
CERT_KV_URL="https://${KV_NAME}.vault.azure.net/secrets/${CERT_NAME}"

# 7. [REQUIRED, ONE-TIME] Set GitHub repo variables so the workflow knows where to find everything.
#    CERT_READER_IDENTITY_ID is OPTIONAL only for the explicit production
#    ACMEbot path (MANAGE_ACMEBOT_PERMISSIONS=true). It IS required for branch
#    deploys because the bootstrap step must attach the identity to the shared
#    CAE before it creates the certificate:
CERT_READER_IDENTITY_ID=$(az identity show \
  --resource-group rg-production --name id-acme-cert-reader \
  --query id -o tsv)
gh variable set CERT_KEY_VAULT_SECRET_URL --body "$CERT_KV_URL"
gh variable set CERT_KEY_VAULT_CERT_NAME --body "$CERT_NAME"
gh variable set CERT_READER_IDENTITY_ID --body "$CERT_READER_IDENTITY_ID"
gh variable set MANAGE_ACMEBOT_PERMISSIONS --body true
```

##### Opting out of bicep-managed ACMEbot permissions

If you'd rather manage the cert reader identity and role assignments
yourself (e.g. they live in a different subscription or you have a
stricter least-privilege flow), set
`MANAGE_ACMEBOT_PERMISSIONS=false` in the selected azd environment or GitHub
repository variable. Bicep then expects:
  - `certReaderIdentityId` param (or `CERT_READER_IDENTITY_ID` env var
    that the workflow forwards) to be set to an existing identity's
    resource ID.
  - The identity already has Key Vault Certificate User on the BYO cert KV.
  - ACMEbot already has DNS Zone Contributor on the production DNS zone.

##### Cleaning up duplicate role assignments after first bicep-managed deploy

If you previously ran steps 2, 4, and 5 manually (random-GUID-named role
assignments), the first deploy with `manageAcmebotPermissions=true`
creates a SECOND, deterministically-named assignment alongside each
manual one. Both are functionally equivalent. To clean up:

```bash
# List both assignments for the cert reader on the KV — keep the one with
# the deterministic GUID matching guid(scope, principalId, roleId), delete
# the random-named one. Same drill for ACMEbot's DNS Zone Contributor.
az role assignment list \
  --assignee "$CERT_READER_PRINCIPAL_ID" \
  --scope "$KV_ID" \
  --query "[].{name:name,role:roleDefinitionName}" -o table
az role assignment delete --ids <random-guid-assignment-id>
```

After step 7, the next deploy of `main` will:
- Provision a `Microsoft.App/managedEnvironments/certificates` resource on every region's CAE referencing the KV secret URL + the reader identity.
- Bind `<subdomain>.<domain>` on every region's container app with `bindingType: SniEnabled` pointing at that cert resource.
- The legacy "Configure Custom Domain" workflow step short-circuits (`env.CERT_KEY_VAULT_SECRET_URL != ''` guard) — no DigiCert managed-cert provisioning happens.

Same wildcard cert covers every branch deploy too (e.g. `astervoids-mybranch.<domain>` matches `*.<domain>`), so branch deploys also skip the cert provisioning wait — typically saving 5-7 minutes per branch deploy.

#### Cert rotation

ACMEbot rotates the cert in KV every ~60 days. Container Apps doesn't
auto-detect new KV cert versions, so a rotation isn't picked up until the
next deploy. Two practical options:

1. **Redeploy on the next push to main** (typical). The bicep re-reads the
   KV cert and updates the CAE cert resource.
2. **Scheduled GitHub Action** (`on: schedule: cron: '0 4 * * 1'`) that
   runs `az deployment sub create` once a week to pick up rotations.

If you forget for >90 days, the cert expires and `<subdomain>.<domain>`
serves a stale cert until you redeploy.

### Legacy hygiene and protected resources

- The cleanup workflow only targets branch-ephemeral resources (`ca-web-<branch>`, matching branch DNS/cert artifacts).
- Production resources (`ca-web-production` and `ca-web-production-*`, production DNS/certs) are protected from automated deletion.
- Legacy resources no longer referenced by IaC (for example old Traffic Manager profiles) should be removed intentionally via a manual ops cleanup pass.

### Automatic Cleanup

The cleanup workflow runs daily and can be started manually. It:
1. Deletes orphaned branch Container Apps
2. Removes matching DNS records (CNAME and TXT)
3. Leaves shared production certificate resources intact

**Note:** The main branch cleanup is blocked to prevent accidental deletion of production.

## Monitoring Deployments

After deployment:
- Check the "Actions" tab to view workflow runs
- View deployment logs in the workflow run details
- Access the deployed application at the URL shown in the deployment summary
- Monitor the application in the [Azure Portal](https://portal.azure.com)

## Workflow Configuration

The workflow is defined in `.github/workflows/azure-deploy.yml` and includes:

### Build Job
- Checks out the code
- Sets up .NET 10.0
- Restores dependencies
- Builds the solution
- Runs tests

The build job runs the dependency-free Squad setup suite with
`node --test .github/scripts/squad-setup.test.mjs`. It checks setup JSON,
roster/registry/charter consistency, routing, member labels, and the disabled
Copilot auto-assign setting. The active workflows' JavaScript runs against
read-only file fixtures and GitHub API mocks; these tests never create issues,
change remote labels, assign work, or start a deployment. Run the same command
locally when editing Squad setup files.

### Deploy Job (push + manual dispatch)
- Installs Azure Developer CLI (azd)
- Authenticates to Azure using OIDC (federated credentials)
- Authenticates azd using GitHub's federated credential provider
- Provisions infrastructure (if needed) using Bicep templates
- Deploys the containerized application to Azure Container Apps
- Outputs the deployment URL

### Deployment Matrix (IaC paths)

| Deployment form | Trigger | Infra shape |
|---|---|---|
| Production single-region | `main` push/manual with empty `REGIONS_JSON` | `rg-production`, single CAE/app path (greenfield-capable) |
| Production multi-region | `main` push/manual with valid nonempty `REGIONS_JSON`, custom domain, and BYO cert URL/name | `rg-production`, per-region CAE/apps + Static Web App apex (greenfield-capable) |
| Branch shared-infra preview | non-`main` push/manual | reuses production RG/ACR/shared primary CAE, creates branch app and optional DNS from scratch |
| Standalone (local azd) | local `azd up`/`azd deploy` | separate `rg-{env}` with its own safely derived ACR/CAE/app names |

## Customization

### Repository Variables and Secrets

Primary CI/CD customization points are configured in GitHub repository settings:

- Variables: `REGIONS_JSON`, `CERT_KEY_VAULT_SECRET_URL`, `CERT_KEY_VAULT_CERT_NAME`, `CERT_READER_IDENTITY_ID`, `MANAGE_ACMEBOT_PERMISSIONS`
- Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `CUSTOM_DOMAIN_NAME`, `CUSTOM_SUBDOMAIN`

### Infrastructure

The infrastructure is defined using Bicep templates in the `/infra` directory:
- `main.bicep` - Main infrastructure definition
- `main.parameters.json` - Parameters for the Bicep template

To modify the infrastructure, edit these files and the changes will be applied on the next deployment.

## Troubleshooting

### Authentication Errors

If you see authentication errors:
1. Verify that all GitHub secrets are correctly set
2. Ensure the service principal has the correct permissions
3. For OIDC, verify the federated credentials are correctly configured

### Deployment Failures

If deployment fails:
1. Check the workflow logs in the Actions tab
2. Verify that your Azure subscription has enough quota for Container Apps
3. Review the Azure Developer CLI logs for detailed error messages

### Build Failures

If the build fails:
1. Ensure the .NET SDK version matches the project requirements
2. Check for any missing dependencies
3. Run the build locally to reproduce the issue: `dotnet build astervoids.sln`

## Additional Resources

- [Azure Developer CLI Documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/)
- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Azure Container Apps Documentation](https://learn.microsoft.com/azure/container-apps/)
- [Workload Identity Federation](https://learn.microsoft.com/azure/active-directory/develop/workload-identity-federation)
