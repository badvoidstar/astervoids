import { test } from 'node:test';
import assert from 'node:assert/strict';

// These mirror the inline deterministic-simulation helpers in
// wwwroot/index.html (the game layer). Per the repo convention (see
// config-overrides.test.mjs), pure inline logic is re-implemented here and
// asserted, since index.html is not a importable module.

// ── Mode normalization (mirrors normalizeSimMode) ───────────────────────────
const SIM_MODES = { LEGACY: 'legacy', DETERMINISTIC: 'deterministic' };
const VALID_SIM_MODES = new Set(Object.values(SIM_MODES));
function normalizeSimMode(raw) {
    if (typeof raw === 'string') {
        const n = raw.toLowerCase();
        if (VALID_SIM_MODES.has(n)) return n;
    }
    return SIM_MODES.LEGACY;
}

// ── Seeded RNG (mirrors makeSeededRandom + simRng) ──────────────────────────
function makeSeededRandom(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Render interpolation (mirrors interpNormalized / interpAngle) ───────────
function interpNormalized(prev, curr, alpha) {
    let d = curr - prev;
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;
    let v = prev + d * alpha;
    v -= Math.floor(v);
    return v;
}
function interpAngle(prev, curr, alpha) {
    let d = curr - prev;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return prev + d * alpha;
}

// ── Fixed-timestep accumulator (mirrors gameLoop's deterministic branch) ────
function stepFixed(accumulatorMs, elapsed, stepMs, maxSteps, maxAccum) {
    accumulatorMs = Math.min(accumulatorMs + elapsed, maxAccum);
    let steps = 0;
    while (accumulatorMs >= stepMs && steps < maxSteps) {
        accumulatorMs -= stepMs;
        steps++;
    }
    if (steps === maxSteps) accumulatorMs = 0;
    const alpha = stepMs > 0 ? Math.min(accumulatorMs / stepMs, 1) : 1;
    return { steps, accumulatorMs, alpha };
}

// ── Dead-reckoning integrator (mirrors DeadReckon.getReckoned) ──────────────
function reckon(state, nowPerf, stepMs, maxFrames, velToDeltaX, velToDeltaY) {
    let frames = stepMs > 0 ? (nowPerf - state.recvPerf) / stepMs : 0;
    if (!(frames > 0)) frames = 0;
    if (frames > maxFrames) frames = maxFrames;
    const out = {
        x: state.x,
        y: state.y,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        rotationSpeed: state.rotationSpeed,
    };
    if (frames > 0) {
        out.x = state.x + velToDeltaX(state.velocityX) * frames;
        out.y = state.y + velToDeltaY(state.velocityY) * frames;
    }
    if (state.angle !== null && state.angle !== undefined) {
        out.angle = state.angle + state.rotationSpeed * frames;
    }
    return out;
}

// ───────────────────────────────── tests ───────────────────────────────────

test('normalizeSimMode: accepts known modes case-insensitively, defaults legacy', () => {
    assert.equal(normalizeSimMode('deterministic'), 'deterministic');
    assert.equal(normalizeSimMode('DETERMINISTIC'), 'deterministic');
    assert.equal(normalizeSimMode('legacy'), 'legacy');
    assert.equal(normalizeSimMode('nonsense'), 'legacy');
    assert.equal(normalizeSimMode(undefined), 'legacy');
    assert.equal(normalizeSimMode(42), 'legacy');
});

test('seeded RNG: same seed yields identical sequence (reproducible)', () => {
    const a = makeSeededRandom(12345);
    const b = makeSeededRandom(12345);
    for (let i = 0; i < 100; i++) {
        assert.equal(a(), b());
    }
});

test('seeded RNG: different seeds diverge', () => {
    const a = makeSeededRandom(1);
    const b = makeSeededRandom(2);
    let differing = 0;
    for (let i = 0; i < 50; i++) {
        if (a() !== b()) differing++;
    }
    assert.ok(differing > 40, 'expected most draws to differ across seeds');
});

test('seeded RNG: outputs are within [0, 1)', () => {
    const r = makeSeededRandom(999);
    for (let i = 0; i < 1000; i++) {
        const v = r();
        assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
    }
});

test('seeded RNG: seed 0 is treated as 1 (no zero-lock)', () => {
    const a = makeSeededRandom(0);
    const b = makeSeededRandom(1);
    assert.equal(a(), b());
});

test('interpNormalized: midpoint without wrap', () => {
    assert.ok(Math.abs(interpNormalized(0.2, 0.4, 0.5) - 0.3) < 1e-9);
});

test('interpNormalized: takes short way across wrap boundary 0.95 -> 0.05', () => {
    // Forward wrap: prev 0.95, curr 0.05 (crossed 1.0). Short path increases
    // through 1.0; at alpha 0.25 we land at 0.975.
    const v = interpNormalized(0.95, 0.05, 0.25);
    assert.ok(Math.abs(v - 0.975) < 1e-9, `got ${v}`);
});

test('interpNormalized: short way across wrap boundary 0.05 -> 0.95', () => {
    // Backward wrap: prev 0.05, curr 0.95. Short path decreases toward 0.0;
    // at alpha 0.25 we land at 0.025.
    const v = interpNormalized(0.05, 0.95, 0.25);
    assert.ok(Math.abs(v - 0.025) < 1e-9, `got ${v}`);
});

test('interpNormalized: result always re-wrapped into [0,1)', () => {
    for (let p = 0; p < 1; p += 0.13) {
        for (let c = 0; c < 1; c += 0.17) {
            const v = interpNormalized(p, c, 0.5);
            assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
        }
    }
});

test('interpAngle: shortest arc across -pi/pi seam', () => {
    const prev = 3.0;          // ~172deg
    const curr = -3.0;         // ~-172deg; short arc is +0.28 rad through pi
    const v = interpAngle(prev, curr, 0.5);
    // Halfway along the short (+) arc from 3.0: 3.0 + 0.5*0.28319 ≈ 3.1416
    assert.ok(Math.abs(Math.atan2(Math.sin(v), Math.cos(v))) > 3.0,
        `expected near pi, got ${v}`);
});

test('interpAngle: alpha 0 and 1 return endpoints', () => {
    assert.ok(Math.abs(interpAngle(0.4, 1.2, 0) - 0.4) < 1e-9);
    assert.ok(Math.abs(interpAngle(0.4, 1.2, 1) - 1.2) < 1e-9);
});

test('stepFixed: 16.67ms elapsed at 60Hz yields exactly one step', () => {
    const stepMs = 1000 / 60;
    const r = stepFixed(0, stepMs, stepMs, 5, 250);
    assert.equal(r.steps, 1);
    assert.ok(Math.abs(r.accumulatorMs) < 1e-9);
    assert.ok(Math.abs(r.alpha) < 1e-9);
});

test('stepFixed: partial frame produces zero steps and fractional alpha', () => {
    const stepMs = 1000 / 60;
    const r = stepFixed(0, stepMs / 2, stepMs, 5, 250);
    assert.equal(r.steps, 0);
    assert.ok(Math.abs(r.alpha - 0.5) < 1e-9);
});

test('stepFixed: accumulates leftover across frames', () => {
    const stepMs = 1000 / 60;
    // Two 10ms frames = 20ms total -> one step (16.67ms), ~3.33ms leftover.
    let acc = 0;
    let r = stepFixed(acc, 10, stepMs, 5, 250);
    assert.equal(r.steps, 0);
    r = stepFixed(r.accumulatorMs, 10, stepMs, 5, 250);
    assert.equal(r.steps, 1);
    assert.ok(r.accumulatorMs > 0 && r.accumulatorMs < stepMs);
});

test('stepFixed: clamps to maxSteps and drops backlog (spiral-of-death guard)', () => {
    const stepMs = 1000 / 60;
    // A huge stall: 1000ms but capped at maxAccum 250ms -> 15 steps worth, but
    // maxSteps=5 caps it and the remainder is dropped.
    const r = stepFixed(0, 1000, stepMs, 5, 250);
    assert.equal(r.steps, 5);
    assert.equal(r.accumulatorMs, 0);
    assert.equal(r.alpha, 0);
});

test('reckon: zero elapsed returns the authoritative snapshot unchanged', () => {
    const stepMs = 1000 / 60;
    const state = { x: 0.5, y: 0.5, angle: 1.0, velocityX: 0.1, velocityY: -0.2, rotationSpeed: 0.05, recvPerf: 1000 };
    const out = reckon(state, 1000, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.equal(out.x, 0.5);
    assert.equal(out.y, 0.5);
    assert.equal(out.angle, 1.0);
});

test('reckon: integrates by constant velocity/rotation over elapsed frames', () => {
    const stepMs = 1000 / 60;
    const state = { x: 0.5, y: 0.5, angle: 0.0, velocityX: 1, velocityY: 2, rotationSpeed: 0.1, recvPerf: 0 };
    // 3 frames elapsed.
    const out = reckon(state, 3 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.ok(Math.abs(out.x - (0.5 + 0.01 * 1 * 3)) < 1e-9);
    assert.ok(Math.abs(out.y - (0.5 + 0.01 * 2 * 3)) < 1e-9);
    assert.ok(Math.abs(out.angle - (0.1 * 3)) < 1e-9);
});

test('reckon: clamps to maxFrames so packet loss cannot fling a replica away', () => {
    const stepMs = 1000 / 60;
    const state = { x: 0, y: 0, angle: null, velocityX: 1, velocityY: 0, rotationSpeed: 0, recvPerf: 0 };
    // 1000 frames elapsed but clamp at 30.
    const out = reckon(state, 1000 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.ok(Math.abs(out.x - (0.01 * 1 * 30)) < 1e-9);
    assert.ok(!('angle' in out), 'angle omitted when state.angle is null');
});

test('reckon: a fresh authoritative packet snaps (resets recvPerf baseline)', () => {
    const stepMs = 1000 / 60;
    // Reckoned far from snapshot...
    let state = { x: 0, y: 0, angle: 0, velocityX: 1, velocityY: 0, rotationSpeed: 0, recvPerf: 0 };
    const drifted = reckon(state, 10 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.ok(drifted.x > 0);
    // New packet arrives: snapshot replaced, recvPerf reset to "now".
    state = { x: 0.42, y: 0.7, angle: 0.0, velocityX: 1, velocityY: 0, rotationSpeed: 0, recvPerf: 10 * stepMs };
    const snapped = reckon(state, 10 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.equal(snapped.x, 0.42);
    assert.equal(snapped.y, 0.7);
});
