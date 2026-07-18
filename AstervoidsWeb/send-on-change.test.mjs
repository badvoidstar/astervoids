import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBallisticGate } = require('./wwwroot/js/replication-send-policy.js');

// Mirrors the inline owner-side `SendGate` send-on-change suppression in
// wwwroot/index.html (the game layer). Per repo convention (see
// deterministic-sim.test.mjs / config-overrides.test.mjs) pure inline logic is
// re-implemented here and asserted, since index.html is not importable.
//
// SendGate decides, on the OWNER, whether a fresh authoritative packet for a
// ballistic object would improve the remote's exact dead-reckoned prediction.
// It suppresses redundant per-frame re-anchors and forces a send only on:
//   1. no baseline (creation / ownership adoption)
//   2. velocity / rotationSpeed change beyond epsilon
//   3. wrap jump (single-frame position delta > WRAP_JUMP)
//   4. heartbeat (>= HEARTBEAT_MS since last send)

const CONFIG = {
    SEND_ON_CHANGE_ENABLED: true,
    SEND_ON_CHANGE_HEARTBEAT_MS: 250,
    SEND_ON_CHANGE_WRAP_JUMP: 0.5,
    SEND_ON_CHANGE_VEL_EPS: 1e-4,
    SEND_ON_CHANGE_ROT_EPS: 1e-4,
};

// Test double for performance.now(): a controllable monotonic clock.
function makeClock() {
    let t = 1000;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
    };
}

function makeGate(clock, deterministic = true, config = CONFIG) {
    return createBallisticGate({
        config,
        isDeterministic: () => deterministic,
        nowMs: clock.now
    });
}

// ── creation / first send ───────────────────────────────────────────────────
test('first call (no baseline) always sends to seed the receiver', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    assert.equal(gate.shouldSend('a', 0.5, 0.5, 0, 0.01, 0, 0.02), true);
});

// ── steady-state suppression ────────────────────────────────────────────────
test('constant-velocity object is suppressed every frame between heartbeats', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    // seed
    assert.equal(gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0), true);
    // advance ~16ms/frame for ~10 frames; constant velocity => all suppressed
    let x = 0.0;
    let sends = 0;
    for (let i = 0; i < 10; i++) {
        clock.advance(16);
        x += 0.01; // < WRAP_JUMP, constant velocity
        if (gate.shouldSend('a', x, 0.5, 0, 0.02, 0, 0)) sends++;
    }
    assert.equal(sends, 0, 'no extra sends within one heartbeat window');
});

// ── heartbeat ───────────────────────────────────────────────────────────────
test('heartbeat forces a send once HEARTBEAT_MS has elapsed', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0); // seed at t=1000
    clock.advance(CONFIG.SEND_ON_CHANGE_HEARTBEAT_MS - 1);
    assert.equal(gate.shouldSend('a', 0.1, 0.5, 0, 0.02, 0, 0), false,
        'just under the heartbeat: still suppressed');
    clock.advance(1);
    assert.equal(gate.shouldSend('a', 0.11, 0.5, 0, 0.02, 0, 0), true,
        'at the heartbeat boundary: send');
});

test('heartbeat stays strictly below the receiver dead-reckon clamp window', () => {
    // The receiver freezes after DEADRECKON_MAX_FRAMES at TARGET_FPS. The
    // heartbeat must fire well before that so a straight-flying object never
    // hits the clamp.
    const DEADRECKON_MAX_FRAMES = 30;
    const TARGET_FPS = 60;
    const clampMs = DEADRECKON_MAX_FRAMES * (1000 / TARGET_FPS); // 500ms
    assert.ok(CONFIG.SEND_ON_CHANGE_HEARTBEAT_MS < clampMs);
    // and with comfortable transit headroom (at least 2x margin)
    assert.ok(CONFIG.SEND_ON_CHANGE_HEARTBEAT_MS <= clampMs / 2);
});

// ── velocity change ─────────────────────────────────────────────────────────
test('velocity change forces an immediate re-anchor', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.05, 0, 0), true,
        'velocityX changed beyond epsilon');
});

test('rotationSpeed change forces an immediate re-anchor', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0.01); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0.001, 0.02, 0, 0.5), true,
        'rotationSpeed changed beyond epsilon');
});

test('sub-epsilon velocity float drift does NOT trigger a send', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.02 + 1e-9, 0, 0), false);
});

// ── wrap discontinuity ──────────────────────────────────────────────────────
test('wrap-seam jump forces a send so the receiver re-anchors', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.98, 0.5, 0, 0.02, 0, 0); // seed near right edge
    clock.advance(16);
    // wrapNormalized snaps ~0.99 -> ~0.0 : a single-frame delta near 1.0
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.02, 0, 0), true,
        'large single-frame jump (wrap) detected');
});

test('wrap detection compares against the immediately previous frame while suppressing', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.90, 0.5, 0, 0.02, 0, 0); // seed
    // suppressed frames advance prevX each step
    clock.advance(16); assert.equal(gate.shouldSend('a', 0.92, 0.5, 0, 0.02, 0, 0), false);
    clock.advance(16); assert.equal(gate.shouldSend('a', 0.94, 0.5, 0, 0.02, 0, 0), false);
    clock.advance(16); assert.equal(gate.shouldSend('a', 0.96, 0.5, 0, 0.02, 0, 0), false);
    // now wrap: jump from 0.96 (prev frame) to ~0.0
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0), true);
});

// ── mode gating (buffered unaffected) ───────────────────────────────────────
test('buffered mode always sends (suppression is deterministic-only)', () => {
    const clock = makeClock();
    const gate = makeGate(clock, /* deterministic */ false);
    assert.equal(gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0), true);
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.02, 0, 0), true);
    assert.equal(gate.baselines.size, 0, 'buffered path never tracks baselines');
});

test('disabling SEND_ON_CHANGE_ENABLED always sends', () => {
    const clock = makeClock();
    const config = { ...CONFIG, SEND_ON_CHANGE_ENABLED: false };
    const gate = makeGate(clock, true, config);
    assert.equal(gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0), true);
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.02, 0, 0), true);
});

// ── lifecycle ───────────────────────────────────────────────────────────────
test('remove() forces a fresh seeding send on next call (adoption / re-own)', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.02, 0, 0), false);
    gate.remove('a');
    assert.equal(gate.shouldSend('a', 0.02, 0.5, 0, 0.02, 0, 0), true,
        'no baseline after remove => send');
});

test('clear() wipes all baselines', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0, 0, 0, 0, 0, 0);
    gate.shouldSend('b', 0, 0, 0, 0, 0, 0);
    assert.equal(gate.baselines.size, 2);
    gate.clear();
    assert.equal(gate.baselines.size, 0);
});

test('independent objects keep independent baselines', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', 0.0, 0.5, 0, 0.02, 0, 0); // seed a
    gate.shouldSend('b', 0.0, 0.2, 0, 0.0, 0.03, 0); // seed b
    clock.advance(16);
    // a coasts (suppressed), b changes velocity (send)
    assert.equal(gate.shouldSend('a', 0.01, 0.5, 0, 0.02, 0, 0), false);
    assert.equal(gate.shouldSend('b', 0.0, 0.21, 0, 0.0, 0.06, 0), true);
});
