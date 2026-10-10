# GitHub Actions CI/CD Setup Guide

This document explains how to configure the GitHub Actions workflow for automatic build and deployment to Azure.

## Overview

The CI/CD pipeline automatically:
- **Builds** the .NET application on every push and pull request
- **Tests** the application to ensure code quality
- **Exercises real Chromium gameplay** locally before deployment and against
  the default Azure hostname after a branch-preview deployment
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

### Step 3: Assign deployment and role-assignment permissions

```bash
# Get your subscription ID
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Assign Contributor role to the service principal
az role assignment create \
  --role Contributor \
  --assignee <app-id> \
  --scope /subscriptions/$SUBSCRIPTION_ID
```

**Contributor alone is not sufficient.** Every app deployment now creates a
system-assigned managed identity and a table-scoped **Storage Table Data
Contributor** assignment. Retain Contributor for resource provisioning and
follow the [identity-storage RBAC portal runbook](#identity-storage-rbac-portal-runbook)
for constrained role-assignment management. The optional ACMEbot path has
separate DNS/Key Vault delegation requirements; neither Azure permission
grants Microsoft Graph access.

The workflow also registers `Microsoft.Storage`. Subscription policy must
allow StorageV2 accounts, Entra-authenticated Table access, and managed
identities in the selected resource groups.

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

**Optional for the Easy Auth expiration monitor:**

| Input | GitHub configuration | Purpose |
|---|---|---|
| `EASYAUTH_APP_ID` | Repository **secret** | Existing ACMEbot Easy Auth registration's Application (client) ID; not the deployment registration |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Existing repository **secrets** | Deployment OIDC identity reused by the monitor in the `production` environment |
| `force_open` | Manual workflow-dispatch input, default `false` | Test-only override of the issue threshold; not a repository variable or secret |

There is no repository variable required to enable the monitor. Keep app IDs
private; do not migrate `EASYAUTH_APP_ID` to a variable. Configuration alone
does not authorize Graph reads: follow the
[Graph admin-consent portal runbook](#graph-admin-consent-portal-runbook).

## Deployment permission runbooks

These are **independent** permission planes for the existing deployment
identity. Neither creates player credentials or a deployment client secret,
and neither replaces the other:

| Operation | Permission plane | Required grant |
|---|---|---|
| Read Easy Auth credential expiration metadata | Tenant Microsoft Graph | `Application.Read.All` **Application** permission with tenant admin consent |
| Provision app-to-table access for durable identity | Azure Resource Manager (ARM) | Contributor plus constrained role-assignment management at the table scope or an ancestor |

### Identify the deployment application privately

1. Open [Microsoft Entra admin center](https://entra.microsoft.com) in the
   deployment tenant. Current navigation is **Entra ID → App registrations →
   All applications**; some portal versions label this **Identity →
   Applications → App registrations**.
2. Use existing private provisioning records to locate the registration
   corresponding to `AZURE_CLIENT_ID` from setup steps 1–6. The example name
   `GitHub-Astervoids-Deploy` is **not** proof of the actual registration.
   Compare **Overview → Application (client) ID** privately with the recorded
   deployment client ID; do not select by display name alone.
3. Under **Certificates & secrets → Federated credentials**, verify the existing
   GitHub federation: issuer `https://token.actions.githubusercontent.com`,
   audience `api://AzureADTokenExchange`, and production subject
   `repo:badvoidstar/astervoids:environment:production`. Substitute your
   owner/repository for a clone. Existing successful workload-federation
   sign-in records can help identify the app if its name is unknown.
4. GitHub can show secret **names**, not retrieve their saved values. If the
   client ID was not retained, use private Azure provisioning/sign-in records
   and the registration's federation details to establish the identity; do
   not replace the secret or guess an app. Keep actual IDs, tenant details,
   domains, and screenshots containing them out of commits and public output.

The deployment app is the **caller**. The ACMEbot authentication registration
corresponding to `EASYAUTH_APP_ID` is the **read target**. Do not add the monitor's
Graph permission to the Easy Auth target instead.

### Graph admin-consent portal runbook

Use an authorized **Privileged Role Administrator** or **Global Administrator**
in the deployment tenant (activate the approved role through PIM if applicable).
Application Administrator and Cloud Application Administrator can manage
requested permissions, but their normal consent authority explicitly excludes
**Microsoft Graph application permissions**. A purpose-built custom consent
role is usable only if the tenant administrator has approved the required
authority; an Azure subscription role does not confer it.

1. Open the **verified deployment app registration** identified above.
2. Select **Manage → API permissions → Add a permission → Microsoft Graph**.
3. Select **Application permissions**, not **Delegated permissions**: the
   unattended OIDC workflow has no signed-in user. Search for and expand
   **Application**, select **Application.Read.All**, then **Add permissions**.
   If already present as an Application permission, do not add a duplicate.
4. Review **all** requested permissions before consenting. This read grant
   allows application/service-principal metadata reads across the tenant,
   **not just the Easy Auth target**. Approve that scope consciously; do not
   substitute directory-write permissions or subscription Owner. Credential
   expiration metadata is readable, not existing secret values.
5. Select **Grant admin consent for &lt;tenant&gt;**, confirm the dialog, then
   refresh. Verify the Microsoft Graph `Application.Read.All` row has **Type:
   Application** and **Status: Granted for &lt;tenant&gt;**. Adding the row without
   the Granted status is not sufficient. If the button is unavailable, have the
   authorized Entra administrator perform consent; do not elevate the deployer.
6. Allow permission propagation, then run **Check Easy Auth secret expiration**
   in GitHub **Actions → Run workflow**, selecting the latest PR branch while
   the workflow fix is unmerged (currently `fix/easy-auth-expiry-monitor`).
   Leave `force_open` **false** and satisfy existing `production` environment
   approvals. Alternatively, from the repository:

   ```powershell
   gh workflow run check-easy-auth-secret.yml --repo badvoidstar/astervoids --ref fix/easy-auth-expiry-monitor -f force_open=false
   ```

7. Inspect the run's steps without publishing raw identifiers or errors.
   **Log in to Azure** and **Compute days until secret expires** must actually
   run and succeed; the latter reports an expiration and days remaining.
   A green unset-configuration no-op is **not** proof of access. More than
   30 days remaining normally means no issue; at or below 30 days an issue is
   created unless an `easy-auth-rotation` issue is already open.

The successful OIDC login followed by Graph denial in
[run 37406956101](https://github.com/badvoidstar/astervoids/actions/runs/37406956101)
demonstrated this independent missing authorization, not a failed Azure login.
No grant or successful expiration read is implied by this documentation.
After [PR #187](https://github.com/badvoidstar/astervoids/pull/187) merges, the
weekly schedule uses the updated workflow on the default branch; before merge,
rerunning the old default-branch version may still use its old configuration.
No new credential, secret rotation, or Easy Auth reconfiguration is needed
to fix this Graph read denial. Rotation remains a separate maintenance task.

### Identity-storage RBAC portal runbook

The durable-identity provisioning work in
[PR #184](https://github.com/badvoidstar/astervoids/pull/184) requires the
deployment **service principal** to create table-scoped role assignments.
Contributor excludes `Microsoft.Authorization/roleAssignments/write`.
An authorized Azure administrator must configure delegation; the deployer
must not self-grant it.

1. In [Azure portal](https://portal.azure.com), select the correct subscription,
   then **Resource groups → rg-production → Access control (IAM)**.
   This scope covers production and shared-infrastructure preview identity
   accounts/tables, including resources created later beneath that group.
2. Select **Add → Add role assignment → Privileged administrator roles →
   Role Based Access Control Administrator**. The administrator performing
   this step must already have role-assignment authority at this scope.
3. On **Members**, choose **User, group, or service principal → Select members**.
   Select the deployment application's **service principal**, privately
   verifying its application ID against the registration above. Do not select
   the Easy Auth app, an operator account, or a Container App managed identity.
4. On **Conditions**, select **Allow user to only assign selected roles to
   selected principals (fewer privileges) → Select roles and principals**.
   Choose **Constrain roles and principal types → Configure**:
   - **Roles:** only **Storage Table Data Contributor**.
   - **Principal types:** only **Service principals** (`ServicePrincipal`).
   - Save the condition. Do not restrict this to a list of today's principal
     IDs: new/recreated Container Apps get new system-assigned principals.
     This role/type constraint allows those future app identities within the
     resource-group scope; it is not an app-name-specific allowlist.
5. On **Review + assign**, review the member, scope, role, and saved condition,
   then assign. Preserve the existing Contributor grant for resource
   provisioning. If your portal only exposes **Constrain roles**, that template
   alone does not restrict principal types: use the documented advanced editor
   with Microsoft's **Constrain roles and principal types** example, or have
   the administrator complete it in a supported portal. Do not fall back to
   unrestricted delegation.
6. Verify the effective/inherited grants and conditions under IAM. The
   constrained role must permit both `roleAssignments/write` for Bicep
   creation and `roleAssignments/delete` for removal of the same permitted
   assignments when needed for lifecycle/cleanup. Use the portal template or
   Microsoft's example rather than hand-writing a write-only condition:
   creation checks **Request** attributes; deletion checks **Resource**
   attributes. Retain role-assignment read access for ARM inspection.
   Other broader inherited grants can bypass these restrictions and need
   administrator review, not an unapproved permission change.
7. Allow propagation and rerun the normal deployment. Verify privately that
   each app's **system-assigned** identity has Storage Table Data Contributor
   on its exact `.../tableServices/default/tables/PlayerIdentity` table.
   Bicep's [role module](infra/core/security/player-identity-role.bicep) uses a
   deterministic assignment name incorporating the table, principal, and role;
   do not create duplicate manual app grants as the fix.
   Check identity onboarding after storage RBAC propagation, not only
   `/api/ping`; see [Provisioning order and readiness](#provisioning-order-and-readiness).

Repeat the equivalent scoped arrangement for standalone `rg-{env}` deployments.
An RG-scoped grant cannot create the RG itself: greenfield creation and grants
require an administrator-approved subscription-level provisioning/delegation
plan or administrator-created groups. Do not grant subscription Owner merely
to bypass this prerequisite.

This delegation does **not itself grant table data access** to the deployment
service principal. Assigning Storage Table Data Contributor directly to that
principal is not the fix for an ARM role-assignment denial. Bicep grants the
data role only to each app at table scope; players use the app API, not Azure
credentials. Certificate Key Vault/DNS delegation for the optional managed
ACMEbot path remains separate and is not covered by this storage-only condition.
The Graph consent runbook above does not replace this Azure RBAC grant.

### Microsoft permission references

Portal labels can vary by rollout; these Microsoft instructions define the
permissions and supported condition templates:

- [Add requested app permissions](https://learn.microsoft.com/en-us/entra/identity-platform/howto-update-permissions)
- [Tenant-wide admin consent and authorized Entra roles](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)
- [Graph application reads and least-privileged permissions](https://learn.microsoft.com/en-us/graph/api/application-get?view=graph-rest-1.0)
- [Delegate Azure role assignments with portal conditions](https://learn.microsoft.com/en-us/azure/role-based-access-control/delegate-role-assignments-portal)
- [Constrain roles and principal types: write/delete examples](https://learn.microsoft.com/en-us/azure/role-based-access-control/delegate-role-assignments-examples#example-constrain-roles-and-principal-types)
- [Assign Azure Table data access and propagation](https://learn.microsoft.com/en-us/azure/storage/tables/assign-azure-role-data-access)

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
management flag, the root-onboarding flag, and the domain verification ID into the selected azd
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
certificate bootstrap, and public-output privacy. The suite also runs
`identity-infrastructure.test.mjs` against the compiled ARM template to verify
all four identity-storage paths, shared regional configuration, isolated
environment naming, table-scoped managed-identity grants, and credential-free
runtime settings. The generated static bootstrap
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

### Real-browser smoke gates

`package.json` and `package-lock.json` pin the dev-only Playwright test runner.
This tooling does not bundle, transpile, or change the shipped game. The build
job installs Chromium and runs `npm run test:browser` against an owned local
Release server **after** the .NET build (`BROWSER_SMOKE_NO_BUILD=1`). Browser
failure blocks deployment just like a C# or JavaScript test failure.

Run the same gate locally from the repository root:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run test:browser:helpers
npm run test:browser
```

Linux runners use `npx playwright install --with-deps --only-shell chromium`.
Both CI gates use default headless Chromium, without a channel override, so
they need the headless shell and OS dependencies but not the full headed
browser. The local install command above retains headed debugging support.
Local smoke builds the app unless `BROWSER_SMOKE_NO_BUILD=1` is set, starts it on
`http://127.0.0.1:5189`, refuses an occupied port, and tears it down afterwards.
It requires no separately running development server. Do not set the no-build
flag unless the current sources have already been built in Release.

After a **branch** deploy, the workflow runs `npm run test:browser:remote` with
`BROWSER_SMOKE_BASE_URL` from `steps.deploy.outputs.url`, the existing non-secret
default ACA URL. Branches are single-region even when production is multi-region.
This is a required post-deploy check: failure prevents the success summary but
does not roll back the already deployed Azure revision. The gate neither reads
custom-domain secrets nor starts a deployment.

To check an existing preview privately from PowerShell, use its **default**
`*.azurecontainerapps.io` URL from the deployment summary, not the custom URL:

```powershell
$env:BROWSER_SMOKE_BASE_URL = 'https://ca-web-preview.example.azurecontainerapps.io'
npm run test:browser:remote
Remove-Item Env:BROWSER_SMOKE_BASE_URL
```

The remote command requires an explicit root HTTPS ACA URL without credentials,
a nondefault port, query, or fragment; it cannot silently fall back to local
mode. Readiness retries connection errors/5xx for at most two minutes to allow a
new container revision to start. Redirects, bad manifests, and a manifest routing
outside the selected single origin fail closed. Gameplay scenarios have bounded
assertion waits and **zero test retries**. An unavailable preview fails rather
than being skipped. Region readiness alone is not a passing smoke result.

The Chromium guard rejects HTTP 301/302/303/307/308 responses, including
same-origin redirects, at response headers before any redirect target is
contacted. HTTP bodies and SignalR WebSockets remain native browser traffic;
no responses are fabricated or replayed. Each context owns one guarded page;
unsupported page/worker requests fail closed and service workers are disabled.
The local suite also runs owned-loopback redirect regressions against this same
guard; remote mode excludes those local-server tests.

**What this establishes:** the actual page boots without uncaught exceptions or
console errors; solo keyboard movement/fire works; independently stored clients
create and join the same newly created session through the picker; both start
playing; ship pose, thrust, and version changes reach the other client in both
directions through live SignalR; leaving removes membership and the departed
ship; rejoining creates a fresh ship that replicates again. The clients leave
only their own session, then verify it is absent from the active-session list.
Empty-session retention/expiry is still server-owned. No fake hubs, transport
responses, or test-only gameplay hooks are used.
The leaderboard screen is also opened without starting a game to exercise its
public query and navigation. Scripted high-score seeding, ranking/filter, and
drag/inertia scenarios run only in the isolated local File-provider fixture;
they are explicitly skipped against deployed tables. Regular named gameplay
and identity scenarios create identities with immutable leaderboard exclusion.
The server refuses their score submissions even after recovery or invitation
acceptance without the test marker, and browser fixtures assert that gameplay
sends no score requests. Only isolated local File-provider score scenarios opt
out; the helper rejects that opt-out when a remote target is configured.

Deploy the updated identity service before running these smoke fixtures: they
verify the persisted exclusion before named gameplay starts and fail against
older servers instead of seeding scores. Legacy unmarked identities remain
eligible; historical test scores are not guessed from non-unique player names
or automatically deleted. Local persistence coverage does not certify live
Azure writes or cross-region consistency.

**Privacy and evidence:** remote output contains only authored scenario names
and outcomes. Screenshots, videos, traces, raw console messages, object payloads,
and session identities are not uploaded. Generated Playwright output and
`node_modules` are ignored. Helper tests verify URL rejection, unavailable-target
failure, redirect refusal, reporter privacy, and the workflow's safe URL wiring;
these helpers supplement, not replace, actual browser execution.

**What still needs manual/device/deployment testing:** mobile/touch and Safari/
Firefox behavior, accessibility, visual quality, audio quality, performance/load,
long-running sessions, packet loss/reconnect/authority migration, and
cross-region routing. This narrow gate intentionally does not visit production's
multi-region static apex or private regional hostnames. Validate those privately
with the existing deployment checklist. Browser HTTPS checks are not bypassed,
but success on the default ACA hostname does **not** certify custom DNS,
certificate issuance/binding, certificate renewal, or Azure permission
propagation. Workflow-helper mocks and Bicep compilation remain infrastructure
checks, not proof of a successful live deployment.

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
4. Binds HTTPS using the shared BYO wildcard certificate (when BYO cert secrets are configured)
5. Runs the real-browser playability smoke against the default ACA URL

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
- `production` and `production-*` are reserved for production resources.
  Preview deployment rejects sanitized names in that namespace before
  selecting an azd environment, so a preview cannot overwrite a production
  app or its identity-storage configuration.

### Resource Naming

| Resource | Production single-region | Production multi-region | Branch (feature/login) |
|---|---|---|---|
| Container App | `ca-web-production` | `ca-web-production-<region>` | `ca-web-feature-login` (long branches: `ca-web-<name>-<hash>`) |
| Container Apps Environment | `cae-production` | `cae-production-<primary-region>` and peers | shared production CAE (`cae-production` or `cae-production-<primary-region>`) |
| Identity storage | one stable environment account / `PlayerIdentity` table | the same single production account/table in every region | separate stable account/table for the preview environment |
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
> FQDNs. GitHub masks registered secret values in logs only; transformed values
> may still be visible. Certificate URLs/names and cert-reader identity IDs must
> therefore be repository secrets, not unmasked repository variables.

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
  assignments, or equivalent administrator-approved constrained delegation.
  An externally managed reader avoids these **certificate-specific** grants,
  not the mandatory [identity-storage RBAC](#identity-storage-rbac-portal-runbook)
  requirement. Contributor alone is still insufficient for app deployments.

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
ACMEbot resources. This opt-in path needs role-assignment authority at the
production and certificate-Key-Vault scopes (User Access Administrator/Owner
or equivalent administrator-approved constrained delegation). Use an externally
managed reader identity instead to avoid these certificate-specific requirements. The
mandatory identity-storage role-assignment permission still applies. For the
optional expiration monitor, see the
[Graph admin-consent portal runbook](#graph-admin-consent-portal-runbook).

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
#      when <= 30 days remain — set the repository secret `EASYAUTH_APP_ID`
#      to the existing Function App authentication registration's verified
#      client ID to enable it (`gh secret set EASYAUTH_APP_ID`, private prompt).
#      Do not store this ID in an unmasked repository variable or public output.
#      The monitor uses the existing `production` environment OIDC federation.
#      Its OIDC identity also needs separately granted Microsoft Graph
#      Application.Read.All (Application type) with tenant admin consent.
#      Follow the linked Graph portal runbook above; Azure RBAC is separate.

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

# 7. [REQUIRED, ONE-TIME] Set GitHub repo secrets so the workflow knows where to find everything.
#    These commands are for new setup. For existing variables/secrets, follow
#    the migration guidance below instead; do not overwrite an existing secret.
#    Run privately with shell tracing disabled and pass values only via stdin.
#    CERT_READER_IDENTITY_ID is OPTIONAL only for the explicit production
#    ACMEbot path (MANAGE_ACMEBOT_PERMISSIONS=true). It IS required for branch
#    deploys because the bootstrap step must attach the identity to the shared
#    CAE before it creates the certificate:
CERT_READER_IDENTITY_ID=$(az identity show \
  --resource-group rg-production --name id-acme-cert-reader \
  --query id -o tsv)
printf '%s' "$CERT_KV_URL" | gh secret set CERT_KEY_VAULT_SECRET_URL
printf '%s' "$CERT_NAME" | gh secret set CERT_KEY_VAULT_CERT_NAME
printf '%s' "$CERT_READER_IDENTITY_ID" | gh secret set CERT_READER_IDENTITY_ID
gh variable set MANAGE_ACMEBOT_PERMISSIONS --body true
```

##### Migrating existing certificate variables

`CERT_KEY_VAULT_SECRET_URL`, `CERT_KEY_VAULT_CERT_NAME`, and
`CERT_READER_IDENTITY_ID` are repository **secrets**. Certificate metadata can
reveal the private deployment hostname by correlation; repository variables
are not automatically masked in GitHub Actions logs.

1. List repository secret **names only** (`gh secret list --json name`). Keep
   any existing same-name secret unchanged; it may be newer than the variable.
2. For each missing secret, capture `gh variable get NAME --json value` inside
   a private process, parse the value in memory, and stream it to
   `gh secret set NAME` via stdin. Recheck secret names before writing. Never
   print the value, put it in command-line arguments, enable shell tracing, or
   write it to disk; suppress command output/errors that might disclose it.
3. Verify only secret names/existence. The updated workflow reads `secrets.*`
   directly, with no fallback to repository variables.
4. **Retain the old repository variables until every active workflow ref has
   migrated**, including `main`, long-lived branches, and revisions that might
   be rerun. Adding secrets on a feature branch does not update older workflow
   definitions. Remove the variables only after those consumers are retired or
   updated; removing them earlier breaks their certificate configuration.

Secrets mask exact values in logs, not summaries, comments, deployment URLs, or
workflow outputs. Keep certificate metadata off those public surfaces.
`MANAGE_ACMEBOT_PERMISSIONS` remains a non-secret repository variable.

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

- The cleanup workflow targets branch-ephemeral resources (`ca-web-<branch>`,
  explicitly branch-owned identity/leaderboard stores, and matching branch DNS/cert artifacts).
- Production resources (`ca-web-production` and `ca-web-production-*`, production DNS/certs) are protected from automated deletion.
- Production and standalone identity storage remain manually retained. Disposable
  preview data is permanently retired in the same cleanup run as its orphaned app,
  after successful app deletion and confirmed absence. Older orphan stores whose
  apps were already removed are also discovered independently.
- Legacy resources no longer referenced by IaC (for example old Traffic Manager profiles) should be removed intentionally via a manual ops cleanup pass.

### Automatic Cleanup

The cleanup workflow runs daily at **13:00 UTC** and can be started manually. It:
1. Confirms remote branch absence using `git ls-remote --heads origin`, not stale
   local tracking refs; all live names use the shared sanitizer. Any sanitized
   collision protects the deployment, as do `main` and all production forms.
2. Deletes matching, tagged orphan branch Container Apps in `rg-production` and
   confirms their absence with a successful fresh inventory.
3. Permanently deletes eligible orphan preview identity/leaderboard accounts in
   that same run, including older accounts with no surviving app. No app-list
   early exit or redeploy is required. See [retention](#retention-cost-and-retirement).
4. Removes orphan branch CNAME/TXT/certificate artifacts, preserving base,
   regional-production and live-deployment artifacts and shared wildcard certs.
5. Retains the existing ACR image purge: older than 14 days, including untagged
   manifests, keeping the newest image in each repository.

The [cleanup runner](.github/scripts/cleanup-orphans.mjs) requires successful,
parsed, unfiltered app/storage inventories and a valid remote branch inventory
containing `main`. It checks every app in the group, regardless of its name, and
its active revisions for `Identity__TableEndpoint` references. Unknown/indirect
identity settings, incomplete revisions, failed discovery, or unconfirmed/failed
deletes fail the run rather than becoming evidence of absence. Missing ownership
tags, ambiguous store ownership and live references retain the store with a safe
skip. Raw inventories, resource IDs and custom hostnames are not published.

Cleanup and Azure CICD's **deploy job** share the non-cancelling
`astervoids-azure-resource-mutations` concurrency group; builds/tests remain
parallel. Queued deploys must still match the remote branch head after acquiring
the interlock. GitHub can supersede pending jobs in a concurrency group; rerun a
needed deployment if its pending job is cancelled. Cleanup re-reads branches,
apps/revisions and storage before each app/account delete and detects changed
app principals, revisions, storage creation times and ownership metadata.

This is **not an atomic GitHub/Azure transaction**. Local azd/portal operators,
older workflow versions without the shared group, manually configured consumers
outside this topology, ARM visibility delays, and a branch recreated after the
last check can still race cleanup. Pause cleanup for such work and update/rebase
deployment workflows to use the interlock. Incomplete or unsupported deployment
configuration is retained for operator review, not guessed safe.

## Durable player identity

`infra/core/storage/player-identity.bicep` provisions exactly one StorageV2
account and its `PlayerIdentity` table per deployment environment. Account
names are stable hashes of subscription, resource group, and azd environment;
they do not depend on image tags, revisions, custom domains, CAE names, or the
selected gameplay region. Production single-region and multi-region use the
same production account. Every regional app, including the first-region API
used by the Free Static Web App apex, accesses that one primary Table endpoint.
There are no per-region databases or independently writable replicas.

Shared-infrastructure previews share only RG/CAE/ACR infrastructure with
production, **not identity storage or identity principals**. Each preview has
its own account even in `rg-production`. Standalone azd deployments get their
own account in `rg-{env}`. A changed environment name or resource group selects
a different store; it is not an identity-data migration.

### Runtime configuration and authorization

Every deployed app receives these settings from Bicep:

| Setting | Deployed value |
|---|---|
| `Identity__Provider` | `AzureTable` (mandatory on every Azure path) |
| `Identity__TableEndpoint` | the provisioned account's primary Table endpoint |
| `Identity__TableName` | `PlayerIdentity` |
| `Identity__PromptOnRoot` | string form of the boolean `identityPromptOnRoot` parameter |

Set the GitHub repository variable or local azd value
`IDENTITY_PROMPT_ON_ROOT` to exactly `true` or `false`; unset/empty defaults to
`true`. For example, `azd env set IDENTITY_PROMPT_ON_ROOT false` disables the
root onboarding prompt, **not** durable identity or any authorization check.
CI validates the boolean before provisioning and rewrites the selected azd
value on every run. Direct Bicep uses `identityPromptOnRoot`, a boolean
parameter. No endpoint, connection-string, or provider override is exposed by
the deployment entrypoint, and the container module filters caller-supplied
`Identity__*` environment overrides.

Each Container App has its own **SystemAssigned** managed identity.
The deployer's separate role-assignment authority is configured through the
[identity-storage RBAC portal runbook](#identity-storage-rbac-portal-runbook).
`DefaultAzureCredential` uses that identity without storage keys, SAS tokens,
or client secrets. Only **Storage Table Data Contributor** on the exact
`.../tableServices/default/tables/PlayerIdentity` scope is assigned; no
account-, RG-, or subscription-wide data role is granted to an app. The CAE's
existing certificate-reader identity remains certificate-only and is not
attached to the app or reused for storage. Shared-key account authorization
and blob public access are disabled, with HTTPS and TLS 1.2 required.
Consumption CAEs reach the Entra-authenticated public storage endpoint;
private endpoints/VNet integration are not provisioned by this topology.

The static payload recursively copies all `wwwroot` assets, including
`js/player-identity.js`; no separate identity bundle or SWA backend is needed.
Public cross-stack limits come only from `wwwroot/shared-config.json`.
MSBuild embeds that source in the backend and generates `js/shared-config-data.js`;
static-apex packaging generates its own copy directly from the same JSON, rather
than relying on a prior local build. This file must contain no secrets. Changing
it requires rebuilding and deploying both the backend and static assets; the
generated JavaScript is ignored by git and must not be edited manually.
The existing regional bootstrap routes the static apex's API requests to the
first configured region. Browsers call app APIs, never the storage endpoint.
Azure terminates HTTPS before forwarding HTTP to the container. Bicep therefore
explicitly configures each app's default and bound custom HTTPS origins through
`Region__AdditionalAllowedOrigins`, preserving the existing exact-origin
apex/peer/default-SWA configuration. Identity POST origin validation stays strict
without trusting arbitrary forwarded headers or allowing wildcard hosts.
Identity credentials are not added to public deployment URLs or outputs.

### Durable leaderboard storage

Leaderboards reuse this environment's identity provider, primary Table endpoint,
table, and table-scoped managed-identity grant. Their canonical score records and
ranking indexes live in a separate leaderboard partition, not in identity rows.
No additional account, table, role assignment, secret, warm-up loop, or runtime
table creation is required. Production regions see the same scores; previews
and standalone environments retain their existing storage isolation.

`Leaderboard:MaxEntries` defaults to **50** (valid range **1–500**). Set
`Leaderboard__MaxEntries` as an app environment setting, or change the application
configuration, to adjust the maximum rows returned for each filtered view.
The API also returns `Session:MaxMembersPerSession` for the Team Size selector.
For local File-provider runs, the leaderboard path is
`<Identity:DataFile>.leaderboard.json`; choose an isolated identity path to isolate
both data sets.
Leaderboard APIs fail explicitly on storage outages rather than affecting app
startup or falling back to ephemeral scores.

### Provisioning order and readiness

The account/table are provisioned first, then each app/system principal, then
its table-scoped role assignment. The grant name includes the principal, so
recreating an app does not try to change the principal of an existing role
assignment. Startup and ACA TCP/liveness checks must not await Table access:
that would prevent the app deployment from finishing before ARM can grant
its identity permissions. The app does not create tables at runtime.

[Storage role assignments can take up to ten minutes to propagate](https://learn.microsoft.com/azure/storage/tables/assign-azure-role-data-access).
During that interval, or during a storage outage, identity APIs fail closed
with retryable unavailability; never enable a file/in-memory production
fallback or shared keys to make a readiness check pass. `/api/ping` alone is
not evidence of identity-storage readiness. Retry onboarding/identity checks
after RBAC propagation and rerun the browser gate if it raced a first-time
grant. Persistent failures require checking the exact table, managed
principal, role scope, and network/policy configuration in a private
administrative environment.

### Retention, cost, and retirement

- Normal incremental Bicep/azd provisioning, image updates, scale-to-zero,
  process restarts, and region selection retain the account and table.
  Identity, tag, binding, invite, and leaderboard score/index data are durable.
  Live multiplayer sessions remain process-local and do not survive restarts.
- Accounts use `Standard_LRS` in their resource group's home location.
  Storage/transaction charges and regional account quotas still apply while
  apps are at zero replicas. LRS is not cross-region disaster recovery:
  a storage-region outage can make identity and leaderboard operations unavailable everywhere.
  No backup/export schedule or row TTL is provisioned. Production/standalone
  store retirement is manual; orphan preview retirement is automatic.
  Evaluate recovery and data-retention requirements separately.
- New preview accounts carry `astervoids-data=player-identity`,
  `astervoids-deployment-kind=branch`, `azd-env-name=<sanitized-branch>` and
  `astervoids-retention=branch-orphan`. Cleanup requires these ownership tags
  (not an account-name prefix), the designated `rg-production` scope, no matching
  live branch, and no remaining app/environment or active-revision reference.
  Production, standalone, shared and unclassified accounts are not eligible.
- **Policy change for existing previews:** legacy branch accounts with
  `astervoids-retention=manual` and the same explicit branch ownership tags are
  also eligible, without retagging/redeploying or a surviving app. That legacy
  value is not a new keep policy. The first cleanup after this change can retire
  accumulated orphans. Unknown/missing tags are skipped for private operator
  review; do not relabel production/shared data as branch-owned.
- Branch deletion makes preview data disposable at the next scheduled/manual
  cleanup, with no additional retention grace period. Account deletion removes
  identities, tags, browser bindings, invitations, and leaderboard canonical
  scores/indexes permanently. Recreating the preview after retirement starts
  fresh; it does not recover old bindings/scores or reuse production data.
  Export anything that must survive **before** deleting its remote branch.
- Cleanup uses the existing production OIDC principal. It needs management-plane
  app/revision/storage read access and app/account delete access in
  `rg-production`, plus the existing DNS/cert and ACR permissions. Contributor
  covers these resource operations; no Table data read/write, storage keys,
  Microsoft Graph privilege or new broad RBAC grant is required for retirement.
  Locks/policy denials fail cleanup; fix the cause and rerun. If app deletion
  succeeded but account deletion failed, the independent storage pass retries it.
- Deleting an app/system principal alone does
  [not automatically remove its grants](https://learn.microsoft.com/azure/azure-resource-manager/bicep/scenarios-rbac#resource-deletion-behavior).
  Here the target `PlayerIdentity` table/account is also deleted, but the runner
  does not enumerate or explicitly remove RBAC assignments. Account deletion
  confirmation is not a separate verification of RBAC cleanup. Investigate any
  lingering assignments only at that exact retired account/table scope; shared
  Contributor, deployment delegation and other inherited grants remain untouched.
  Existing constrained role-assignment authority is still needed for provisioning
  and any such explicit repair, as described in the
  [RBAC runbook](#identity-storage-rbac-portal-runbook).
- To manually retire production/standalone data, an authorized administrator must
  first verify its exact environment and account/table scope and confirm no live app/branch still
  uses it. Export data under an approved retention policy if necessary, then
  intentionally delete that environment's table/account and obsolete
  table-scoped role assignments. Never delete `rg-production` to clean up a
  preview. Review stale grants to deleted system principals when recreating
  apps; new apps receive distinct grants.
- This template does not add deletion locks. `azd down` or deleting a
  standalone resource group also deletes its identity store. Deleting rows,
  a table, or an account can permanently invalidate browser bindings and
  invites; a subsequent empty reprovision is not recovery. Keep exports,
  resource IDs, credentials, and actual endpoints out of commits, PRs,
  workflow summaries, and public artifacts.

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
| Production single-region | `main` push/manual with empty `REGIONS_JSON` | `rg-production`, single CAE/app + durable production identity table (greenfield-capable) |
| Production multi-region | `main` push/manual with valid nonempty `REGIONS_JSON`, custom domain, and BYO cert URL/name | `rg-production`, per-region CAE/apps + Static Web App apex; every app shares the same production identity table |
| Branch shared-infra preview | non-`main` push/manual | reuses production RG/ACR/shared primary CAE; branch app, isolated identity/leaderboard account/table retired with an orphan preview, and optional DNS |
| Standalone (local azd) | local `azd up`/`azd deploy` | separate `rg-{env}` with its own safely derived ACR/CAE/app names and durable identity account/table |

## Customization

### Repository Variables and Secrets

Primary CI/CD customization points are configured in GitHub repository settings:

- Variables: `REGIONS_JSON`, `MANAGE_ACMEBOT_PERMISSIONS`, `IDENTITY_PROMPT_ON_ROOT` (boolean text; defaults to `true`)
- Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `CUSTOM_DOMAIN_NAME`, `CUSTOM_SUBDOMAIN`, `CERT_KEY_VAULT_SECRET_URL`, `CERT_KEY_VAULT_CERT_NAME`, `CERT_READER_IDENTITY_ID`, `EASYAUTH_APP_ID` (optional expiration monitor; see [Step 6](#step-6-add-github-secrets))

For existing certificate variables, follow
[Migrating existing certificate variables](#migrating-existing-certificate-variables);
retain them until all active workflow refs have migrated to secrets.

### Infrastructure

The infrastructure is defined using Bicep templates in the `/infra` directory:
- `main.bicep` - Main infrastructure definition
- `main.parameters.json` - Parameters for the Bicep template
- `core/storage/player-identity.bicep` - per-environment identity/leaderboard account/table; manual production/standalone retention, disposable orphan previews
- `core/security/player-identity-role.bicep` - table-scoped access for each app's system identity

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
