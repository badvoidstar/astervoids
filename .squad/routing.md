# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture, ticket triage, or cross-system review | Lead | Contract changes, scoped work plans, PR reviews |
| Product/game ideas, new player flows, or non-mechanical UX/input changes before implementation | Designer | Explore options and player impact; pair with Lead for feasibility before Frontend implements |
| Gameplay, Canvas UI, or game-specific adapters | Frontend | `index.html`, picker UX, entity adapters |
| Realtime server or generic transport contracts | Backend | SignalR hubs, session/object services, MessagePack DTOs |
| Regression coverage or playable verification | Tester | C# tests, Node tests, multiplayer scenarios |
| CI/CD, deployment, previews, or Bicep | Infra | GitHub Actions, Azure Container Apps, infrastructure |
| Claim verification or pre-mortems | Fact Checker | Evidence checks, design challenges |
| RAI, privacy, or high-signal safety review | Rai | Secrets, injection, public content |
| Learning review due, observed agent/tool version or capability change, or explicit learning request | Lead | "Review available practices", "learn from this agent"; use `.github\skills\learning-review\SKILL.md` |
| Useful technique, correction, or substantive observable work outcome | Lead | Evaluate one bounded candidate through reflect; Scribe retains only approved learnings |

Preset installation adds concrete routes for the configured team. Add or edit rows
here only when their agent names also exist in the casting registry.

## Friendly-Name Resolution

| Friendly Name | Canonical Member | Examples |
|---------------|------------------|----------|
| Alex | Lead | Alex, review this plan |
| Maya | Designer | Maya, explore this player flow |
| Jamie | Frontend | Jamie, implement the agreed Canvas interaction |
| Sam | Backend | Sam, review the transport contract |
| Casey | Tester | Casey, verify these acceptance criteria |
| Jordan | Infra | Jordan, review the deployment plan |
| Morgan | Scribe | Morgan, record the approved learning |
| Quinn | Fact Checker | Quinn, verify this claim |

Before work-type routing, resolve an explicitly addressed friendly name through
the roster's Aliases column and the friendly-name table above. Match a whole name
case-insensitively, not substrings or incidental mentions inside artifacts.
For example, "Maya, explore this idea" routes to **Designer** (`designer`), not to
a new agent named `maya`. Canonical names and role-based requests still work.
If addressing multiple members, follow the existing multi-agent routing rules;
ask rather than guess if a name is ambiguous.

Keep conversational aliases outside the Routing Table: Ralph consumes that table
for issue triage and deliberately excludes Scribe and Ralph from its assignable
roster. Conversational dispatch to Morgan remains a coordinator responsibility,
not a new issue-assignment route.

Use friendly name + explicit role in user-facing conversation, but keep the
canonical registry ID for dispatch and the canonical charter/history paths,
issue labels, and ceremony participants. Morgan and Quinn resolve to **Scribe**
and **Fact Checker**; their special-agent identities and responsibilities do not
change. Ralph, Rai, and `@copilot` have no replacement aliases. Do not change
`persistent_name`, add alias-named members, move history, or bypass reviewer gates.

## Pre-Implementation Idea Exploration

Route a new gameplay/product idea or a material change to player flows, interaction,
input, onboarding, or accessibility to **Designer before implementation**, even
when Frontend could implement it alone. Designer compares a small set of options
(including the simplest/no-change option), supplies testable acceptance criteria,
and hands the brief to Lead for feasibility and architecture checks. Frontend
implements the agreed direction; Tester uses the criteria. Small mechanical fixes
with no player-behavior change do not need this exploration. Use Design Review in
`.squad\ceremonies.md`; do not run duplicate design meetings.

## Active-Session Learning Dispatch

At the first routing opportunity in an active session, check the **Learning Review**
ceremony's due/changed conditions using runtime key `log/learning-review.md`.
No completed review means it is due; a deferred attempt follows the skill's
backoff rather than retrying every turn. Explicit requests route to Lead directly.
After substantive work, apply the **Learning Capture** ceremony only if there is
concrete new evidence or a correction; reuse an existing retrospective when it fits.
Include `.github\skills\learning-review\SKILL.md` in the routed task inputs.
Lead starts alone; involve Fact Checker only for an uncertain claim that matters,
and use the existing Scribe handoff rather than adding a research agent or fan-out.
If time, sources, or tools are unavailable, record deferred/unverified status when
possible and continue unrelated work. This workflow never grants new permissions.

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Lead |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, the **Lead** triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the "inbox" — untriaged issues waiting for Lead review.

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn the tester to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. The Lead handles all `squad` (base label) triage.
