# Squad Team

> astervoids

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Lead | Lead | .squad/agents/lead/charter.md | 🏗️ Active |
| Frontend | Frontend Dev | .squad/agents/frontend/charter.md | ⚛️ Active |
| Backend | Backend Dev | .squad/agents/backend/charter.md | 🔧 Active |
| Tester | QA Engineer | .squad/agents/tester/charter.md | 🧪 Active |
| Infra | DevOps | .squad/agents/infra/charter.md | ⚙️ Active |
| Scribe | Session Logger | .squad/agents/scribe/charter.md | 📋 Always on |
| Ralph | Work Monitor | .squad/agents/ralph/charter.md | 🔄 Always on |
| Rai | RAI Reviewer | .squad/agents/Rai/charter.md | 🛡️ Always on |
| Fact Checker | Fact Checker | .squad/agents/fact-checker/charter.md | 🔍 Always on |


## Coding Agent

<!-- copilot-auto-assign: false -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- Bug fixes with clear reproduction steps
- Test coverage (adding missing tests, fixing flaky tests)
- Lint/format fixes and code style cleanup
- Dependency updates and version bumps
- Small isolated features with clear specs
- Boilerplate/scaffolding generation
- Documentation fixes and README updates

**🟡 Needs review — route to @copilot but flag for squad member PR review:**
- Medium features with clear specs and acceptance criteria
- Refactoring with existing test coverage
- API endpoint additions following established patterns
- Migration scripts with well-defined schemas

**🔴 Not suitable — route to squad member instead:**
- Architecture decisions and system design
- Multi-system integration requiring coordination
- Ambiguous requirements needing clarification
- Security-critical changes (auth, encryption, access control)
- Performance-critical paths requiring benchmarking
- Changes requiring cross-team discussion

## Project Context

- **Project:** astervoids
- **Owner:** badvoidstar
- **Purpose:** An Asteroids-like HTML5 website with single-player and multiplayer modes.
- **Stack:** ASP.NET Core 10/C#, SignalR with MessagePack, classic JavaScript and HTML5 Canvas, Azure Container Apps/Bicep, xUnit, and Node's built-in test runner.
- **Created:** 2026-09-21T20:10:23.757-07:00

## Architecture Guardrails

- Keep the backend and its frontend-facing interface game-agnostic.
- Keep the game utility layer reusable and non-game-specific.
- Preserve the documented layering in `ARCHITECTURE.md` when planning or reviewing changes.
