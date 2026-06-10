import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the inline owner-side `ShipSendGate` send-on-change suppression in
// wwwroot/index.html (the game layer). Per repo convention (see
// send-on-change.test.mjs / ship-dead-reckoning.test.mjs) pure inline logic is
// re-implemented here and asserted, since index.html is not importable.
//
// ShipSendGate is the ship-physics counterpart to SendGate: under deterministic
// input-replay the receiver reproduces the ship's full non-linear motion by
// REPLAYING Ship.update() from the owner's last authoritative control intent, so
// the owner suppresses per-frame positional packets and re-anchors only on a
// discontinuity the replay can't predict from the last packet:
//   1. no baseline (creation / adoption)
//   2. control-intent change (thrustInput/brakeInput/thrusting flip, or any
//      turn field: mode, target, target-angle, magnitude, bias)
//   3. invulnerable change (respawn teleport + blink phase, fires per-frame
//      during the countdown)
//   4. heartbeat (>= HEARTBEAT_MS since last send)
//   plus force=true (the P1 immediate control-edge flush) always sends.
// Velocity / position are NOT triggers — the receiver derives them from replay.

const CONFIG = {
    SHIP_SEND_ON_CHANGE_ENABLED: true,
    SHIP_INPUT_REPLAY_ENABLED: true,
    SEND_ON_CHANGE_HEARTBEAT_MS: 250,
    SEND_ON_CHANGE_VEL_EPS: 1e-4,
    SEND_ON_CHANGE_ROT_EPS: 1e-4,
};

function makeClock() {
    let t = 1000;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
    };
}

// Mirror of the inline ShipSendGate. `deterministic` and `config` are injectable
// to exercise the always-send fall-throughs.
function makeGate(clock, deterministic = true, config = CONFIG) {
    return {
        baselines: new Map(),
        shouldSend(id, ship, force) {
            if (!config.SHIP_SEND_ON_CHANGE_ENABLED ||
                !config.SHIP_INPUT_REPLAY_ENABLED ||
                !deterministic) {
                return true;
            }
            const now = clock.now();
            const b = this.baselines.get(id);
            if (force || !b) { this._set(id, ship, now); return true; }
            const eps = config.SEND_ON_CHANGE_VEL_EPS;
            const rotEps = config.SEND_ON_CHANGE_ROT_EPS;
            let send = false;
            if (Math.abs((ship.thrustInput || 0) - b.thrustInput) > eps ||
                Math.abs((ship.brakeInput || 0) - b.brakeInput) > eps ||
                Math.abs((ship.turnTarget || 0) - b.turnTarget) > eps ||
                Math.abs((ship.turnMagnitude || 0) - b.turnMagnitude) > eps ||
                Math.abs((ship.turnBias || 0) - b.turnBias) > eps ||
                Math.abs((ship.turnTargetAngle || 0) - b.turnTargetAngle) > rotEps ||
                (ship.turnControlMode || 0) !== b.turnControlMode ||
                !!ship.thrusting !== b.thrusting ||
                (ship.invulnerable || 0) !== b.invulnerable) {
                send = true;
            } else if ((now - b.lastSentMs) >= config.SEND_ON_CHANGE_HEARTBEAT_MS) {
                send = true;
            }
            if (send) this._set(id, ship, now);
            return send;
        },
        _set(id, ship, now) {
            this.baselines.set(id, {
                thrustInput: ship.thrustInput || 0,
                brakeInput: ship.brakeInput || 0,
                turnControlMode: ship.turnControlMode || 0,
                turnTarget: ship.turnTarget || 0,
                turnTargetAngle: ship.turnTargetAngle || 0,
                turnMagnitude: ship.turnMagnitude || 0,
                turnBias: ship.turnBias || 0,
                thrusting: !!ship.thrusting,
                invulnerable: ship.invulnerable || 0,
                lastSentMs: now,
            });
        },
        remove(id) { this.baselines.delete(id); },
        clear() { this.baselines.clear(); },
    };
}

// A coasting ship: position/velocity drift every frame (friction decay + wrap)
// but no control intent changes. The gate must NOT see these as triggers.
function coastingShip(overrides = {}) {
    return {
        x: 0.5, y: 0.5, velocityX: 0.02, velocityY: 0,
        rotationSpeed: 0, angle: 0,
        thrustInput: 0, brakeInput: 0, thrusting: false,
        invulnerable: 0,
        turnControlMode: 0, turnTarget: 0, turnTargetAngle: 0,
        turnMagnitude: 0, turnBias: 0,
        ...overrides,
    };
}

// ── creation / first send ───────────────────────────────────────────────────
test('first call (no baseline) always sends to seed the receiver', () => {
    const gate = makeGate(makeClock());
    assert.equal(gate.shouldSend('ship', coastingShip(), false), true);
});

// ── steady-state suppression ────────────────────────────────────────────────
test('coasting ship is suppressed every frame between heartbeats despite drifting position/velocity', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    assert.equal(gate.shouldSend('ship', coastingShip(), false), true); // seed
    let x = 0.5;
    let vx = 0.02;
    let sends = 0;
    for (let i = 0; i < 10; i++) {
        clock.advance(16);
        x += vx;          // position drifts
        vx *= 0.99;       // friction decay changes velocity every frame
        if (gate.shouldSend('ship', coastingShip({ x, velocityX: vx }), false)) sends++;
    }
    assert.equal(sends, 0, 'position/velocity drift must not trigger a send');
});

test('ship holding steady thrust + turn (constant intent) is suppressed between heartbeats', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    const held = { thrustInput: 1, thrusting: true, turnTarget: 1, rotationSpeed: 0.12 };
    assert.equal(gate.shouldSend('ship', coastingShip(held), false), true); // seed
    let sends = 0;
    for (let i = 0; i < 10; i++) {
        clock.advance(16);
        // rotationSpeed/position would change as the ship turns, but intent is held
        if (gate.shouldSend('ship', coastingShip({ ...held, x: 0.5 + i * 0.01 }), false)) sends++;
    }
    assert.equal(sends, 0, 'a constant turn ramp the receiver replays must not re-send');
});

// ── control-intent change triggers ──────────────────────────────────────────
test('thrust on/off sends on the change frame only', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip(), false); // seed (no thrust)
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ thrustInput: 1, thrusting: true }), false), true);
    clock.advance(16);
    // held => suppressed
    assert.equal(gate.shouldSend('ship', coastingShip({ thrustInput: 1, thrusting: true }), false), false);
});

test('analog turnTarget change beyond epsilon sends; sub-epsilon jitter does not', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip({ turnTarget: 0.5 }), false); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ turnTarget: 0.7 }), false), true);
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ turnTarget: 0.7 + 1e-6 }), false), false);
});

test('turnControlMode flip (rate <-> target) always sends', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip({ turnControlMode: 0 }), false); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ turnControlMode: 1 }), false), true);
});

test('turnTargetAngle change (polar aim) sends, gated on the rotation epsilon', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip({ turnControlMode: 1, turnTargetAngle: 1.0 }), false); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ turnControlMode: 1, turnTargetAngle: 1.2 }), false), true);
});

test('turnMagnitude and turnBias changes each send', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip(), false); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ turnMagnitude: 0.5 }), false), true);
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ turnMagnitude: 0.5, turnBias: 0.3 }), false), true);
});

// ── invulnerable / respawn ──────────────────────────────────────────────────
test('invulnerable countdown sends every frame (keeps blink phase fresh) then settles when it reaches 0', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    // respawn: invulnerable jumps 0 -> 120 (teleport edge)
    gate.shouldSend('ship', coastingShip({ invulnerable: 0 }), false); // seed at 0
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ invulnerable: 120 }), false), true, 'respawn teleport edge');
    let sends = 0;
    for (let inv = 119; inv >= 0; inv--) {
        clock.advance(16);
        if (gate.shouldSend('ship', coastingShip({ invulnerable: inv }), false)) sends++;
    }
    // every decrementing frame is a change => a send, including the final ->0 edge
    assert.equal(sends, 120, 'each invulnerable decrement (incl. ->0) sends');
    // now stable at 0 => suppressed
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip({ invulnerable: 0 }), false), false);
});

// ── heartbeat ───────────────────────────────────────────────────────────────
test('heartbeat forces a send after HEARTBEAT_MS even with no intent change', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip(), false); // seed
    clock.advance(CONFIG.SEND_ON_CHANGE_HEARTBEAT_MS - 1);
    assert.equal(gate.shouldSend('ship', coastingShip(), false), false, 'just under heartbeat');
    clock.advance(1);
    assert.equal(gate.shouldSend('ship', coastingShip(), false), true, 'at heartbeat');
    // heartbeat re-baselines the clock
    clock.advance(10);
    assert.equal(gate.shouldSend('ship', coastingShip(), false), false);
});

// ── force / immediate edge ──────────────────────────────────────────────────
test('force=true always sends and re-baselines, even with identical intent', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('ship', coastingShip(), false); // seed
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip(), false), false, 'identical => suppressed without force');
    clock.advance(16);
    assert.equal(gate.shouldSend('ship', coastingShip(), true), true, 'force overrides suppression');
    // baseline clock advanced by the forced send => next heartbeat measured from here
    clock.advance(CONFIG.SEND_ON_CHANGE_HEARTBEAT_MS - 1);
    assert.equal(gate.shouldSend('ship', coastingShip(), false), false);
});

// ── disabled / non-deterministic fall-through ───────────────────────────────
test('always sends when deterministic mode is off (legacy wire unchanged)', () => {
    const clock = makeClock();
    const gate = makeGate(clock, /* deterministic */ false);
    for (let i = 0; i < 5; i++) {
        clock.advance(16);
        assert.equal(gate.shouldSend('ship', coastingShip(), false), true);
    }
});

test('always sends when SHIP_INPUT_REPLAY_ENABLED is off (receiver cannot reproduce friction)', () => {
    const clock = makeClock();
    const gate = makeGate(clock, true, { ...CONFIG, SHIP_INPUT_REPLAY_ENABLED: false });
    for (let i = 0; i < 5; i++) {
        clock.advance(16);
        assert.equal(gate.shouldSend('ship', coastingShip(), false), true);
    }
});

test('always sends when SHIP_SEND_ON_CHANGE_ENABLED is off', () => {
    const clock = makeClock();
    const gate = makeGate(clock, true, { ...CONFIG, SHIP_SEND_ON_CHANGE_ENABLED: false });
    for (let i = 0; i < 5; i++) {
        clock.advance(16);
        assert.equal(gate.shouldSend('ship', coastingShip(), false), true);
    }
});

// ── independence across ships ───────────────────────────────────────────────
test('baselines are per-ship; one ship changing does not flush another', () => {
    const clock = makeClock();
    const gate = makeGate(clock);
    gate.shouldSend('a', coastingShip(), false); // seed a
    gate.shouldSend('b', coastingShip(), false); // seed b
    clock.advance(16);
    assert.equal(gate.shouldSend('a', coastingShip({ thrustInput: 1 }), false), true);
    assert.equal(gate.shouldSend('b', coastingShip(), false), false);
});

// ── q8 wire round-trip for the unsigned inputs ──────────────────────────────
// thrustInput / brakeInput / turnMagnitude moved from q16s to q8 in schema id 5.
// q8 maps [0,1] -> round(v*255) -> /255. Confirm the endpoints and that the
// 1/255 resolution comfortably covers control-input fidelity needs.
function q8RoundTrip(v) {
    const q = Math.round(Math.max(0, Math.min(1, v)) * 255) & 0xff;
    return q / 255;
}

test('q8 round-trips unsigned control inputs across [0,1] within 1/510', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        assert.ok(Math.abs(q8RoundTrip(v) - v) <= 1 / 510, `v=${v}`);
    }
    assert.equal(q8RoundTrip(0), 0);
    assert.equal(q8RoundTrip(1), 1);
});
