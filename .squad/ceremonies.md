# Ceremonies

> Team meetings that happen before or after work. Each squad configures their own.

## Design Review

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | before |
| **Condition** | multi-agent task involving 2+ agents modifying shared systems, OR a new product/game idea or non-mechanical player-facing flow, interaction, input, or accessibility change before implementation |
| **Facilitator** | lead |
| **Participants** | all-relevant |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. Review the task and requirements
2. Agree on interfaces and contracts between components
3. Identify risks and edge cases
4. Assign action items

**Player-facing work:** Include Designer for option exploration and Lead for
feasibility. Record the player problem, simplest/no-change option, alternatives,
input/mobile/accessibility impact, chosen direction, and testable acceptance
criteria before Frontend implements. A small mechanical fix does not trigger this
additional exploration (the original shared-system condition still applies).
Fold this into the same Design Review rather than holding a second meeting.

---

## Retrospective

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | after |
| **Condition** | build failure, test failure, or reviewer rejection |
| **Facilitator** | lead |
| **Participants** | all-involved |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. What happened? (facts only)
2. Root cause analysis
3. What should change?
4. Action items for next iteration


---

## Retrospective with Enforcement

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | weekly |
| **Condition** | No *retrospective* log in .squad/log/ within the last 7 days |
| **Facilitator** | lead |
| **Participants** | all |
| **Time budget** | focused |
| **Enabled** | yes |
| **Enforcement skill** | retro-enforcement |

**Agenda:**
1. What shipped this week? (closed issues, merged PRs)
2. What did not ship? (open issues, blockers)
3. Root cause on any failures
4. Action items -- each MUST become a GitHub Issue labeled retro-action

**Coordinator integration:**
At round start, call Test-RetroOverdue (see skill retro-enforcement). If overdue, run this ceremony before the work queue.

**Why GitHub Issues, not markdown:**
Production data: 0% completion across 6 retros using markdown checklists, 100% after switching to GitHub Issues.

---

## Learning Review

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | before |
| **Condition** | active session and review is due (no completed review or 7 days since the last complete check, respecting deferred retry timing), OR a newly observed agent/tool version or capability change |
| **Facilitator** | lead |
| **Participants** | lead |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. Read `.github\skills\learning-review\SKILL.md` and runtime key `log/learning-review.md`; deduplicate the trigger.
2. Within five minutes, check at most three relevant evidence items from official Copilot/Squad sources and capabilities actually exposed in this session.
3. Evaluate at most one candidate, its project fit and tradeoffs; request Fact Checker only if a consequential claim needs verification.
4. Show any proposed adoption for approval; have Scribe append minimal check status/evidence using state tools. Only the coordinator records accepted team decisions.

**Coordinator integration:** Evaluate at the first routing opportunity in an active
session, at most once automatically per session. An explicit learning request can
invoke the same bounded workflow. This is not a timer, daemon, exhaustive discovery,
or permission to run upgrades. If blocked or out of budget, defer without holding up
unrelated work; do not label the check complete. Preserve the existing ceremony cooldown.

---

## Learning Capture

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | after |
| **Condition** | substantive observable work reveals a useful technique, a user correction, or a contradicted prior practice not already captured |
| **Facilitator** | lead |
| **Participants** | lead |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. Use `.github\skills\learning-review\SKILL.md` and the existing reflect skill on one accessible outcome; no historical scraping.
2. Distinguish an observation from a validated improvement, including quality/cost/latency tradeoffs.
3. Show proposed changes and seek approval before retaining a learning; Scribe records approved history, and the coordinator records accepted team decisions.

**Coordinator integration:** Reuse the relevant existing retrospective and its Scribe
handoff when triggered by the same event. No extra mandatory fan-out or source review;
an observation-only capture does not reset the seven-day official/capability review clock.
Deduplicate the evidence reference, honor cooldown, and keep unrelated work moving.
