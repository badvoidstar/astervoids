# Astervoids Game Implementation Plan (Snapshot: January 9, 2026)

## High-Level Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  astervoids.html                                                 │
├─────────────────────────────────────────────────────────────────┤
│  <!DOCTYPE html>                                                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ <head>                                                    │  │
│  │   <style> Canvas centering, background, HUD styling       │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ <body>                                                    │  │
│  │   <canvas id="game">                                      │  │
│  │   <script>                                                │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ① CONFIG (constants object)                         │ │  │
│  │   │   • SHIP_SIZE, TURN_SPEED, THRUST                   │ │  │
│  │   │   • BULLET_SPEED, BULLET_LIFETIME                   │ │  │
│  │   │   • ASTEROID_SIZES, ASTEROID_SPEED                  │ │  │
│  │   │   • STARTING_LIVES, POINTS_PER_SIZE                 │ │  │
│  │   │   • WAVE_ASTEROID_INCREMENT, MAX_SPEED_MULTIPLIER   │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ② CLASSES                                           │ │  │
│  │   │                                                     │ │  │
│  │   │   Ship ─────────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, angle, velocity                     │   │ │  │
│  │   │   │ • vertices[], invulnerable, thrust          │   │ │  │
│  │   │   │ • update(), draw(), getVertices(), shoot()  │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   │                                                     │ │  │
│  │   │   Asteroid ─────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, velocity, size, vertices[]          │   │ │  │
│  │   │   │ • update(), draw(), generateShape()         │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   │                                                     │ │  │
│  │   │   Bullet ───────────────────────────────────────┐   │ │  │
│  │   │   │ • x, y, velocity, lifetime                  │   │ │  │
│  │   │   │ • update(), draw(), isExpired()             │   │ │  │
│  │   │   └─────────────────────────────────────────────┘   │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ③ HELPER FUNCTIONS                                  │ │  │
│  │   │   • pointInPolygon(point, vertices)                 │ │  │
│  │   │   • circlePolygonCollision(circle, polygon)         │ │  │
│  │   │   • wrapPosition(entity, canvas)                    │ │  │
│  │   │   • spawnAsteroidAwayFromShip(ship)                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ④ GAME STATE                                        │ │  │
│  │   │   • ship, astervoids[], bullets[]                    │ │  │
│  │   │   • score, lives, wave, state (enum)                │ │  │
│  │   │   • keys{} (input tracking)                         │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑤ GAME FUNCTIONS                                    │ │  │
│  │   │   • init() — reset state, spawn wave                │ │  │
│  │   │   • spawnWave(waveNumber) — create astervoids        │ │  │
│  │   │   • handleInput() — read keys{}, apply to ship      │ │  │
│  │   │   • checkCollisions() — bullets↔astervoids, ship↔ast │ │  │
│  │   │   • splitAsteroid(asteroid) — spawn smaller pieces  │ │  │
│  │   │   • respawnShip() — invulnerability timer           │ │  │
│  │   │   • drawHUD() — score, lives, wave, messages        │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑥ GAME LOOP                                         │ │  │
│  │   │                                                     │ │  │
│  │   │   gameLoop(timestamp) {                             │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ handleInput()│                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ UPDATE PHASE │                              │ │  │
│  │   │       │ ship.update()│                              │ │  │
│  │   │       │ astervoids[]  │                              │ │  │
│  │   │       │ bullets[]    │                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ checkCollisions()│                          │ │  │
│  │   │       └──────┬───────────┘                          │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────────┐                          │ │  │
│  │   │       │ checkWaveComplete│ → spawnWave() if empty   │ │  │
│  │   │       └──────┬───────────┘                          │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       ┌──────────────┐                              │ │  │
│  │   │       │ RENDER PHASE │                              │ │  │
│  │   │       │ clearCanvas()│                              │ │  │
│  │   │       │ ship.draw()  │                              │ │  │
│  │   │       │ astervoids[]  │                              │ │  │
│  │   │       │ bullets[]    │                              │ │  │
│  │   │       │ drawHUD()    │                              │ │  │
│  │   │       └──────┬───────┘                              │ │  │
│  │   │              ▼                                      │ │  │
│  │   │       requestAnimationFrame(gameLoop)               │ │  │
│  │   │   }                                                 │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │ ⑦ EVENT LISTENERS & INIT                            │ │  │
│  │   │   • keydown → keys[e.code] = true                   │ │  │
│  │   │   • keyup   → keys[e.code] = false                  │ │  │
│  │   │   • init() called on load                           │ │  │
│  │   │   • requestAnimationFrame(gameLoop) to start        │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  │   </script>                                               │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagram

```
    INPUTS                    GAME STATE                   OUTPUTS
 ┌──────────┐              ┌─────────────┐              ┌──────────┐
 │ Keyboard │─────────────▶│   keys{}    │              │  Canvas  │
 │ Events   │              └──────┬──────┘              │ Rendering│
 └──────────┘                     │                     └────▲─────┘
                                  ▼                          │
                         ┌────────────────┐                  │
                         │  handleInput() │                  │
                         └───────┬────────┘                  │
                                 ▼                           │
 ┌─────────┐    update    ┌─────────────┐     draw     ┌─────┴─────┐
 │  Ship   │◀────────────▶│             │─────────────▶│  Vector   │
 ├─────────┤              │  Game Loop  │              │  Lines    │
 │Astervoids│◀────────────▶│             │─────────────▶│  (stroke) │
 ├─────────┤              │             │              └───────────┘
 │ Bullets │◀────────────▶│             │                    │
 └─────────┘              └──────┬──────┘                    ▼
       ▲                         │                     ┌───────────┐
       │         ┌───────────────┘                     │    HUD    │
       │         ▼                                     │Score/Lives│
       │  ┌─────────────────┐                          │   /Wave   │
       └──│checkCollisions()│                          └───────────┘
          └────────┬────────┘
                   │ on hit
                   ▼
          ┌─────────────────┐
          │ splitAsteroid() │──▶ points += SIZE_SCORE
          │ or loseLife()   │──▶ lives -= 1
          └─────────────────┘
```

---

*This is a snapshot of the implementation plan and may not reflect subsequent changes.*
