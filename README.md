# Astervoids

A classic Astervoids game built with HTML5 Canvas and ASP.NET Core.

## Local Development

```powershell
# Run with hot reload
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# Or use Docker
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

## Continuous Integration/Deployment (CI/CD)

This project includes a GitHub Actions workflow that automatically:
- builds/tests on pull requests to `main`
- deploys on pushes to any branch (`main` production, non-`main` branch previews)

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
| Container Registry | `cr{env}{unique}` | Stores Docker images |
| Container Apps Environment | `cae-{env}` | Managed environment for containers |
| Container App | `ca-web-{env}` | Runs the game; scaling limits are defined in [`infra/main.bicep`](infra/main.bicep) |
| Log Analytics | `log-cae-{env}` | Logging and monitoring |

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
