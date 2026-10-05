# Squad Decisions

## Active Decisions

### 2026-09-21T20:10:23.757-07:00: Preserve reusable layer boundaries

**By:** badvoidstar

**What:** Keep the backend and its frontend-facing interface game-agnostic, and keep the game utility layer reusable and non-game-specific.

**Why:** Astervoids-specific mechanics belong in game adapters and gameplay composition, not reusable transport, backend, or utility layers.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction

## Configuration Decisions

### 2026-09-23T23:44:07.356-07:00: Designer and bounded active-session learning

**Authority:** User-approved configuration for Astervoids only.

**What:** Add a descriptive-name Designer for product/game UX exploration, player flows, interaction options, accessibility/input/mobile constraints, and testable acceptance criteria before non-mechanical player-facing implementation. Lead owns feasibility and architecture; Frontend owns implementation. Preserve no-bundler architecture, reusable transport boundaries, and low bandwidth/latency constraints.

Use the project-owned `.github\skills\learning-review\SKILL.md` via routing and ceremonies. Lead evaluates at most one candidate in a five-minute active-session review, due every seven days, on an observed version/capability change, or on explicit request. Capture useful evidence opportunistically after substantive work or corrections using reflect. Fact Checker verifies uncertain factual claims when needed; Scribe retains approved learnings through existing runtime-owned history/decision/log mechanisms. Only the coordinator records accepted team decisions.

**Limits:** Available tools and accessible work are the observation boundary; official-source claims require evidence, not novelty or an agent's self-description. Show proposed learned directives/skill changes for approval before promotion. This approval does not authorize future governance/charter rewrites, permission changes, installs/upgrades, background jobs, cross-repository memory, or automatic adoption. Preserve safety/reviewer gates and disabled Copilot auto-assignment. Persist no user/session content, payloads, member identity, secrets, or deployment hostnames in learning artifacts. The initial capability/source review is not yet run.

### 2026-09-23T23:55:21.858-07:00: Conversational aliases preserve canonical identities

**Authority:** User-approved friendly-name follow-up after verification of the Designer/learning configuration.

**Mapping:** Alex — Lead (`lead`); Jamie — Frontend Dev (`frontend`); Sam — Backend Dev (`backend`); Casey — QA Engineer (`tester`); Jordan — DevOps (`infra`); Maya — Product/Game UX Designer (`designer`); Morgan — Scribe (`scribe`); Quinn — Fact Checker (`fact-checker`). Ralph, Rai, and @copilot retain their existing names.

**Representation:** Use the supported Aliases column in `.squad\team.md` and explicit addressed-name routes in `.squad\routing.md`. Installed Squad 0.13.0's `parseTeamMarkdown` reads aliases; parser validation confirms eight unique aliases and eight routes to existing canonical registry members. These are coordinator conversation aliases, not a native CLI selector/task-panel rename. No unsupported registry fields or typed-config migration are introduced.

**Preservation:** Canonical roster names, registry IDs and persistent names, charter identities, charter/history locations, issue labels, ceremony participants, and special-agent identities remain unchanged. No identity migration, history moves, casting-policy change, or new cast assignment is authorized by this alias-only change. The original casting-history snapshot limitation remains unresolved; this follow-up does not imply it was saved. The learning review remains not run.

## PR 184 post-merge accepted scope

Post-merge record of accepted scope shipped in [PR #184](https://github.com/badvoidstar/astervoids/pull/184), not new architectural decisions, workflow policy, or learning approval.

### 2026-10-04T23:42:21.863-07:00: Identity, invitations, and session-scoring boundary

**Scope:** Backend GUID identity with an immutable, case-preserved `[A-Za-z0-9_-]{1,8}` tag; tags may duplicate. Friend/self invitation links are bearer capabilities. Recognized browsers activate silently; new-browser recovery and existing-binding replacement require explicit consent, with revision/idempotency safeguards. One binding per origin/browser-storage context; unlimited browsers per identity.

**Boundary:** Participant identity/tag integration is for session scoring only. No durable high scores or anti-cheat/server-authenticated scoring claim. Invitation/browser credentials stay outside SignalR and game records.

### 2026-10-04T23:42:21.863-07:00: Menu layout, brightness, and spacing

**Scope:** Solo is the reference for 32px native-text buttons, bright-white enabled labels, and a distinct disabled state. Vertical gaps are 20% tighter while button size and horizontal gaps remain unchanged. Landscape uses equal-width columns aligned top/bottom: device controls top-right, invitation pair bottom-right, Solo with play actions left. Portrait flow is preserved. Create fills one row; Leave and Start/Enter divide that row side-by-side. Regional Create destinations wrap to an ellipsized second line while accessible names retain the full destination.

**Boundary:** The 512 projected layout-state combinations are presentation coverage, not empirical multi-region deployment measurements.

### 2026-10-04T23:42:21.863-07:00: Deployment, authentication, and privacy boundary

**Scope:** Development uses an atomic JSON identity store; Azure uses Table Storage through each app's system-managed identity. Production regions share the identity store; preview stores remain isolated; gameplay sessions remain process-local. Strict identity-origin validation uses exact deployed HTTPS origins behind ingress, not wildcard origins or blanket forwarded-header trust. Deployment remains OIDC without a deployment client secret; identity storage needs no GitHub storage credential. Required deployment role-assignment permission is documented, not changed by this checkpoint.

**Boundary:** Custom-domain inputs and all three certificate references are stored as repository secrets; derived hostnames are private by correlation and must stay out of public/non-log surfaces. Public checkpoint evidence uses GitHub PR/run URLs only; no actual domains, deployment identifiers, certificate values, invitation/browser capabilities, or payload data are recorded. Existing TLS is unrelated to player identity. Legacy certificate variables were retained for older workflow refs; deletion requires a separate consumer check and is not authorized here.
