import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const productionSource = readFileSync(
    new URL('./wwwroot/index.html', import.meta.url),
    'utf8');
const { createControlEdgeGate } = require('./wwwroot/js/replication-send-policy.js');
const {
    createDeadReckoningPolicy,
    calculateRateAngularPredictionWindow,
    integrateRateAngularPredictionFrames,
    averageRateAngularPredictionScale,
} = require('./wwwroot/js/replication-presentation.js');

// Exercises extracted policies where available and mirrors the game-layer Ship
// replay callback where Ship itself remains inline. The covered features are:
//
//   P1  ShipControlGate.isEdge — scheme-agnostic detection of overshoot-critical
//       control edges (rotation start/stop/reversal, thrust on/off, brake
//       on/off) that trigger an immediate, throttle-bypassing send.
//   P2  DeadReckon adaptive angular prediction — keyboard/rate turns replay
//       through the expected packet cadence and taper smoothly during a stall;
//       ballistic spinners remain on the normal global dead-reckoning bound.
//   P3  Physics input-replay — a remote that seeds from an authoritative packet
//       (pose + velocity + rotationSpeed + control intent) and replays
//       Ship.update() lands where the owner did for rate controls.
//   P3b Target-heading replay — polar touch remotes recompute the owner's
//       heading-alignment turn each replay step instead of projecting a stale
//       rotationSpeed across latency.
//   P4  Control-mode display — target-heading controls remain bounded by their
//       target while keyboard/rate controls display continuous bounded replay.

// ----------------------------------------------------------------------------
// P1: ShipControlGate.isEdge mirror
// ----------------------------------------------------------------------------

const ROT_EPS = 1e-4;

function makeShipControlGate() {
    return createControlEdgeGate({
        getRotationEpsilon: () => ROT_EPS,
        epsilon: 1e-4
    });
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
// P2: production DeadReckon angular-projection clamp
// ----------------------------------------------------------------------------

function reckonAngle(state, frames, cfg) {
    const targetFps = 60;
    const policy = createDeadReckoningPolicy({
        config: {
            ...cfg,
            TARGET_FPS: targetFps,
            DEADRECKON_MAX_FRAMES: frames,
            DEADRECKON_SMOOTH_MS: 0,
            DEADRECKON_SNAP_DIST: Infinity
        },
        nowMs: () => frames * 1000 / targetFps,
        velocityToDeltaX: () => 0,
        velocityToDeltaY: () => 0,
        shortestAngleDelta,
        createState: data => data,
        getAngularPredictionWindow: current =>
            current.rateAngularPredictionWindow
    });
    policy.states.set('ship', { ...state, recvPerf: 0 });
    return policy._reckonRaw('ship', frames * 1000 / targetFps).angle;
}

test('P2: heartbeat cadence keeps keyboard rotation continuous until the next expected packet', () => {
    const window = calculateRateAngularPredictionWindow({
        targetFps: 60,
        heartbeatMs: 250,
        senderIntervalMs: 50,
        packetIntervals: [250, 250, 250],
        jitterMs: 0,
        jitterMultiplier: 2,
        minimumFrames: 10,
        maximumFrames: 30,
        taperFrames: 6
    });
    assert.deepEqual(window, { fullFrames: 15, taperFrames: 6 });
});

test('P2: owner cadence and jitter expand the full-speed prediction horizon', () => {
    const window = calculateRateAngularPredictionWindow({
        targetFps: 60,
        heartbeatMs: 250,
        senderIntervalMs: 300,
        packetIntervals: [280, 320],
        jitterMs: 10,
        jitterMultiplier: 2,
        minimumFrames: 10,
        maximumFrames: 30,
        taperFrames: 6
    });
    assert.ok(Math.abs(window.fullFrames - 20.4) < 1e-12);
    assert.equal(window.taperFrames, 6);
});

test('P2: prediction reserves a taper inside the global dead-reckoning bound', () => {
    const window = calculateRateAngularPredictionWindow({
        targetFps: 60,
        heartbeatMs: 250,
        senderIntervalMs: 1000,
        jitterMs: 100,
        jitterMultiplier: 2,
        minimumFrames: 10,
        maximumFrames: 30,
        taperFrames: 6
    });

    assert.deepEqual(window, { fullFrames: 24, taperFrames: 6 });
});

test('P2: deterministic cadence telemetry is independent of buffered adaptive delay', () => {
    const start = productionSource.indexOf(
        '        recordPacketArrival(serverTimestamp, clientTimestamp');
    const end = productionSource.indexOf(
        '\n        recordMemberPacketInterval(',
        start);
    assert.ok(start >= 0 && end > start, 'recordPacketArrival source is present');
    const source = productionSource.slice(start, end);

    assert.match(source, /this\.recordMemberPacketInterval\(ad, interval\)/);
    assert.doesNotMatch(source, /ADAPTIVE_DELAY_ENABLED/);
});

test('P2: late keyboard rotation tapers smoothly instead of stopping at one hard frame', () => {
    const window = { fullFrames: 10, taperFrames: 4 };
    assert.equal(integrateRateAngularPredictionFrames(10, window), 10);
    assert.equal(integrateRateAngularPredictionFrames(12, window), 11.5);
    assert.equal(integrateRateAngularPredictionFrames(14, window), 12);
    assert.equal(integrateRateAngularPredictionFrames(30, window), 12);

    const scales = [10, 11, 12, 13, 14].map(frame =>
        averageRateAngularPredictionScale(frame, frame + 1, window));
    assert.deepEqual(scales, [0.875, 0.625, 0.375, 0.125, 0]);
});

test('P2: ship rate prediction is bounded while ballistic spin uses the normal global bound', () => {
    const window = { fullFrames: 10, taperFrames: 4 };
    const ship = {
        angle: 0,
        rotationSpeed: 0.12,
        clampAngular: true,
        rateAngularPredictionWindow: window
    };
    assert.equal(reckonAngle(ship, 30, {}), 0.12 * 12);

    const rock = { angle: 0, rotationSpeed: 0.02, clampAngular: false };
    assert.equal(reckonAngle(rock, 30, {}), 0.02 * 30);
});

test('P2: short gaps before the adaptive horizon are unaffected', () => {
    const ship = {
        angle: 1,
        rotationSpeed: 0.12,
        clampAngular: true,
        rateAngularPredictionWindow: { fullFrames: 10, taperFrames: 4 }
    };
    assert.equal(reckonAngle(ship, 4, {}), 1 + 0.12 * 4);
});

// ----------------------------------------------------------------------------
// P3: physics input-replay mirror
// ----------------------------------------------------------------------------
//
// A faithful, self-contained mirror of Ship.update()'s kinematics. The exact
// numeric form of the unit helpers is irrelevant to the invariant under test
// (owner and replica use the identical function), so a simple deterministic
// conversion stands in for velocityToNormalizedDeltaX/Y.

test('P3: runtime maps keyboard and analog turn sources to distinct mode caps', () => {
    const handleStart = productionSource.indexOf('    function handleInput(dt = 1)');
    const handleEnd = productionSource.indexOf('    function checkCollisions()', handleStart);
    const shipUpdateStart = productionSource.indexOf('        update(dt = 1) {');
    const shipUpdateEnd = productionSource.indexOf('        /**', shipUpdateStart);
    assert.ok(handleStart >= 0 && handleEnd > handleStart);
    assert.ok(shipUpdateStart >= 0 && shipUpdateEnd > shipUpdateStart);

    const handleSource = productionSource.slice(handleStart, handleEnd);
    const shipUpdateSource = productionSource.slice(shipUpdateStart, shipUpdateEnd);
    assert.match(handleSource, /let turnControlMode = TURN_CONTROL_MODE\.KEYBOARD_RATE/);
    assert.match(handleSource, /turnControlMode = TURN_CONTROL_MODE\.ANALOG_TARGET/);
    assert.match(handleSource, /getShipTurnSpeed\(turnControlMode\)/);
    assert.match(
        shipUpdateSource,
        /getShipTurnSpeed\(this\.turnControlMode\) \* this\.turnInput/);
});

test('P3: rectilinear anchor targets an offset from its captured heading', () => {
    const handleStart = productionSource.indexOf('    function handleInput(dt = 1)');
    const handleEnd = productionSource.indexOf('    function checkCollisions()', handleStart);
    const anchorStart = productionSource.indexOf(
        '        function beginMoveAnchor(identifier, clientX, clientY)');
    const anchorEnd = productionSource.indexOf(
        '        function updateMoveAnchor(identifier, clientX, clientY)', anchorStart);
    assert.ok(handleStart >= 0 && handleEnd > handleStart);
    assert.ok(anchorStart >= 0 && anchorEnd > anchorStart);

    const handleSource = productionSource.slice(handleStart, handleEnd);
    const anchorSource = productionSource.slice(anchorStart, anchorEnd);
    assert.match(
        anchorSource,
        /stickInput\.rectCapturedHeading =\s*Number\.isFinite\(game\.ship\?\.angle\)/);
    assert.match(
        handleSource,
        /turnTargetAngle =\s*stickInput\.rectCapturedHeading \+ stickInput\.rectRotationOffset/);
    assert.match(handleSource, /turnMagnitude = CONFIG\.ANALOG_TURN_MAX/);
    assert.match(handleSource, /shortestAngleDelta\(turnTargetAngle, game\.ship\.angle\)/);
    assert.doesNotMatch(handleSource, /turnControlMode = TURN_CONTROL_MODE\.ANALOG_RATE/);
});

const SHIP = {
    TARGET_FPS: 60,
    SHIP_THRUST: 0.009,
    SHIP_FRICTION: 0.99,
    SHIP_KEYBOARD_TURN_SPEED: 0.2,
    SHIP_ANALOG_TURN_SPEED: 0.3,
    SHIP_MAX_SPEED: 1.0,
    SHIP_BRAKE_STRENGTH: 0.018,
    ACCEL_TIME: 0.0,
    DECEL_TIME: 0.0,
};

const TURN_CONTROL_MODE = {
    KEYBOARD_RATE: 0,
    ANALOG_TARGET: 1,
    ANALOG_RATE: 2,
};

function getShipTurnSpeed(turnControlMode) {
    return turnControlMode === TURN_CONTROL_MODE.KEYBOARD_RATE
        ? SHIP.SHIP_KEYBOARD_TURN_SPEED
        : SHIP.SHIP_ANALOG_TURN_SPEED;
}

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
        this.turnControlMode = TURN_CONTROL_MODE.KEYBOARD_RATE;
        this.turnTargetAngle = 0;
        this.turnMagnitude = 0;
        this.turnBias = 0;
    }
    update(dt = 1) {
        const dtSec = dt / SHIP.TARGET_FPS;
        this.turnInput = rampInputToward(this.turnInput, this.turnTarget, SHIP.ACCEL_TIME, SHIP.DECEL_TIME, dtSec);
        this.rotationSpeed = getShipTurnSpeed(this.turnControlMode) * this.turnInput;
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
        if (SHIP.SHIP_MAX_SPEED > 0 && speedSq > maxSq) {
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

test('P3: zero ship max speed disables the speed cap', () => {
    assert.match(
        productionSource,
        /if \(CONFIG\.SHIP_MAX_SPEED > 0 && speedSq > maxSpeedSq\)/);

    const originalMaxSpeed = SHIP.SHIP_MAX_SPEED;
    try {
        SHIP.SHIP_MAX_SPEED = 0;
        const ship = new MiniShip();
        ship.velocityX = 0.5;
        ship.update();
        assert.ok(ship.velocityX > 0);
    } finally {
        SHIP.SHIP_MAX_SPEED = originalMaxSpeed;
    }
});

// The replay used on the remote: seed a scratch ship from the authoritative
// packet and step it `frames` times. Rate controls replay turnTarget directly;
// target-heading controls recompute turnTarget from targetAngle every substep
// when targetDrive is enabled.
function replay(packet, frames, targetDrive = true, rateWindow = null) {
    const sh = new MiniShip();
    sh.x = packet.x; sh.y = packet.y; sh.angle = packet.angle;
    sh.velocityX = packet.velocityX; sh.velocityY = packet.velocityY;
    sh.rotationSpeed = packet.rotationSpeed;
    sh.turnControlMode = packet.turnControlMode ?? TURN_CONTROL_MODE.KEYBOARD_RATE;
    const turnSpeed = getShipTurnSpeed(sh.turnControlMode);
    const ti = turnSpeed !== 0 ? packet.rotationSpeed / turnSpeed : 0;
    sh.turnInput = ti;
    sh.thrustInput = packet.thrustInput || 0;
    sh.brakeInput = packet.brakeInput || 0;
    let remaining = frames > 0 ? frames : 0;
    let elapsed = 0;
    while (remaining > 1e-6) {
        const dt = remaining > 1 ? 1 : remaining;
        if (targetDrive && sh.turnControlMode === TURN_CONTROL_MODE.ANALOG_TARGET) {
            const delta = shortestAngleDelta(packet.turnTargetAngle || 0, sh.angle);
            const targetTurn = attainableTurnTarget(
                delta,
                packet.turnMagnitude || 0,
                turnSpeed,
                dt);
            sh.turnTarget = mergeTurnInputs(targetTurn, packet.turnBias || 0);
        } else {
            const target = Number.isFinite(packet.turnTarget) ? packet.turnTarget : ti;
            const scale = averageRateAngularPredictionScale(
                elapsed, elapsed + dt, rateWindow);
            sh.turnTarget = target * scale;
        }
        sh.update(dt);
        elapsed += dt;
        remaining -= dt;
    }
    return sh;
}

function staleRateReplay(packet, frames) {
    const sh = new MiniShip();
    sh.x = packet.x; sh.y = packet.y; sh.angle = packet.angle;
    sh.velocityX = packet.velocityX; sh.velocityY = packet.velocityY;
    sh.turnControlMode = packet.turnControlMode ?? TURN_CONTROL_MODE.KEYBOARD_RATE;
    const turnSpeed = getShipTurnSpeed(sh.turnControlMode);
    const ti = turnSpeed !== 0 ? packet.rotationSpeed / turnSpeed : 0;
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

function hybridReckon(packet, frames, { inputReplay = true, rotationTarget = true } = {}) {
    const targetMode = rotationTarget
        && packet.turnControlMode === TURN_CONTROL_MODE.ANALOG_TARGET;
    const out = {
        x: packet.x,
        y: packet.y,
        velocityX: packet.velocityX,
        velocityY: packet.velocityY,
        rotationSpeed: packet.rotationSpeed,
        angle: targetMode
            ? packet.angle
            : packet.angle + packet.rotationSpeed * frames,
    };
    if (frames > 0) {
        out.x = packet.x + toNX(packet.velocityX) * frames;
        out.y = packet.y + toNY(packet.velocityY) * frames;
    }
    if (inputReplay) {
        const targetDrive = targetMode;
        const sh = replay(packet, frames, targetDrive);
        out.x = sh.x;
        out.y = sh.y;
        out.velocityX = sh.velocityX;
        out.velocityY = sh.velocityY;
        out.rotationSpeed = sh.rotationSpeed;
        if (!targetMode || targetDrive) out.angle = sh.angle;
    }
    return out;
}

function smoothedAngle(authoritativeAngle, previouslyDisplayedAngle, dtMs, tauMs) {
    const k = tauMs > 0 ? Math.exp(-dtMs / tauMs) : 0;
    const da = shortestAngleDelta(previouslyDisplayedAngle, authoritativeAngle);
    return authoritativeAngle + da * (k <= 1e-3 ? 0 : k);
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
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
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
    owner.turnTarget = -1; owner.turnInput = -1;     // rotationSpeed = -0.2
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
    const packet = packetOf(owner);
    assert.ok(Math.abs(packet.rotationSpeed - (-SHIP.SHIP_KEYBOARD_TURN_SPEED)) < 1e-12);
    for (let i = 0; i < 15; i++) owner.update(1);
    assertPose(replay(packet, 15), owner, 'rotation-only');
});

test('P3: keyboard-rate and analog-rate controls use separate turn-speed caps', () => {
    const originalKeyboardSpeed = SHIP.SHIP_KEYBOARD_TURN_SPEED;
    const originalAnalogSpeed = SHIP.SHIP_ANALOG_TURN_SPEED;
    SHIP.SHIP_KEYBOARD_TURN_SPEED = 0.1;
    SHIP.SHIP_ANALOG_TURN_SPEED = 0.35;
    try {
        const cases = [
            [TURN_CONTROL_MODE.KEYBOARD_RATE, 0.1, 'keyboard'],
            [TURN_CONTROL_MODE.ANALOG_RATE, 0.35, 'analog'],
        ];
        for (const [mode, expectedSpeed, label] of cases) {
            const owner = new MiniShip();
            owner.turnControlMode = mode;
            owner.turnTarget = 1;
            owner.turnInput = 1;
            owner.rotationSpeed = getShipTurnSpeed(mode);
            const packet = packetOf(owner);

            assert.equal(packet.rotationSpeed, expectedSpeed, `${label} cap`);
            for (let i = 0; i < 5; i++) owner.update(1);
            assertPose(replay(packet, 5), owner, `${label} replay`);
        }
    } finally {
        SHIP.SHIP_KEYBOARD_TURN_SPEED = originalKeyboardSpeed;
        SHIP.SHIP_ANALOG_TURN_SPEED = originalAnalogSpeed;
    }
});

test('P3: fractional-frame replay matches whole + remainder stepping', () => {
    const owner = new MiniShip();
    owner.velocityX = 0.3; owner.velocityY = 0.2; owner.thrustInput = 0.5; owner.angle = 0.2;
    owner.turnTarget = 0.25; owner.turnInput = 0.25;
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
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
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
    const packet = packetOf(owner);
    assertPose(replay(packet, 0), owner, 'zero-frames');
});

test('P3b: target-heading replay lands on target instead of projecting stale turn rate', () => {
    const targetAngle = 0.18;
    const packet = {
        x: 0, y: 0, angle: 0,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_ANALOG_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.ANALOG_TARGET,
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
        rotationSpeed: SHIP.SHIP_ANALOG_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.ANALOG_TARGET,
        turnTargetAngle: targetAngle,
        turnMagnitude: 1,
        turnBias: 0,
    };

    const replayed = replay(packet, 4);
    assert.ok(Math.abs(shortestAngleDelta(targetAngle, replayed.angle)) < 1e-12,
        `target replay should converge across seam, got ${replayed.angle}`);
});

test('P4: authoritative-angle convergence eases without overshoot', () => {
    const authoritative = 1.0;
    const previouslyDisplayed = 1.45;
    const tau = 90;
    assert.equal(smoothedAngle(authoritative, previouslyDisplayed, 0, tau), previouslyDisplayed);
    let prior = previouslyDisplayed;
    for (let t = 10; t <= 600; t += 10) {
        const angle = smoothedAngle(authoritative, previouslyDisplayed, t, tau);
        assert.ok(angle <= prior + 1e-12, `t=${t}: should move monotonically toward target`);
        assert.ok(angle >= authoritative - 1e-12, `t=${t}: should not overshoot below target`);
        prior = angle;
    }
});

test('P4: non-replay target controls keep authoritative angle instead of projecting stale rotation', () => {
    const packet = {
        x: 0, y: 0, angle: 0,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_ANALOG_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.ANALOG_TARGET,
        turnTargetAngle: 1.5,
        turnMagnitude: 1,
    };
    const stale = staleRateReplay(packet, 8);
    assert.ok(stale.angle > 0.9, `precondition: stale projection should lead, got ${stale.angle}`);

    const out = hybridReckon(packet, 8, { inputReplay: false, rotationTarget: true });
    assert.equal(out.angle, packet.angle);
});

test('P4: rate-mode replay displays smooth keyboard rotation as well as replayed position', () => {
    const packet = {
        x: 0.1, y: 0.2, angle: 0.4,
        velocityX: 0.2, velocityY: -0.1,
        rotationSpeed: SHIP.SHIP_KEYBOARD_TURN_SPEED,
        thrustInput: 1, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.KEYBOARD_RATE,
        turnTarget: 1,
    };
    const scratch = replay(packet, 5, false);
    const out = hybridReckon(packet, 5, { inputReplay: true, rotationTarget: true });
    assert.ok(Math.abs(out.x - scratch.x) < 1e-12, 'replayed x');
    assert.ok(Math.abs(out.y - scratch.y) < 1e-12, 'replayed y');
    assert.ok(Math.abs(out.velocityX - scratch.velocityX) < 1e-12, 'replayed vx');
    assert.ok(Math.abs(out.velocityY - scratch.velocityY) < 1e-12, 'replayed vy');
    assert.ok(Math.abs(out.rotationSpeed - scratch.rotationSpeed) < 1e-12, 'replayed rotationSpeed');
    assert.equal(out.angle, scratch.angle);
    assert.ok(out.angle > packet.angle, 'keyboard rotation should advance between packets');
});

test('P4: target-heading replay still adopts the self-arresting replayed angle', () => {
    const targetAngle = 0.18;
    const packet = {
        x: 0, y: 0, angle: 0,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_ANALOG_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.ANALOG_TARGET,
        turnTargetAngle: targetAngle,
        turnMagnitude: 1,
        turnBias: 0,
    };
    const out = hybridReckon(packet, 8, { inputReplay: true, rotationTarget: true });
    assert.ok(Math.abs(shortestAngleDelta(targetAngle, out.angle)) < 1e-12,
        `target replay should display the replayed target angle, got ${out.angle}`);
});

test('P4: disabling rotation target restores rate replay for target controls', () => {
    const packet = {
        x: 0, y: 0, angle: 0.2,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_ANALOG_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.ANALOG_TARGET,
        turnTarget: 1,
        turnTargetAngle: 0.3,
        turnMagnitude: 1,
    };
    const scratch = replay(packet, 4, false);
    const out = hybridReckon(packet, 4, { inputReplay: true, rotationTarget: false });
    assert.equal(out.angle, scratch.angle);
});

test('P4: adaptive taper slows keyboard replay monotonically during a late packet', () => {
    const packet = {
        x: 0, y: 0, angle: 0,
        velocityX: 0, velocityY: 0,
        rotationSpeed: SHIP.SHIP_KEYBOARD_TURN_SPEED,
        thrustInput: 0, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.KEYBOARD_RATE,
        turnTarget: 1,
    };
    const window = { fullFrames: 3, taperFrames: 4 };
    const angles = [];
    for (let frames = 3; frames <= 8; frames++) {
        angles.push(replay(packet, frames, false, window).angle);
    }
    const deltas = angles.slice(1).map((angle, index) => angle - angles[index]);
    for (let i = 1; i < deltas.length; i++) {
        assert.ok(deltas[i] <= deltas[i - 1] + 1e-12,
            `angular step ${i} should not accelerate during taper`);
        assert.ok(deltas[i] >= -1e-12,
            `angular step ${i} should not reverse during taper`);
    }
    assert.ok(Math.abs(deltas.at(-1)) < 1e-12,
        'rotation should settle after the taper horizon');
});

// ----------------------------------------------------------------------------
// PERF: incremental whole-frame replay cache equivalence
// ----------------------------------------------------------------------------
//
// _replayShip caches the scratch ship pose after an integer number of whole
// dt=1 steps (keyed by the snapshot object via a WeakMap) and RESUMES from there
// on the next, later-time call instead of replaying from the baseline. This
// mirrors that cache and asserts it is bit-for-bit identical to a from-baseline
// replay for a monotonically increasing sequence of frame counts (the access
// pattern of a fixed snapshot reckoned every render frame), and that a fresh
// snapshot object resets it. The whole-frame steps are exactly composable, so
// the cache must be a pure performance optimization with no behavioural change.

function makeCachedReplayer() {
    const cache = new WeakMap();   // packet -> { whole, x, y, angle, vx, vy, rs, ti }
    const sh = new MiniShip();     // shared scratch, mirroring DeadReckon._scratch
    return function reckon(packet, frames, targetDrive) {
        const f = frames > 0 ? frames : 0;
        const whole = Math.floor(f);
        const frac = f - whole;
        sh.turnControlMode =
            packet.turnControlMode ?? TURN_CONTROL_MODE.KEYBOARD_RATE;
        const turnSpeed = getShipTurnSpeed(sh.turnControlMode);
        const baseTurnInput = turnSpeed !== 0
            ? packet.rotationSpeed / turnSpeed : 0;
        let rc = cache.get(packet);
        let from;
        if (rc && rc.whole <= whole) {
            sh.x = rc.x; sh.y = rc.y; sh.angle = rc.angle;
            sh.velocityX = rc.vx; sh.velocityY = rc.vy;
            sh.rotationSpeed = rc.rs; sh.turnInput = rc.ti;
            from = rc.whole;
        } else {
            sh.x = packet.x; sh.y = packet.y; sh.angle = packet.angle;
            sh.velocityX = packet.velocityX; sh.velocityY = packet.velocityY;
            sh.rotationSpeed = packet.rotationSpeed; sh.turnInput = baseTurnInput;
            from = 0;
        }
        sh.thrustInput = packet.thrustInput || 0;
        sh.brakeInput = packet.brakeInput || 0;
        const driveTurn = (dt) => {
            if (targetDrive
                && sh.turnControlMode === TURN_CONTROL_MODE.ANALOG_TARGET) {
                const delta = shortestAngleDelta(packet.turnTargetAngle || 0, sh.angle);
                const targetTurn = attainableTurnTarget(
                    delta, packet.turnMagnitude || 0, turnSpeed, dt);
                sh.turnTarget = mergeTurnInputs(targetTurn, packet.turnBias || 0);
            } else {
                sh.turnTarget = Number.isFinite(packet.turnTarget) ? packet.turnTarget : baseTurnInput;
            }
        };
        for (let i = from; i < whole; i++) { driveTurn(1); sh.update(1); }
        if (!rc) { rc = {}; cache.set(packet, rc); }
        rc.whole = whole;
        rc.x = sh.x; rc.y = sh.y; rc.angle = sh.angle;
        rc.vx = sh.velocityX; rc.vy = sh.velocityY;
        rc.rs = sh.rotationSpeed; rc.ti = sh.turnInput;
        if (frac > 1e-6) { driveTurn(frac); sh.update(frac); }
        return {
            x: sh.x, y: sh.y, angle: sh.angle,
            velocityX: sh.velocityX, velocityY: sh.velocityY,
            rotationSpeed: sh.rotationSpeed,
        };
    };
}

test('PERF: incremental cache == from-scratch replay across a growing frame sequence (rate)', () => {
    const owner = new MiniShip();
    owner.velocityX = 0.4; owner.velocityY = -0.25; owner.angle = 0.7;
    owner.thrustInput = 0.8;
    owner.turnTarget = 0.6; owner.turnInput = 0.6;
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
    const packet = packetOf(owner);            // keyboard-rate mode
    const reckon = makeCachedReplayer();
    // Monotonically non-decreasing, fractional, up to and past the 30-frame clamp.
    const seq = [0, 0.3, 1, 1.5, 2, 2.7, 5, 5.5, 10.2, 17.9, 25, 29.4, 30, 30];
    for (const frames of seq) {
        assertPose(reckon(packet, frames, false), replay(packet, frames, false), `rate frames=${frames}`);
    }
});

test('PERF: incremental cache == from-scratch replay across a growing frame sequence (target-drive)', () => {
    const packet = {
        x: 0.2, y: -0.1, angle: 0.0,
        velocityX: 0.1, velocityY: 0.05,
        rotationSpeed: SHIP.SHIP_ANALOG_TURN_SPEED,
        thrustInput: 0.5, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.ANALOG_TARGET,
        turnTargetAngle: 1.3, turnMagnitude: 1, turnBias: 0,
    };
    const reckon = makeCachedReplayer();
    const seq = [0.5, 1, 2.2, 3, 4.8, 6, 9.1, 12, 18.6, 24, 30];
    for (const frames of seq) {
        assertPose(reckon(packet, frames, true), replay(packet, frames, true), `target frames=${frames}`);
    }
});

test('PERF: a fresh snapshot object resets the cache; interleaved ships resume independently', () => {
    const base = {
        x: 0, y: 0, angle: 0,
        velocityX: 0.3, velocityY: -0.2,
        rotationSpeed: SHIP.SHIP_KEYBOARD_TURN_SPEED * 0.5,
        thrustInput: 0.7, brakeInput: 0,
        turnControlMode: TURN_CONTROL_MODE.KEYBOARD_RATE,
        turnTarget: 0.5,
    };
    const a = { ...base, angle: 0.5 };
    const b = { ...base, angle: -0.5, velocityX: 0.1 };
    const reckon = makeCachedReplayer();   // ONE shared scratch, two snapshots
    // Interleave A and B (mirrors many remote ships through DeadReckon._scratch).
    assertPose(reckon(a, 3, false), replay(a, 3, false), 'A@3');
    assertPose(reckon(b, 2, false), replay(b, 2, false), 'B@2');
    assertPose(reckon(a, 7, false), replay(a, 7, false), 'A@7 resumes A (not B scratch)');
    assertPose(reckon(b, 6.5, false), replay(b, 6.5, false), 'B@6.5 resumes B (not A scratch)');
});

test('PERF: repeated saturated calls stay identical (no drift) and match from-scratch', () => {
    const owner = new MiniShip();
    owner.velocityX = 0.5; owner.angle = 1.0; owner.thrustInput = 1;
    owner.turnTarget = 1; owner.turnInput = 1;
    owner.rotationSpeed = SHIP.SHIP_KEYBOARD_TURN_SPEED;
    const packet = packetOf(owner);
    const reckon = makeCachedReplayer();
    const ref = replay(packet, 30, false);     // clamped resting projection
    reckon(packet, 12.3, false);               // partial window first
    for (let i = 0; i < 5; i++) {
        assertPose(reckon(packet, 30, false), ref, `saturated call ${i}`);
    }
});
