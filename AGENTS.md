# AGENTS.md

This file provides repository-wide guidance for coding agents. Prefer small,
focused changes, preserve established boundaries, and update relevant tests and
documentation with behavioral changes.

## Repository overview

Astervoids is an HTML5 Canvas game with an ASP.NET Core 10 backend.

- `AstervoidsWeb/Program.cs`: application setup and HTTP endpoints.
- `AstervoidsWeb/Hubs/`: SignalR session hub and wire codecs.
- `AstervoidsWeb/Services/`: session, object, cleanup, and coordination logic.
- `AstervoidsWeb/Models/`: shared backend models.
- `AstervoidsWeb/wwwroot/index.html`: inline game runtime, rendering loop,
  gameplay, input, and session picker.
- `AstervoidsWeb/wwwroot/js/`: transport, replication, codecs, regional
  discovery, and spectator modules.
- `AstervoidsWeb.Tests/`: xUnit backend and integration tests.
- `AstervoidsWeb/*.test.mjs`: Node.js frontend tests.
- `infra/`: Azure Bicep infrastructure.
- `.github/workflows/azure-deploy.yml`: canonical CI and deployment workflow.
- `ARCHITECTURE.md`: detailed client, server, replication, and wire contracts.
- `CICD_SETUP.md`: deployment topology and configuration.

There is no frontend bundler or transpilation step. Keep core gameplay and
picker composition inline in `wwwroot/index.html` unless the existing
architecture explicitly places the behavior in a classic-script module.

## Architecture invariants

- SignalR with MessagePack is the only realtime transport.
- Only `SessionClient` owns the hub connection and transport lifecycle.
- `ObjectSync` owns object batching, delta encoding, sequencing, and
  reconciliation. Gameplay code must not call its underlying object transport
  methods directly.
- `ReplicationRuntime` is pull-driven by game-owned reconciliation points. Do
  not introduce an independent frame loop or consolidate those points in a way
  that changes collision-visible ordering.
- Game adapters own object-data serialization through `toSyncData`,
  `toUpdateData`, `fromSyncData`, and schema selection. Generic replication,
  transport, and server layers must not inspect game-specific `object.data`.
- Send eligibility is separate from wire flushing. `ObjectSync` coalesces
  updates and serializes flushes independently of the render frame rate.
- Session state is authoritative within one app instance and protected by the
  session lock. Preserve documented lock ordering and avoid awaiting while
  holding synchronous locks.
- The first session member is the server. If it leaves, promote the oldest
  remaining client. On departure, migrate session-scoped objects and remove
  member-scoped objects.
- Use typed service result records for expected control flow rather than
  exceptions.
- Picker-facing region names come from deployment configuration, not hardcoded
  labels.

Read the relevant section of `ARCHITECTURE.md` before changing replication,
ownership migration, simulation order, timing, codecs, or wire schemas.

## Development commands

Run commands from the repository root.

```bash
# Hot-reload development server
dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj

# CI-equivalent application build and C# tests
dotnet build astervoids.sln --configuration Release
dotnet test astervoids.sln --configuration Release --no-build

# All JavaScript tests
node --test AstervoidsWeb/*.test.mjs

# Infrastructure template smoke check
az bicep build --file infra/main.bicep

# Workflow helper tests
bash .github/scripts/workflow-helpers.test.sh

# Local container
docker-compose -f AstervoidsWeb/docker-compose.yml up --build
```

The project has no dedicated lint command. Do not add a formatter, linter,
bundler, or test framework solely for a change.

### Targeted tests

```bash
# One C# test
dotnet test AstervoidsWeb.Tests \
  --filter "FullyQualifiedName~SessionServiceTests.CreateSession_ShouldCreateSessionWithFruitName"

# One JavaScript test file
node --test AstervoidsWeb/region-service.test.mjs
```

Use targeted tests while iterating, then run the full relevant suite. Run the
solution build and both C# and JavaScript suites for cross-stack or wire-format
changes. Run the Bicep build and workflow helper tests for deployment changes.

## Testing guidance

- Add C# service, hub, endpoint, codec, and concurrency coverage under
  `AstervoidsWeb.Tests/`.
- Add browser-independent behavior tests as `AstervoidsWeb/*.test.mjs` using
  Node's built-in test runner.
- Many JavaScript tests intentionally mirror inline `index.html` logic because
  the page is not an importable module. Keep a mirror synchronized with its
  production implementation.
- Prefer exercising extracted production modules directly where they are
  importable.
- Some tests inspect or extract source text. In particular,
  `picker-freshness.test.mjs` slices the `MultiRegionSessions` block between
  source markers; preserve those markers or update the test deliberately.
- Preserve cross-wire fixtures and positional field order when changing
  MessagePack schemas. Validate both JavaScript and C# sides.
- Include regression tests for fixes, especially around lifecycle races,
  ownership transitions, stale epochs, version ordering, and timing clamps.
- Do not weaken or remove unrelated assertions to make a change pass.

## Coding conventions

- Follow nullable C# conventions and existing implicit-using/style patterns.
- Keep normal lifecycle failures represented by result objects.
- Keep lock scopes narrow and maintain deterministic ordering where behavior
  depends on age, sequence, or version.
- In JavaScript, follow the existing classic-script/IIFE module style and
  explicit public API objects. Do not introduce package-manager dependencies
  unless unavoidable.
- Preserve explicit clock domains and units. Do not mix wall time, server UTC,
  or monotonic time without conversion.
- Treat `validAt` on batched updates as a flush-time presentation/order anchor,
  not an exact timestamp for every simulated pose.
- Keep changes surgical. Do not reformat large inline sections or perform
  unrelated cleanup.

## Deployment and security

- `infra/main.bicep` is the source of truth for all deployment paths.
- Production may be multi-region; branch previews are single-region and reuse
  shared production infrastructure. Account for both paths in infrastructure
  and workflow changes.
- Never commit credentials, real domains, Azure app/client IDs, subscription
  IDs, or local deployment files.
- `CUSTOM_DOMAIN_NAME`, `CUSTOM_SUBDOMAIN`, and hostnames derived from them are
  private. GitHub log masking does not protect step summaries, PR comments,
  deployment URLs, job names, step names, or workflow outputs.
- Never write `CUSTOM_DOMAIN` or values derived from the custom-domain secrets
  to public/non-log surfaces. Public output may contain only default
  `*.azurecontainerapps.io` or `*.azurestaticapps.net` hostnames.
- Use `.github/scripts/branch-url.sh` locally to resolve a private deployment
  URL. Keep `example.com` placeholders in committed documentation and config.
- Do not expose object payloads, member identity, or session metadata in new
  logs without reviewing privacy and security implications.

## Before finishing

1. Review the diff for unrelated changes and accidental generated files.
2. Run the smallest relevant tests, followed by the applicable full suites.
3. Build the solution for production-code changes.
4. Validate Bicep and workflow helpers when infrastructure or CI changes.
5. Check changed files for secrets and confirm public deployment output cannot
   reveal custom-domain values.
6. Update `ARCHITECTURE.md`, `README.md`, or `CICD_SETUP.md` when their
   documented contracts or workflows change.
