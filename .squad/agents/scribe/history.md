# Project Context

- **Owner:** badvoidstar
- **Project:** astervoids
- **Purpose:** An Asteroids-like HTML5 website with single-player and multiplayer modes.
- **Stack:** ASP.NET Core 10/C#, SignalR with MessagePack, classic JavaScript and HTML5 Canvas, Azure Container Apps/Bicep, xUnit, and Node's built-in test runner.
- **Created:** 2026-09-21T20:10:23.757-07:00

## Architecture Guardrails

- Keep backend and frontend-facing transport contracts game-agnostic.
- Keep game utility code reusable and non-game-specific.

## Learnings

Initial team setup complete.

### 2026-10-04T23:42:21.863-07:00: Post-merge durable identity and menu checkpoint

- Requested by badvoidstar; Scribe records coordinator-verified facts, not a new application review or test run. [PR #184](https://github.com/badvoidstar/astervoids/pull/184), "Add durable player identities and invitations", merged into main at 2026-10-05T06:27:32Z as `561e166d3ec15440b6972aa88d0f1f3306bb27b3`; its feature branch was deleted.
- Production [Azure CICD run 37272519672](https://github.com/badvoidstar/astervoids/actions/runs/37272519672) completed successfully at that merge SHA: Build Application and Deploy to Azure passed. The branch-preview browser step was skipped on main. Deployment success is not live production or multi-region browser verification.
- Historical feature-head evidence at `260265f6fa15f7d95c18f2c747b32e112017d079`: [run 37268352518](https://github.com/badvoidstar/astervoids/actions/runs/37268352518) succeeded; reported Release build, 573 C# tests, 1550 JS tests, 16 browser helpers, 20 Squad setup tests, workflow helpers including 7 identity-infrastructure checks, Bicep compile, 36 local real-browser scenarios, and 15 deployed branch-preview browser scenarios passed. None were rerun for this state checkpoint.
- Accepted shipped scope: durable GUID/immutable-tag identity, friend/self bearer invitations, browser recovery/rebinding and revision/idempotency safeguards, with participant identity/tag integration for session scoring only. Compact native-text menu buttons, bright enabled labels, 20% tighter vertical gaps, aligned landscape columns, preserved portrait flow, and side-by-side lobby actions shipped. Development atomic JSON and Azure Table/system-managed identity preserve shared production identities, isolated preview stores, process-local gameplay sessions, exact HTTPS origin checks, and OIDC deployment. No durable high scores or anti-cheat/server-authenticated scoring is claimed; invitation/browser credentials remain outside SignalR/game records. Custom-domain values and certificate references remain private.
- Limits: 512 projected layout-state combinations are presentation coverage, not empirical multi-region measurements. Live production/multi-region/static-apex identity browser flows, physical mobile clipboard/fullscreen, assistive technologies, and adverse cellular networks remain unverified/manual. This milestone is complete; the wider backlog was not assessed. No new workflow practice, permanent learning, IAM change, secret change, or legacy certificate-variable deletion is authorized by this checkpoint.
- State handoff: only this history append and one ignored local runtime log are written by Scribe. The coordinator owns acceptance/application of proposed decisions and the replacement current-focus note. The earlier scoring note below is retained in tracked history, not only in the ignored log.

#### Historical now.md snapshot (verbatim)

Prior reported PR #183 scoring-review evidence, not new execution or PR #184 validation. The complete preexisting `identity\now.md` content, including its original verification limits, follows unchanged.

```markdown
---
updated_at: 2026-10-01T02:40:41.590-07:00
focus_area: Completed personal/team scoring delivery (verified locally)
active_issues: []
---

# What We're Focused On

Personal/team scoring delivery is complete and verified locally. Lead (Alex) APPROVED Tester (Casey)'s independent schema/join revision, clearing both prior blockers and the feature gate with no remaining high-confidence artifact blocker reported.

Final reported evidence: full JavaScript suite 1521 passed; Release build with zero warnings/errors; C# suite 442 passed; browser helpers 13 and real-browser suite 24 passed. Alex independently reran 143 join/transport-identity tests and a malformed-replay cleanup experiment successfully.

No deployment, branch-preview, or physical-device verification is claimed. No new workflow practice or permanent learning was owner-approved or stored.
```

**Validation clarification (2026-10-04T23:42:21.863-07:00):** The enumerated PR #184 validation counts are historical feature-head evidence; Scribe did not rerun those suites. The coordinator separately ran `node --test .github\scripts\squad-setup.test.mjs` for this state-only PR: **20 passed, 0 failed**. Full application, browser, and infrastructure suites were not rerun for this state-only PR.
