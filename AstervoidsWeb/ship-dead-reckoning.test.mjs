import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the inline ship dead-reckoning improvements in wwwroot/index.html
// (the game layer). Per repo convention (see send-on-change.test.mjs /
// deterministic-sim.test.mjs) pure inline logic is re-implemented here and
// asserted, since index.html is not importable. Three features are covered:
//
//   P1  ShipControlGate.isEdge — scheme-agnostic detection of overshoot-critical
//       control edges (rotation start/stop/reversal, thrust on/off, brake
//       on/off) that trigger an immediate, throttle-bypassing send.
//   P2  DeadReckon angular-projection clamp — ships bound their forward angular
//       extrapolation to DEADRECKON_ANGULAR_MAX_FRAMES; ballistic spinners do not.
//   P3  Physics input-replay — a remote that seeds from an authoritative packet
//       (pose + velocity + rotationSpeed + control intent) and replays
//       Ship.update() lands where the owner did for rate controls.
//   P3b Target-heading replay — polar touch remotes recompute the owner's
//       heading-alignment turn each replay step instead of projecting a stale
//       rotationSpeed across latency.

// ----------------------------------------------------------------------------
// P1: ShipControlGate.isEdge mirror
// ----------------------------------------------------------------------------

const ROT_EPS = 1e-4;

function makeShipControlGate() {
    return {
        last: null,
        EPS: 1e-4,
        isEdge(ship) {
            const rotEps = ROT_EPS;
            const eps = this.EPS;
            const rs = ship.rotationSpeed || 0;
            const th = ship.thrustInput || 0;
            const br = ship.brakeInput || 0;
            const thrusting = !!ship.thrusting;
            const p = this.last;
            this.last = { rs, th, br, thrusting };
            if (!p) return false;
            if ((Math.abs(rs) > rotEps) !== (Math.abs(p.rs) > rotEps)) return true;
            if (rs * p.rs < 0) return true;
            if (thrusting !== p.thrusting) return true;
            if ((th > eps) !== (p.th > eps)) return true;
            if ((br > eps) !== (p.br > eps)) return true;
            return false;
        },
        reset() { this.last = null; },
    };
}

test('P1: first sample only seeds the baseline (no edge)', () => {
    const g = makeShipControlGate();
    assert.equal(g.isEdge({ rotationSpeed: 0.12, thrustInput: 1, brakeInput: 0, thrusting: true }), false);
});

test('P1: rotation start and stop are edges; steady turn is not', () => {
    const g = makeShipControlGate();
    g.isEdge({ rotationSpeed: 0 });                 // seed
    assert.equal(g.isEdge({ rotationSpeed: 0.12 }), true,  'start');
    assert.equal(g.isEdge({ rotationSpeed: 0.12 }), false, 'sustained');
    assert.equal(g.isEdge({ rotationSpeed: 0 }), true,     'stop');
});

test('P1: rotation sign reversal without resting at zero is an edge', () => {
    const g = makeShipControlGate();
    g.isEdge({ rotationSpeed: 0.12 });
    assert.equal(g.isEdge({ rotationSpeed: -0.12 }), true);
});

test('P1: thrust flame flip is an edge', () => {
    const g = makeShipControlGate();
    g.isEdge({ thrusting: false });
    assert.equal(g.isEdge({ thrusting: true }), true);
    assert.equal(g.isEdge({ thrusting: true }), false);
    assert.equal(g.isEdge({ thrusting: false }), true);
});

test('P1: analog thrust/brake on<->off cross zero is an edge', () => {
    const g = makeShipControlGate();
    g.isEdge({ thrustInput: 0, brakeInput: 0 });
    assert.equal(g.isEdge({ thrustInput: 0.4 }), true,  'thrust on');
    assert.equal(g.isEdge({ thrustInput: 0.4 }), false, 'thrust steady');
    assert.equal(g.isEdge({ thrustInput: 0, brakeInput: 0.6 }), true, 'thrust off + brake on (either edge)');
});

test('P1: analog magnitude change WITHOUT a zero crossing is NOT an edge', () => {
    // The overshoot-critical events are zero crossings / sign reversals; mid-
    // gesture analog ramps ride the throttled per-frame path + heartbeat, so they
    // must not immediate-flush every frame (that would defeat the adaptive rate).
    const g = makeShipControlGate();
    g.isEdge({ rotationSpeed: 0.05, thrustInput: 0.3, brakeInput: 0.2 });
    assert.equal(g.isEdge({ rotationSpeed: 0.09, thrustInput: 0.7, brakeInput: 0.9 }), false);
});

test('P1: detection is scheme-agnostic — keyboard step and analog ramp same predicate', () => {
    // Keyboard produces a step (0 -> full); analog produces a ramp that crosses
    // zero on release. Both surface the stop as an edge.
    const kb = makeShipControlGate();
    kb.isEdge({ rotationSpeed: 0 });
    kb.isEdge({ rotationSpeed: 0.12 });             // press
    assert.equal(kb.isEdge({ rotationSpeed: 0 }), true, 'keyboard release');

    const analog = makeShipControlGate();
    analog.isEdge({ rotationSpeed: 0 });
    analog.isEdge({ rotationSpeed: 0.03 });         // ramp up (start edge)
    assert.equal(analog.isEdge({ rotationSpeed: 0.07 }), false, 'mid-ramp not an edge');
    assert.equal(analog.isEdge({ rotationSpeed: 0 }), true, 'analog release crosses zero');
});

test('P1: reset clears the baseline so the next sample re-seeds', () => {
    const g = makeShipControlGate();
    g.isEdge({ rotationSpeed: 0.12 });
    g.reset();
    assert.equal(g.isEdge({ rotationSpeed: 0 }), false, 'post-reset sample only seeds');
});

// ----------------------------------------------------------------------------
// P2: DeadReckon angular-projection clamp mirror
// ----------------------------------------------------------------------------

function reckonAngle(state, frames, cfg) {
    let angFrames = frames;
    const cap = cfg.DEADRECKON_ANGULAR_MAX_FRAMES;
    if (state.clampAngular && cap >= 0 && angFrames > cap) angFrames = cap;
    return state.angle + state.rotationSpeed * angFrames;
}

test('P2: ship angle is clamped to DEADRECKON_ANGULAR_MAX_FRAMES', () => {
    const cfg = { DEADRECKON_ANGULAR_MAX_FRAMES: 10 };
    const ship = { angle: 0, rotationSpeed: 0.12, clampAngular: true };
    // 30 frames of unclamped projection would be 0.12*30 = 3.6 rad; clamp caps it.
    assert.equal(reckonAngle(ship, 30, cfg), 0.12 * 10);
});

test('P2: asteroids/bullets (constant spin) are NOT clamped', () => {
    const cfg = { DEADRECKON_ANGULAR_MAX_FRAMES: 10 };
    const rock = { angle: 0, rotationSpeed: 0.02, clampAngular: false };
    assert.equal(reckonAngle(rock, 30, cfg), 0.02 * 30);
});

test('P2: short gaps under the cap are unaffected for ships', () => {
    const cfg = { DEADRECKON_ANGULAR_MAX_FRAMES: 10 };
    const ship = { angle: 1, rotationSpeed: 0.12, clampAngular: true };
    assert.equal(reckonAngle(ship, 4, cfg), 1 + 0.12 * 4);
});

// ----------------------------------------------------------------------------
// P3: physics input-replay mirror
// ----------------------------------------------------------------------------
//
// A faithful, self-contained mirror of Ship.update()'s kinematics. The exact
// numeric form of the unit helpers is irrelevant to the invariant under test
// (owner and replica use the identical function), so a simple deterministic
// conversion stands in for velocityToNormalizedDeltaX/Y.

const SHIP = {
    TARGET_FPS: 60,
    SHIP_THRUST: 0.009,
    SHIP_FRICTION: 0.99,
    SHIP_TURN_SPEED: 0.12,
    SHIP_MAX_SPEED: 0.8,
    SHIP_BRAKE_STRENGTH: 0.018,
    ACCEL_TIME: 0.0,
    DECEL_TIME: 0.0,
};

const TURN_CONTROL_MODE = {
    RATE: 0,
    TARGET: 1,
};

function shortestAngleDelta(targetAngle, currentAngle) {
    const diff = targetAngle - currentAngle;
    return Math.atan2(Math.sin(diff), Math.cos(diff));
}

function attainableTurnTarget(delta, maxMagnitude, ratePerFrame, dt) {
    if (maxMagnitude <= 0) return 0;
    if (delta === 0) return 0;
    const denom = ratePerFrame * dt;
    if (denom <= 0) return 0;
    const cappedMag = Math.min(maxMagnitude, Math.abs(delta) / denom);
    return Math.sign(delta) * cappedMag;
}

function mergeTurnInputs(a, b) {
    const sum = (a || 0) + (b || 0);
    if (sum >  1) return  1;
    if (sum < -1) return -1;
    return sum;
}

function rampInputToward(cur, target, accel, decel, dtSec) {
    if (accel <= 0 && decel <= 0) return target; // instantaneous (shipped config)
    const rate = (Math.abs(target) > Math.abs(cur)) ? accel : decel;
    if (rate <= 0) return target;
    const maxStep = dtSec / rate;
    const d = target - cur;
    if (Math.abs(d) <= maxStep) return target;
    return cur + Math.sign(d) * maxStep;
}

const toNX = (v) => v / SHIP.TARGET_FPS;        // stand-in unit conversion
const toNY = (v) => v / SHIP.TARGET_FPS;

class MiniShip {
    constructor() {
        this.x = 0; this.y = 0; this.angle = 0;
        this.velocityX = 0; this.velocityY = 0;
        this.rotationSpeed = 0;
        this.turnTarget = 0; this.turnInput = 0;
        this.thrustInput = 0; this.brakeInput = 0;
        this.turnControlMode = TURN_CONTROL_MODE.RATE;
        this.turnTargetAngle = 0;
        this.turnMagnitude = 0;
        this.turnBias = 0;
    }
    update(dt = 1) {
        const dtSec = dt / SHIP.TARGET_FPS;
        this.turnInput = rampInputToward(this.turnInput, this.turnTarget, SHIP.ACCEL_TIME, SHIP.DECEL_TIME, dtSec);
        this.rotationSpeed = SHIP.SHIP_TURN_SPEED * this.turnInput;
        this.angle += this.rotationSpeed * dt;
        const friction = Math.pow(SHIP.SHIP_FRICTION, dt);
        this.velocityX *= friction;
        this.velocityY *= friction;
        if (this.thrustInput > 0) {
            const a = SHIP.SHIP_THRUST * this.thrustInput;
            this.velocityX += Math.cos(this.angle) * a * dt;
            this.velocityY += Math.sin(this.angle) * a * dt;
        }
        const speedSq = this.velocityX ** 2 + this.velocityY ** 2;
        const maxSq = SHIP.SHIP_MAX_SPEED ** 2;
        if (speedSq > maxSq) {
            const s = Math.sqrt(speedSq);
            this.velocityX = (this.velocityX / s) * SHIP.SHIP_MAX_SPEED;
            this.velocityY = (this.velocityY / s) * SHIP.SHIP_MAX_SPEED;
        }
        if (this.brakeInput > 0) {
            const sp = Math.sqrt(this.velocityX ** 2 + this.velocityY ** 2);
            if (sp > 0) {
                const decel = SHIP.SHIP_BRAKE_STRENGTH * this.brakeInput * dt;
                const factor = Math.max(0, sp - decel) / sp;
                this.velocityX *= factor;
                this.velocityY *= factor;
            }
        }
        this.x += toNX(this.velocityX) * dt;
        this.y += toNY(this.velocityY) * dt;
    }
}

// The replay used on the remote: seed a scratch ship from the authoritative
// packet and step it `frames` times. Rate controls replay turnTarget directly;
// target-heading controls recompute turnTarget from targetAngle every substep.
function replay(packet, frames) {
    const sh = new MiniShip();
    sh.x = packet.x; sh.y = packet.y; sh.angle = packet.angle;
    sh.velocityX = packet.velocityX; sh.velocityY = packet.velocityY;
    sh.rotationSpeed = packet.rotationSpeed;
    const ti = SHIP.SHIP_TURN_SPEED !== 0 ? packet.rotationSpeed / SHIP.SHIP_TURN_SPEED : 0;
    sh.turnInput = ti;
    sh.thrustInput = packet.thrustInput || 0;
    sh.brakeInput = packet.brakeInput || 0;
    let remaining = frames > 0 ? frames : 0;
    while (remaining > 1e-6) {
        const dt = remaining > 1 ? 1 : remaining;
        if (packet.turnControlMode === TURN_CONTROL_MODE.TARGET) {
            const delta = shortestAngleDelta(packet.turnTargetAngle || 0, sh.angle);
            const targetTurn = attainableTurnTarget(
                delta,
                packet.turnMagnitude || 0,
                SHIP.SHIP_TURN_SPEED,
                dt);
            sh.turnTarget = mergeTurnInputs(targetTurn, packet.turnBias || 0);
        } else {
            sh.turnTarget = Number.isFinite(packet.turnTarget) ? packet.turnTarget : ti;
        }
        sh.update(dt);
        remaining -= dt;
    }
    return sh;
}

function staleRateReplay(packet, frames) {
    const sh = new MiniShip();
    sh.x = packet.x; sh.y = packet.y; sh.angle = packet.angle;
    sh.velocityX = packet.velocityX; sh.velocityY = packet.velocityY;
    const ti = SHIP.SHIP_TURN_SPEED !== 0 ? packet.rotationSpeed / SHIP.SHIP_TURN_SPEED : 0;
    sh.turnInput = ti;
    sh.turnTarget = ti;
    let remaining = frames > 0 ? frames : 0;
    while (remaining > 1e-6) {
        const dt = remaining > 1 ? 1 : remaining;
        sh.update(dt);
        remaining -= dt;
    }
    return sh;
}

function packetOf(ship) {
    return {
        x: ship.x, y: ship.y, angle: ship.angle,
        velocityX: ship.velocityX, velocityY: ship.velocityY,
        rotationSpeed: ship.rotationSpeed,
        thrustInput: ship.thrustInput, brakeInput: ship.brakeInput,
        turnControlMode: ship.turnControlMode,
        turnTarget: ship.turnTarget,
        turnTargetAngle: ship.turnTargetAngle,
        turnMagnitude: ship.turnMagnitude,
        turnBias: ship.turnBias,
    };
}

function assertPose(a, b, msg) {
    assert.ok(Math.abs(a.x - b.x) < 1e-12, `${msg} x`);
    assert.ok(Math.abs(a.y - b.y) < 1e-12, `${msg} y`);
    assert.ok(Math.abs(a.angle - b.angle) < 1e-12, `${msg} angle`);
    assert.ok(Math.abs(a.velocityX - b.velocityX) < 1e-12, `${msg} vx`);
    assert.ok(Math.abs(a.velocityY - b.velocityY) < 1e-12, `${msg} vy`);
    assert.ok(Math.abs(a.rotationSpeed - b.rotationSpeed) < 1e-12, `${msg} rotationSpeed`);
}

test('P3: replay reproduces a coasting (friction decay) ship exactly', () => {
    const owner = new MiniShip();
    owner.velocityX = 0.6; owner.velocityY = -0.4; owner.angle = 1.1;
    const packet = packetOf(owner);
    for (let i = 0; i < 20; i++) owner.update(1);
    assertPose(replay(packet, 20), owner, 'coast');
});

test('P3: replay reproduces thrust along the rotating heading exactly', () => {
    const owner = new MiniShip();
    owner.angle = 0.5;
    owner.turnTarget = 0.5; owner.turnInput = 0.5;   // sustained turn
    owner.rotationSpeed = SHIP.SHIP_TURN_SPEED * owner.turnInput; // as set by update()
    owner.thrustInput = 1.0;                         // full thrust
    const packet = packetOf(owner);
    for (let i = 0; i < 25; i++) owner.update(1);
    assertPose(replay(packet, 25), owner, 'thrust+turn');
});

test('P3: replay reproduces braking (clamped damping) exactly', () => {
    const owner = new MiniShip();
    owner.velocityX = 0.5; owner.velocityY = 0.5;
    owner.brakeInput = 1.0;
    const packet = packetOf(owner);
    for (let i = 0; i < 30; i++) owner.update(1);
    assertPose(replay(packet, 30), owner, 'brake');
});

test('P3: turnInput recovered from rotationSpeed reproduces rotation', () => {
    const owner = new MiniShip();
    owner.turnTarget = -1; owner.turnInput = -1;     // rotationSpeed = -0.12
    owner.rotationSpeed = SHIP.SHIP_TURN_SPEED * owner.turnInput; // as set by update()
    const packet = packetOf(owner);
    assert.ok(Math.abs(packet.rotationSpeed - (-SHIP.SHIP_TURN_SPEED)) < 1e-12);
    for (let i = 0; i < 15; i++) owner.update(1);
    assertPose(replay(packet, 15), owner, 'rotation-only');
});

test('P3: fractional-frame replay matches whole + remainder stepping', () => {
    const owner = new MiniShip();
    owner.velocityX = 0.3; owner.velocityY = 0.2; owner.thrustInput = 0.5; owner.angle = 0.2;
    owner.turnTarget = 0.25; owner.turnInput = 0.25;
    owner.rotationSpeed = SHIP.SHIP_TURN_SPEED * owner.turnInput; // as set by update()
    const packet = packetOf(owner);
    // Owner advances 7 whole frames + a 0.5 remainder.
    for (let i = 0; i < 7; i++) owner.update(1);
    owner.update(0.5);
    assertPose(replay(packet, 7.5), owner, 'fractional');
});

test('P3: zero elapsed frames returns the baseline pose unchanged', () => {
    const owner = new MiniShip();
    owner.x = 0.42; owner.y = 0.17; owner.angle = 2.0;
    owner.velocityX = 0.1; owner.velocityY = -0.2;
    owner.turnTarget = 0.5; owner.turnInput = 0.5;
    owner.rotationSpeed = SHIP.SHIP_TURN_SPEED * owner.turnInput;
    const packet = packetOf(owner);
    assertPose(replay(packet, 0), owner, 'zero-frames');
});

test('P3b: target-heading replay lands on target instead of projecting stale turn rate', () => {
    const targetAngle = 0.18;
    const packet = {
        x: 0, y: 0, angle: 0,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.TARGET,
        turnTargetAngle: targetAngle,
        turnMagnitude: 1,
        turnBias: 0,
    };

    const stale = staleRateReplay(packet, 8);
    assert.ok(stale.angle > targetAngle + 0.5,
        `precondition: stale rate replay should overshoot badly, got ${stale.angle}`);

    const replayed = replay(packet, 8);
    assert.ok(Math.abs(shortestAngleDelta(targetAngle, replayed.angle)) < 1e-12,
        `target replay should converge to target, got ${replayed.angle}`);
    assert.ok(replayed.angle <= targetAngle + 1e-12,
        'target replay must not cross past the target heading');
    assert.ok(Math.abs(replayed.rotationSpeed) < 1e-12,
        'rotationSpeed settles to zero at the target');
});

test('P3b: target-heading replay takes the short way across the angle seam', () => {
    const targetAngle = 0.05;
    const startAngle = Math.PI * 2 - 0.04;
    const packet = {
        x: 0, y: 0, angle: startAngle,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.TARGET,
        turnTargetAngle: targetAngle,
        turnMagnitude: 1,
        turnBias: 0,
    };

    const replayed = replay(packet, 4);
    assert.ok(Math.abs(shortestAngleDelta(targetAngle, replayed.angle)) < 1e-12,
        `target replay should converge across seam, got ${replayed.angle}`);
});
