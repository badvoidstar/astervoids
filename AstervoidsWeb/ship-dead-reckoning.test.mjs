import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const productionSource = readFileSync(
    new URL('./wwwroot/index.html', import.meta.url),
    'utf8');
const { createControlEdgeGate } = require('./wwwroot/js/replication-send-policy.js');
const ReplicationPresentation = require('./wwwroot/js/replication-presentation.js');
const {
    createDeadReckoningPolicy,
    calculateRateAngularPredictionWindow,
    integrateRateAngularPredictionFrames,
    averageRateAngularPredictionScale,
} = ReplicationPresentation;

// Exercises production policies and inline Ship/replay declarations without
// booting the browser runtime. The covered features are:
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
// P1: production ShipControlGate.isEdge
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
// P3: production physics input-replay
// ----------------------------------------------------------------------------

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
    SHIP_TURN_ACCEL_TIME: 0.0,
    SHIP_TURN_DECEL_TIME: 0.0,
    SHIP_SIZE: 0.02,
};

const TURN_CONTROL_MODE = {
    KEYBOARD_RATE: 0,
    ANALOG_TARGET: 1,
    ANALOG_RATE: 2,
};

// A square viewport preserves the fixtures' ref-dimension/s -> v/60 units.
// Production conversion and wrapping stay enabled, including off-screen margins.
const viewport = { width: 1000, height: 1000 };
const {
    Ship,
    getShipTurnSpeed,
    shortestAngleDelta,
    createDeadReckoningState,
    replayDeadReckonedShip,
    velocityToNormalizedDeltaX,
    velocityToNormalizedDeltaY,
} = loadInlineGameFunctions([
    'Ship',
    'normalizeTurnControlMode',
    'getShipTurnSpeed',
    'shortestAngleDelta',
    'attainableTurnTarget',
    'mergeTurnInputs',
    'rampInputToward',
    'createDeadReckoningState',
    'replayDeadReckonedShip',
    'velocityToNormalizedDeltaX',
    'velocityToNormalizedDeltaY',
    'wrapNormalized',
    'wrapMarginX',
    'wrapMarginY',
], {
    CONFIG: SHIP,
    TURN_CONTROL_MODE,
    OBJECT_TYPES: { SHIP: 'ship' },
    ReplicationPresentation,
    getReferenceDimension: () => Math.min(viewport.width, viewport.height),
    getGameWidth: () => viewport.width,
    getGameHeight: () => viewport.height,
});

function makeShip() {
    const ship = new Ship(0, 0);
    ship.angle = 0; // Fixtures face right rather than the constructor's up heading.
    return ship;
}

test('P3: zero ship max speed disables the speed cap', () => {
    assert.match(
        productionSource,
        /if \(CONFIG\.SHIP_MAX_SPEED > 0 && speedSq > maxSpeedSq\)/);

    const originalMaxSpeed = SHIP.SHIP_MAX_SPEED;
    try {
        SHIP.SHIP_MAX_SPEED = 0;
        const ship = makeShip();
        ship.velocityX = 0.5;
        ship.update();
        assert.ok(ship.velocityX > 0);
        assert.ok(Math.abs(ship.velocityX - 0.495) < 1e-12, 'only friction slows the ship');
        assert.ok(Math.abs(ship.x - 0.00825) < 1e-12, 'velocity is converted from per-second units');
    } finally {
        SHIP.SHIP_MAX_SPEED = originalMaxSpeed;
    }
});

// Each reference call has a fresh context; cache tests retain one independently.
function replay(packet, frames, targetDrive = true, rateWindow = null) {
    return makeCachedReplayer()(packet, frames, targetDrive, rateWindow);
}

function makePresentationPolicy({
    inputReplay = true,
    rotationTarget = true,
    smoothMs = 0,
    nowMs = () => 0,
} = {}) {
    return createDeadReckoningPolicy({
        config: {
            ...SHIP,
            DEADRECKON_MAX_FRAMES: 30,
            DEADRECKON_SMOOTH_MS: smoothMs,
            DEADRECKON_SNAP_DIST: Infinity,
        },
        nowMs,
        velocityToDeltaX: velocityToNormalizedDeltaX,
        velocityToDeltaY: velocityToNormalizedDeltaY,
        shortestAngleDelta,
        createState: createDeadReckoningState,
        isRotationTarget: state => rotationTarget && state.clampAngular
            && state.turnControlMode === TURN_CONTROL_MODE.ANALOG_TARGET,
        shouldReplay: state => inputReplay && state.clampAngular,
        getAngularPredictionWindow: state => state.rateAngularPredictionWindow,
        replay: replayDeadReckonedShip,
    });
}

function hybridReckon(packet, frames, options) {
    const policy = makePresentationPolicy(options);
    policy.updateState('ship', { ...packet, type: 'ship' }, 0, true);
    return policy._reckonRaw('ship', frames * (1000 / SHIP.TARGET_FPS));
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
    const owner = makeShip();
    owner.velocityX = 0.6; owner.velocityY = -0.4; owner.angle = 1.1;
    const packet = packetOf(owner);
    for (let i = 0; i < 20; i++) owner.update(1);
    assertPose(replay(packet, 20), owner, 'coast');
    assert.ok(Math.abs(owner.velocityX - 0.6 * 0.99 ** 20) < 1e-12, 'exponential friction decay');
    assert.ok(Math.abs(owner.velocityY - (-0.4 * 0.99 ** 20)) < 1e-12, 'friction preserves direction');
});

test('P3: replay preserves aspect-aware units and ship-sized wrap margins', () => {
    const originalViewport = { ...viewport };
    Object.assign(viewport, { width: 1200, height: 600 });
    try {
        const owner = makeShip();
        owner.x = 1.01; owner.y = -0.02;
        owner.update(1);
        assert.equal(owner.x, 1.01, 'right margin boundary is inclusive');
        assert.equal(owner.y, -0.02, 'top margin boundary is inclusive');

        owner.x = 1.009; owner.y = -0.019;
        owner.velocityX = 0.6; owner.velocityY = -0.3;
        const packet = packetOf(owner);
        owner.update(1);
        const remote = replay(packet, 1);
        assertPose(remote, owner, 'rectangular wrap');
        // After friction, dx = .594 * .5 / 60 and dy = -.297 / 60.
        // Crossing the margins subtracts/adds the 1.02/1.04 field spans.
        assert.ok(Math.abs(remote.x - (-0.00605)) < 1e-12, 'right-to-left wrap');
        assert.ok(Math.abs(remote.y - 1.01605) < 1e-12, 'top-to-bottom wrap');
        assert.ok(Math.abs(remote.velocityX - 0.594) < 1e-12, 'wrap preserves vx');
        assert.ok(Math.abs(remote.velocityY - (-0.297)) < 1e-12, 'wrap preserves vy');
    } finally {
        Object.assign(viewport, originalViewport);
    }
});

test('P3: replay reproduces thrust along the rotating heading exactly', () => {
    const owner = makeShip();
    owner.angle = 0.5;
    owner.turnTarget = 0.5; owner.turnInput = 0.5;   // sustained turn
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
    owner.thrustInput = 1.0;                         // full thrust
    const packet = packetOf(owner);
    for (let i = 0; i < 25; i++) owner.update(1);
    assertPose(replay(packet, 25), owner, 'thrust+turn');
});

test('P3: replay reproduces braking (clamped damping) exactly', () => {
    const owner = makeShip();
    owner.velocityX = 0.5; owner.velocityY = 0.5;
    owner.brakeInput = 1.0;
    const packet = packetOf(owner);
    for (let i = 0; i < 30; i++) owner.update(1);
    assertPose(replay(packet, 30), owner, 'brake');
});

test('P3: turnInput recovered from rotationSpeed reproduces rotation', () => {
    const owner = makeShip();
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
            const owner = makeShip();
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
    const owner = makeShip();
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
    const owner = makeShip();
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

    const staleAngle = packet.angle + packet.rotationSpeed * 8;
    assert.ok(staleAngle > targetAngle + 0.5,
        `precondition: stale rate projection should overshoot badly, got ${staleAngle}`);

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
    let now = 0;
    const policy = makePresentationPolicy({
        inputReplay: false,
        smoothMs: tau,
        nowMs: () => now,
    });
    const packet = { ...packetOf(makeShip()), type: 'ship' };
    policy.updateState('ship', { ...packet, angle: previouslyDisplayed }, 0, true);
    policy.updateState('ship', { ...packet, angle: authoritative }, 0, false);
    assert.equal(policy.getReckoned('ship').angle, previouslyDisplayed);
    let prior = previouslyDisplayed;
    for (let t = 10; t <= 600; t += 10) {
        now = t;
        const angle = policy.getReckoned('ship').angle;
        assert.ok(angle <= prior + 1e-12, `t=${t}: should move monotonically toward target`);
        assert.ok(angle >= authoritative - 1e-12, `t=${t}: should not overshoot below target`);
        prior = angle;
    }
    now = 1000;
    assert.equal(policy.getReckoned('ship').angle, authoritative);
    assert.equal(policy.smooth.has('ship'), false, 'expired correction is discarded');
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
    const staleAngle = packet.angle + packet.rotationSpeed * 8;
    assert.ok(staleAngle > 0.9, `precondition: stale projection should lead, got ${staleAngle}`);

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
// replayDeadReckonedShip caches the scratch ship pose after an integer number of whole
// dt=1 steps (keyed by the snapshot object via a WeakMap) and RESUMES from there
// on the next, later-time call instead of replaying from the baseline. Assert
// the production cache is bit-for-bit identical to a fresh-context, from-baseline
// replay for a monotonically increasing sequence of frame counts (the access
// pattern of a fixed snapshot reckoned every render frame), and that a fresh
// snapshot object resets it. The whole-frame steps are exactly composable, so
// the cache must be a pure performance optimization with no behavioural change.

function makeCachedReplayer(context = { replayCache: new WeakMap(), scratch: null }) {
    return function reckon(packet, frames, targetDrive, rateWindow = null) {
        const out = {};
        const targetMode = targetDrive
            && packet.turnControlMode === TURN_CONTROL_MODE.ANALOG_TARGET;
        replayDeadReckonedShip(packet, frames, out, targetMode, context, rateWindow);
        return out;
    };
}

test('PERF: incremental cache == from-scratch replay across a growing frame sequence (rate)', () => {
    const owner = makeShip();
    owner.velocityX = 0.4; owner.velocityY = -0.25; owner.angle = 0.7;
    owner.thrustInput = 0.8;
    owner.turnTarget = 0.6; owner.turnInput = 0.6;
    owner.rotationSpeed = getShipTurnSpeed(owner.turnControlMode) * owner.turnInput;
    const packet = packetOf(owner);            // keyboard-rate mode
    const scratch = makeShip();
    const steps = [];
    const update = scratch.update.bind(scratch);
    scratch.update = dt => {
        steps.push(dt);
        update(dt);
    };
    const reckon = makeCachedReplayer({ replayCache: new WeakMap(), scratch });
    // Monotonically non-decreasing, fractional, up to and past the 30-frame clamp.
    const seq = [0, 0.3, 1, 1.5, 2, 2.7, 5, 5.5, 10.2, 17.9, 25, 29.4, 30, 30];
    for (const frames of seq) {
        assertPose(reckon(packet, frames, false), replay(packet, frames, false), `rate frames=${frames}`);
    }
    assert.equal(steps.filter(dt => dt === 1).length, 30, 'whole frames are simulated only once');
    assert.equal(steps.filter(dt => dt < 1).length, 7, 'fractional samples do not enter the cache');
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
    // Interleave A and B through the same production scratch Ship.
    assertPose(reckon(a, 3, false), replay(a, 3, false), 'A@3');
    assertPose(reckon(b, 2, false), replay(b, 2, false), 'B@2');
    assertPose(reckon(a, 7, false), replay(a, 7, false), 'A@7 resumes A (not B scratch)');
    assertPose(reckon(b, 6.5, false), replay(b, 6.5, false), 'B@6.5 resumes B (not A scratch)');
});

test('PERF: repeated saturated calls stay identical (no drift) and match from-scratch', () => {
    const owner = makeShip();
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
