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
