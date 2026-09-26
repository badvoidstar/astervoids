# Astervoids

A classic Astervoids game built with HTML5 Canvas and ASP.NET Core.

## Local Development

```powershell
# Run with hot reload
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# Or use Docker
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

### Real-browser playability smoke

Requires .NET 10 and Node.js 22 or later. Playwright is a **dev-only** dependency;
there is still no frontend build, bundler, or transpilation step.

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run test:browser:helpers
npm run test:browser
```

The runner builds/starts its own Release server on `http://127.0.0.1:5189`,
refuses to reuse an existing listener, and stops its server when finished.
On Linux, use `npx playwright install --with-deps chromium` to install browser
system dependencies as well.

The smoke uses the actual UI and real SignalR connections in separate Chromium
contexts: clean page boot, solo movement/fire, multiplayer create/join/start,
bidirectional keyboard-input replication, and leave/rejoin. It checks live ship
pose/version changes, not just HTTP success or a stale session label. It leaves
its own session and verifies it disappears from the active list; the server
expires the now-empty session normally.

To test an **already deployed branch preview**, copy its non-secret default ACA
URL from the deployment summary (the following hostname is a placeholder):

```powershell
$env:BROWSER_SMOKE_BASE_URL = 'https://ca-web-preview.example.azurecontainerapps.io'
npm run test:browser:remote
Remove-Item Env:BROWSER_SMOKE_BASE_URL
```

Remote mode never starts a local server and fails if the target is unavailable.
Only root HTTPS `*.azurecontainerapps.io` origins are accepted; custom domains,
credentials, and multi-region/static-apex production targets are rejected.
No screenshots, traces, videos, or raw browser errors are published by this gate.
See [browser-smoke coverage and limitations](CICD_SETUP.md#real-browser-smoke-gates)
for CI behavior and the manual checks that remain necessary.

## Continuous Integration/Deployment (CI/CD)

This project includes a GitHub Actions workflow that automatically:
- builds/tests, including actual Chromium playability, on pull requests to `main`
- deploys on pushes to any branch (`main` production, non-`main` branch previews)
- checks deployed branch previews through their default Azure hostname before
  reporting deployment success

**Setup Instructions:** See [CICD_SETUP.md](CICD_SETUP.md) for detailed setup instructions.

## Azure Deployment

This project uses [Azure Developer CLI (azd)](https://learn.microsoft.com/azure/developer/azure-developer-cli/) for deployment to Azure Container Apps.

### Prerequisites

- [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) (`winget install microsoft.azd`)
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`winget install Microsoft.AzureCLI`) - optional, for advanced operations

### First Time Setup

```powershell
# Login to Azure (opens browser)
azd auth login

# Initialize environment (prompts for subscription and region)
azd init

# Provision infrastructure and deploy
azd up
```

This will:
1. Log you into Azure (browser opens)
2. Ask you to select your subscription and region
3. Create all Azure resources (Container Registry, Container Apps Environment)
4. Build and push your container image
5. Deploy your app and give you the URL

### Iterative Development Workflow

| Action | Command |
|--------|---------|
| **Deploy code changes** | `azd deploy` |
| **Update infrastructure** | `azd provision` |
| **Full provision + deploy** | `azd up` |
| **View logs** | `azd monitor --logs` |
| **Open in portal** | `azd monitor` |
| **Show deployment info** | `azd show` |
| **Delete all resources** | `azd down --force --purge` |

### Quick Deploy After Code Changes

```powershell
azd deploy
```

Deployment time varies with image build, registry, and Azure provisioning state.

## Azure Resources Created

| Resource | Name Pattern | Purpose |
|----------|--------------|---------|
| Resource Group | `rg-{env}` | Container for all resources |
| Container Registry | `cr{normalized-env}{unique}` | Stores Docker images; hyphens are removed and the original environment still contributes to the unique suffix |
| Container Apps Environment | `cae-{safe-env}` | Managed environment for containers; long or unsuitable environment labels use a deterministic safe suffix |
| Container App | `ca-web-{safe-env}` | Runs the game; scaling limits are defined in [`infra/main.bicep`](infra/main.bicep) |
| Log Analytics | `log-cae-{safe-env}` | Logging and monitoring |

## Project Structure

```
astervoids/
├── azure.yaml              # Azure Developer CLI config
├── infra/                  # Infrastructure as Code (Bicep)
│   ├── main.bicep
│   ├── main.parameters.json
│   └── core/host/
│       ├── container-apps.bicep
│       └── container-app.bicep
└── AstervoidsWeb/
    ├── Dockerfile
    ├── Program.cs
    └── wwwroot/
        └── index.html      # The game!
```

## Controls

**Desktop:** Arrow keys to move, Space to fire, P to pause

**Mobile:** Touch controls appear automatically on touch devices
# Test
