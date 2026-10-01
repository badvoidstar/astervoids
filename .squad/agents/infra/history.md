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

### 2026-09-25T13:55:03.515-07:00: Named-team review

- Jordan independently repaired the rejected browser guard; Casey re-approved. Observed evidence: fetch relaying broke WebSockets, so the final shared Chromium guard retained native streaming/WebSockets and prevented denied-origin contact under a documented one-guarded-page contract. Remote runs exclude local fixtures; revision was limited to smoke tooling/tests and delivery documentation.
