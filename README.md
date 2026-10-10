# Astervoids

A classic Astervoids game built with HTML5 Canvas and ASP.NET Core.

## Player identities and invitations

Choose a permanent 1-10 character player tag (letters, numbers, `_` or `-`).
The backend retains the identity independently of games, including solo play.
Tags need not be unique. Each browser profile and site origin has at most one
active identity; clearing its site storage removes that local access, not the
backend identity. Private browsing and other site origins are separate environments.

The maximum is defined once as `identityTagMaxLength` in
[`AstervoidsWeb/wwwroot/shared-config.json`](AstervoidsWeb/wwwroot/shared-config.json).
The backend embeds this public configuration, and builds/static packaging generate
the browser settings from the same file. Entry constraints, help/error text,
identity validation, and replicated tag handling derive from that setting.
Change the JSON and rebuild/redeploy the backend and static assets together;
do not edit the generated `shared-config-data.js`. Shared configuration must never
contain secrets. Lowering the limit requires accounting for already-saved names.

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
an invite button. Guest play is not entered into the durable leaderboards.

Cold static entry starts credential-free preparation of all configured regions
concurrently, then overlaps normal regional RTT assessment with the wait-only
identity check. Create still waits for every region's measured or unavailable
assessment and chooses by RTT, not which server wakes first. Identity authority
remains the first configured region (or the regional page's own origin).
Initial identity resolution alone retries transient network/timeouts and cold
HTTP 408/429/502/503/504 errors: at most 10 attempts within 60 seconds, with
15-second HTTP timeouts and backoff increasing from 1 to 9 seconds (honoring
longer numeric `Retry-After` within that budget). Permanent/protocol/storage
failures and exhaustion require explicit Retry; mutations are never automatically replayed.
Hiding or leaving the picker cancels pending startup work; a visible picker
resumes an interrupted initial check with a fresh budget, not an already
completed consent/error dialog. No minimum replicas, idle keep-alives or
background warmers are added. Scale-to-zero still means startup can be slow;
overlapping the work cannot eliminate container or storage initialization time.

Development uses `App_Data/identity.json`, ignored by git. Azure deployments use
managed identity and Azure Table Storage, shared across production regions and
isolated for branch previews. Storage errors are reported rather than replaced
with an ephemeral identity. Orphan preview cleanup permanently deletes that
preview's identities, bindings, invitations and leaderboard data; a recreated
preview starts fresh. Production data remains durable.
See [identity architecture](ARCHITECTURE.md#durable-player-identity)
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

## Leaderboards

**Leaderboards**, second in the main menu's second button group after Fullscreen,
opens a durable high-score table with **Rank, Name, Score, Wave, and Difficulty**.
Each named player's solo game or multiplayer participation has one entry, updated
as their personal score grows. Guests, pure spectators, and explicitly excluded
automated test accounts never create entries.
Multiple browsers using the same identity in one multiplayer session share an
entry, just as they share the session's participant total.

The three filter buttons advance once per click/tap and wrap back to **Any**:

| Filter | Values after Any |
| --- | --- |
| Team Size | 1 through the configured session capacity |
| Aspect Ratio | Portrait, Landscape, Rectangle |
| Difficulty | Shifter, Dancer, Raver, Survivor |

Button labels remain on one line at a fixed height. Narrow layouts reflow the
controls and fit native text sizes rather than wrapping or scaling rendered text.

Team Size is the peak simultaneous session membership observed while the player
participates, including guest and spectator members; solo games use 1. Aspect
Ratio uses the actual play region, including multiplayer letterboxing, rather
than the surrounding device screen. Debug-only difficulty factors appear as
`Custom (value)` in Any difficulty.

The current filtered view ranks by score and displays up to **50** records.
Configure `Leaderboard:MaxEntries` (environment variable
`Leaderboard__MaxEntries`, range 1–500) to change that cap. Hold and drag inside
the table with a mouse or touch; releasing preserves momentum and slows to a
stop. Wheel and keyboard scrolling also work. Reduced-motion preference disables
post-release momentum. **Back to Main** or Escape returns to the menu.

Scores are best-observed checkpoints, not certified final-game results.
The browser saves a bounded retry queue at start, periodically during play,
on game over, and before departure; failed delivery is visible and retried.
An interrupted game retains its best delivered checkpoint and wave rather than
waiting for the entire multiplayer session to finish. Abrupt browser/storage
loss can lose progress not yet saved. Authentication protects name attribution,
not against altered clients submitting fabricated scores.

Development persists scores in `<Identity:DataFile>.leaderboard.json`, beside the
configured identity file. Azure reuses
the environment's identity table in a separate leaderboard partition, sharing
production scores across regions and keeping branch-preview data isolated.
See [leaderboard contracts](ARCHITECTURE.md#durable-leaderboards) for ranking,
snapshot, retry, and storage details.

## Local Development

```powershell
# Run with hot reload
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# Or use Docker
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

### Squad repository setup

The coordinator and selected installed/stored skills have a **1.0.1 repository
refresh**, sourced from the CLI package inside the official
[Windows x64 release bundle](https://github.com/bradygaster/squad/releases/download/v1.0.1/squad-win32-x64.zip).
The bundle was SHA-256 verified against the release asset digest:
`f38a8f85e60982dba340187b761488f01de1aec68ea50c1b85725783d32df2fe`.
`@bradygaster/squad-cli@1.0.1` was unavailable from npm when this refresh was prepared.

Repository template versions do not identify or upgrade the installed CLI/SDK.
Check `squad --version` separately. For a WinGet-managed installation, use a
separately approved installed-CLI update:

```powershell
winget upgrade --id bradygaster.Squad --exact --source winget
```

Do not switch a WinGet installation to global npm via `squad upgrade --self`.
Other installations should retain their existing package manager.
[1.0.1](https://github.com/bradygaster/squad/releases/tag/v1.0.1) repairs upstream
WinGet/Homebrew publishing authentication, not game startup. Runtime fixes,
including 0.13.1's casting-state persistence fix, require a separate CLI/SDK update.

The selective refresh adds explicit task-scope guards, contract-focused test
guidance, selective Git staging, and routing-based escalation. Existing roster,
aliases, routing, ceremonies, Scribe/history/log duties, approval-gated
learning/reflect, local state, model preferences, and workflow/template pairs
remain intact. Upstream support-only rosters, decision-only Scribe, and alternative
learning persistence are deliberately not adopted. Unused bootstrap, release,
and gh-aw assets are not installed or refreshed; Astervoids still integrates on
`main`, not upstream Squad's generic `dev` branch.

Do not run a wholesale `squad upgrade` over these overrides: its repository
refresh also overwrites setup files/workflows and runs migrations. Review assets
selectively and validate with `node --test .github\scripts\squad-setup.test.mjs`
and `git diff --check`. Start a **new Copilot session after merging** to load the
changed coordinator and skills.

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
through the real backend. A separate local-only startup regression uses owned
loopback regional HTTP fixtures and a controlled HTML 503/delayed initial resolve
to verify concurrent assessment and automatic recovery in Chromium; it does not
claim live Azure performance or multiplayer playability for those fixtures.
Run it with `npm run test:browser -- identity.spec.mjs --grep "static multiregion cold startup"`.
Node startup regressions also cover request timeouts, retry/Retry-After budgets,
permanent errors, supersession and hidden/solo cancellation.
The full local suite also keeps the reduced-height identity failure/busy-state
regression, including its deliberately exhausted startup retries and accessible
Retry controls. Preview smoke skips only that injected-failure scenario in
addition to the existing local-only fixtures: replaying synthetic retry delays
does not measure deployment cold starts. Real identity recovery/invitation flows
and independent-client multiplayer checks still run against the preview.
Local menu-layout coverage remains exhaustive: 1,152 landscape projections and
60 resize configurations, including their original ordering and repeated visits.
The same two preview scenarios use representative selections instead: 17 display
states at all six landscape viewports (102 projections), covering every
region/role/availability combination, every fullscreen-mode/role pair, empty and
populated lists, and the long-region-label Create state with all controls visible.
Resize previews retain the full initial ten-visit sweep for each region
configuration, then short landscape → tall landscape → portrait → short landscape
after hiding and again restoring the fullscreen control (36 configurations).
The complete display-state cross-product and intermediate-height sweeps after
fullscreen changes remain local-only, not exhaustive preview coverage.
Every selected state uses the same assertions; real fullscreen entry/exit, the
independent shared-spacing regression, native text, touch/scroll and other layout
checks are unchanged. No reduced-local-coverage switch is provided.
Leaderboard scenarios cover personal solo/multiplayer checkpoints, reload
durability, guest exclusion, filter cycles, the configured row limit, and
mouse/touch inertia. Scripted score-seeding fixtures run only against isolated
local storage, not deployed tables. Remote smoke includes read-only access to
the public leaderboard. Ordinary named gameplay and identity scenarios create
durably excluded test identities and assert that no score requests are sent,
including after recovery in a browser without the automation marker. Local-only
score-persistence scenarios explicitly use eligible identities in their isolated
temporary File store; that opt-out is rejected for remote runs.

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
Its reporter emits authored scenario names, outcomes, and finite nonnegative
per-test durations rounded to milliseconds (including skips and failures).
Unavailable or invalid durations are omitted rather than reported as zero;
readiness and runner overhead are not part of these per-test measurements.
See [browser-smoke coverage and limitations](CICD_SETUP.md#real-browser-smoke-gates)
for CI behavior and the manual checks that remain necessary.

## Continuous Integration/Deployment (CI/CD)

This project includes a GitHub Actions workflow that automatically:
- validates pull requests to `main` with full build/tests (including actual
  Chromium playability), or a verified identical-tree push proof during the
  [guarded one-way reuse trial](CICD_SETUP.md#guarded-push-to-pr-validation-reuse)
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

**Desktop:** Arrow keys to move, Space to fire, P to pause (solo)

**Mobile:** Touch controls appear automatically on touch devices
# Test
