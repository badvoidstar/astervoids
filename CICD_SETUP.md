# GitHub Actions CI/CD Setup Guide

This document explains how to configure the GitHub Actions workflow for automatic build and deployment to Azure.

## Overview

The CI/CD pipeline automatically:
- **Builds** the .NET application on every push and pull request
- **Tests** the application to ensure code quality
- **Deploys** to Azure Container Apps when code is pushed to any branch
- **Creates preview environments** with custom subdomains for feature branches
- **Cleans up** branch resources automatically when branches are deleted

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

### Automatic Trigger

The workflow will automatically run when:
- Code is pushed to **any branch** (builds, tests, and deploys)
- A pull request is opened against `main` (builds and tests only)
- A branch is deleted (cleanup workflow removes resources)

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
2. **Custom domain secrets configured** - `CUSTOM_DOMAIN_NAME` and `CUSTOM_SUBDOMAIN` must be set

### Finding a branch's custom URL (privately)

This repository is public, and **GitHub does not mask secrets in job summaries**
(only in logs). The deploy job therefore never prints a branch's full custom
hostname — it embeds the secret `CUSTOM_SUBDOMAIN`/`CUSTOM_DOMAIN_NAME`. The
branch name and its derived `{name}-{hash}` segment are public; only the
subdomain and domain stay secret.

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

### Greenfield expectations

- `main` deploys are expected to work from a clean app-stack state (no pre-existing app resource groups) when required inputs are supplied.
- Branch deploys are expected to provision from scratch against shared production infra and clean up completely when the branch is removed.

### Optional ACMEbot behavior

- ACMEbot integration is optional. Deployments do not require ACMEbot itself when BYO cert inputs are supplied.
- In production, `manageAcmebotPermissions=true` lets IaC provision the cert-reader identity and ACMEbot-related role assignments.
- If you set `manageAcmebotPermissions=false`, supply/maintain equivalent permissions manually.

### Legacy hygiene and protected resources

- The cleanup workflow only targets branch-ephemeral resources (`ca-web-<branch>`, matching branch DNS/cert artifacts).
- Production resources (`ca-web-production` and `ca-web-production-*`, production DNS/certs) are protected from automated deletion.
- Legacy resources no longer referenced by IaC (for example old Traffic Manager profiles) should be removed intentionally via a manual ops cleanup pass.

### Automatic Cleanup

When a branch is deleted from GitHub:
1. The cleanup workflow triggers automatically
2. Deletes the branch's Container App
3. Removes DNS records (CNAME and TXT)
4. Leaves shared production certificate resources intact

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
| Production multi-region | `main` push/manual with non-empty `REGIONS_JSON` | `rg-production`, per-region CAE/apps + Static Web App apex (greenfield-capable) |
| Branch shared-infra preview | non-`main` push/manual | reuses production RG/ACR/shared CAE, creates branch app + DNS from scratch |
| Standalone (local azd) | local `azd up`/`azd deploy` | separate `rg-{env}` with its own ACR/CAE/app |

## Customization

### Repository Variables and Secrets

Primary CI/CD customization points are configured in GitHub repository settings:

- Variables: `REGIONS_JSON`, `CERT_KEY_VAULT_SECRET_URL`, `CERT_KEY_VAULT_CERT_NAME`, `CERT_READER_IDENTITY_ID`
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
