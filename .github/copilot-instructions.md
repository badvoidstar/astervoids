# Copilot Instructions for Astervoids

## Build, Test & Run Commands

```powershell
# Run locally with hot reload
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# Build solution (same config used in CI)
dotnet build astervoids.sln --configuration Release

# C# test suite
dotnet test astervoids.sln --configuration Release --no-build

# Run a single C# test
dotnet test AstervoidsWeb.Tests --filter "FullyQualifiedName~SessionServiceTests.CreateSession_ShouldCreateSessionWithFruitName"

# Run a single JS test file (Node's built-in test runner)
node --test AstervoidsWeb/region-service.test.mjs

# Infra template smoke check (used by CI)
az bicep build --file infra/main.bicep

# Local container run
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

There is no dedicated lint command in this repository today; CI validates with build + tests + bicep compile.

## High-Level Architecture

- **Frontend runtime**: `AstervoidsWeb/wwwroot/index.html` is the game runtime (render loop, gameplay, picker UI). Supporting modules under `wwwroot/js/` handle transport and regional behavior (`session-client.js`, `object-sync.js`, `region-service.js`, `spectator-client.js`).
- **Realtime backend**: ASP.NET Core app in `AstervoidsWeb/` with `SessionHub` (`/sessionHub`) for multiplayer events. `SessionService` owns session/member lifecycle; `ObjectService` owns object CRUD/version checks.
- **Regional discovery + routing**:
  - Server exposes `/api/regions`, `/api/ping`, and `/api/sessions` in `Program.cs`.
  - Client measures RTT per region (`region-service.js`), opens spectator hub connections per region while in picker (`spectator-client.js`), merges cross-region sessions, and routes create/join to the owning region.
- **Infrastructure/deploy topology**:
  - `infra/main.bicep` drives all deploy paths.
  - `main` can run multi-region production (per-region CAE + app + Traffic Manager).
  - Branch deploys are single-region and reuse production shared infra.
  - CI/CD lives in `.github/workflows/azure-deploy.yml`.

## Key Conventions

- **Frontend editing model**: Core gameplay/picker behavior is intentionally inline in `index.html`; do not introduce a bundler/transpile step.
- **Service result pattern**: Backend operations return typed result objects (`CreateSessionResult`, `JoinSessionResult`, etc.) instead of throwing for normal control flow.
- **Session authority model**: First member is `Server`; if server leaves, oldest remaining client is promoted. Session-scoped objects migrate ownership on member departure; member-scoped objects are removed.
- **Wire/transport boundary**:
  - SignalR + MessagePack is the only realtime transport.
  - `SessionClient` owns hub connection concerns; `ObjectSync` owns batching/delta/reconciliation; gameplay code should not bypass these layers.
- **Region naming source of truth**: Picker-facing region labels come from deployment configuration (`REGIONS_JSON`/`Region__*`), not hardcoded UI strings.
- **Secret deployment domain — never leak to public surfaces**: The repo is public. The custom deployment domain/subdomain are GitHub secrets (`CUSTOM_DOMAIN_NAME`, `CUSTOM_SUBDOMAIN`) and the full custom hostname (apex for production, `<subdomain>-<branch>` for branches) is **secret-by-correlation**. GitHub masks secrets in **logs** but **NOT** in `$GITHUB_STEP_SUMMARY`, PR comments, the deployment `environment.url`, job/step names, or workflow outputs. So never write `CUSTOM_DOMAIN` — or anything derived from those secrets — to any non-log surface. Public surfaces may only show the non-secret default `*.azurecontainerapps.io` / `*.azurestaticapps.net` FQDNs. To resolve the real URL privately, use `.github/scripts/branch-url.sh` (reads the secrets from your local env/`.deploy.local`, never committed). Keep `example.com` placeholders in committed files; never commit the real domain or app/client IDs.
- **Tests in two stacks**: C# tests are in `AstervoidsWeb.Tests/`; JS behavior/regression tests are `*.test.mjs` under `AstervoidsWeb/`.
