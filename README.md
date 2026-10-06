# Astervoids

A classic Astervoids game built with HTML5 Canvas and ASP.NET Core.

## Player identities and invitations

Choose a permanent 1-10 character player tag (letters, numbers, `_` or `-`).
The backend retains the identity independently of games, including solo play.
Tags need not be unique. Each browser profile and site origin has at most one
active identity; clearing its site storage removes that local access, not the
backend identity. Private browsing and other site origins are separate environments.

**Invite Friend** creates a unique link for a new player. Their first acceptance
names that identity; later visits to the same link recover it after confirmation.
**Invite Self** returns your original link, including for root-created identities.
Both buttons copy the link and show a readiness message; denied clipboard access
offers the same selectable link and a Copy retry, without generating another invite.
Controller, fullscreen, and invitation controls stack in portrait and sit beside
the main actions in landscape, including short phone viewports. Main-menu buttons
use Solo Play's compact height and native typography. Create Multiplayer spans
its column; in a session, Leave and Start/Enter split that same row so the actions
take no extra vertical space. Enabled labels use bright white text, with compact
vertical spacing and distinct disabled-button indicators.
Landscape columns share top and bottom edges: device controls sit at the top,
and the invitation pair aligns with the bottom play actions. Optional controls
collapse naturally without reserved empty button slots. Regional create buttons
put the destination on a second line, ellipsized when necessary; the Host region
selector and accessible button label retain the full name. The Host region label
and picker are shown only before joining or creating a session in a multi-region
deployment. While waiting to Start or Enter, only the applicable session actions
remain; leaving restores the region picker and its valid selection.

**Treat a self link like a password:** anyone possessing an accepted invite can
use that identity. Confirmation is protection against accidental switches, not
proof of ownership. Links do not expire automatically in this version. They use
the running site's origin and a `#invite=...` fragment; no deployment hostname is
embedded in the code. The fragment is removed immediately and completed flows
replace the address with the site root.

Recognized browsers enter silently. An invitation to a different identity offers
Accept or Ignore; acceptance atomically replaces only this browser's binding,
and other tabs stop using the previous identity. Other browsers remain bound.
Root onboarding is controlled by `Identity:PromptOnRoot` (default `true`).
When disabled, an unbound visitor remains a guest until explicitly naming through
an invite button. No durable high scores or cross-game score totals are stored.

Development uses `App_Data/identity.json`, ignored by git. Azure deployments use
managed identity and Azure Table Storage, shared across production regions and
isolated for branch previews. Storage errors are reported rather than replaced
with an ephemeral identity. See [identity architecture](ARCHITECTURE.md#durable-player-identity)
and the deployment/retention runbook in `CICD_SETUP.md`.

## Multiplayer scores

During play, the status rows read `Your Score: 125 : Pilot_1` and
`Team Score: 450 : Session name`. Your durable tag also appears in final standings;
named spectators retain their tag and show `Your Score: --`.
Game over shows your final `Your Score` above the full `Team Score` total,
alongside historical tags, including departed and zero-score players. Pure
spectators do not get a player row. Multiple browsers using one identity share
one participant total and entry-life award, while retaining separate ships.
Standings sort by score, then the original
player number, and show the highest-scoring `floor(session capacity * 1.5)`
entries; longer results scroll without hiding the exit controls.
The HUD and game-over content stay inside the session creator's game-view
rectangle, including on differently shaped or resized guest screens. Long
session names ellipsize, narrow HUDs use a second status row, and results scroll
within that same view; the surrounding letterbox margins are not extra UI space.

Personal totals survive ship recreation, same-tab rejoin, and GameState ownership
migration within that session. They follow the existing team accounting, including
accepted late awards after game over. Missing or inconsistent histories show
personal results as unavailable; missing advertised capacity defers the rows,
never the team total. The game requires its current session schemas and reports
unsupported older contracts at entry; create a new session rather than joining
with reduced score or identity features. Guest identities remain supported.
Missing/malformed tag metadata shows `Unknown` without hiding valid scores.
Solo retains its existing score mechanics and shows the active tag beside `Score`.

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
Its Production-mode local host explicitly opts into a separate temporary file
identity store; remote runs use the deployment's real configured storage.
On Linux, use `npx playwright install --with-deps chromium` to install browser
system dependencies as well.

The smoke uses the actual UI and real SignalR connections in separate Chromium
contexts: clean page boot, solo movement/fire, multiplayer create/join/start,
bidirectional keyboard-input replication, and leave/rejoin. It checks live ship
pose/version changes, not just HTTP success or a stale session label. It leaves
its own session and verifies it disappears from the active list; the server
expires the now-empty session normally.
Identity scenarios cover naming/reload, repeat/self invitations, new-browser
confirmation, competing claims, atomic replacement across tabs, clipboard denial,
and responsive native-text menu layout. Gameplay fixtures create synthetic tags
through the real backend; no identity or transport responses are fabricated.

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
