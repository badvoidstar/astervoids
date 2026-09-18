import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const ReplicationPresentation = require('./wwwroot/js/replication-presentation.js');

const epoch = 1_800_000_000_000;

// The thrust flame is a replicated visual, not an owner-only affordance: every
// member must see a remote ship's flame. Deterministic presentation samples
// carry kinematics only, so the ship adapter has to source `thrusting` from the
// authoritative record; buffered samples already carry it at the member's
// render delay and must keep winning.
function harness({ deterministic = true } = {}) {
    let now = 1000;
    const config = {
        TARGET_FPS: 60, INVULNERABILITY_TIME: 180, INVULN_BLINK_RATE: 10,
        SHIP_TURN_ACCEL_TIME: 0.1, SHIP_TURN_DECEL_TIME: 0.1,
        SHIP_FRICTION: 0.995, SHIP_THRUST: 0.01, SHIP_MAX_SPEED: 4.5,
        SHIP_BRAKE_STRENGTH: 0.01, SHIP_SIZE: 0.02,
        SHIP_INPUT_REPLAY_ENABLED: false, SHIP_ROTATION_TARGET_ENABLED: false,
        INTERPOLATION_ENABLED: true, SEND_ON_CHANGE_HEARTBEAT_MS: 250,
        DEADRECKON_MAX_FRAMES: 30, DEADRECKON_SMOOTH_MS: 90,
        DEADRECKON_SNAP_DIST: 0.2, SNAPSHOT_BUFFER_SIZE: 10,
        MAX_EXTRAPOLATION: 0.1, SNAP_THRESHOLD: 0.2,
        STROKE_COLOR: '#fff', THRUST_COLOR: '#f80'
    };
    const game = {
        ship: null,
        multiplayer: { myShipObjectId: 'local', remoteShips: new Map() }
    };
    const records = new Map();
    const shortestAngleDelta = (a, b) => {
        let delta = a - b;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        return delta;
    };
    const globals = {
        CONFIG: config,
        game,
        performance: { now: () => now },
        replicationClock: { validAtToMonotonicMs: at => at - epoch },
        isDeterministicMode: () => deterministic,
        isSessionMode: () => true,
        OBJECT_TYPES: { SHIP: 'ship', ASTEROID: 'asteroid', BULLET: 'bullet' },
        TURN_CONTROL_MODE: { KEYBOARD_RATE: 0, ANALOG_TARGET: 1 },
        normalizeTurnControlMode: value => value || 0,
        getShipTurnSpeed: () => 0.05,
        velocityToNormalizedDeltaX: velocity => velocity / 60,
        velocityToNormalizedDeltaY: velocity => velocity / 60,
        wrapNormalized: value => ((value % 1) + 1) % 1,
        wrapMarginX: () => 0, wrapMarginY: () => 0,
        shortestAngleDelta,
        mergeTurnInputs: (a, b) => Math.max(-1, Math.min(1, (a || 0) + (b || 0))),
        attainableTurnTarget: () => 0,
        rampInputToward: (current, target) => target,
        resolveTerminalSession: () => null,
        hasPersistedTerminalTarget: () => false,
        deterministicTerminalState: { directTargetIds: new Set() },
        getDeterministicIngestBaselinePerf: () => now,
        calculateShipRateAngularPredictionWindow: () => null,
        ObjectSync: { getObject: id => records.get(id) },
        SHIP_COLORS: ['#0ff'],
        getReferenceDimension: () => 1000,
        fromNormalizedX: value => value * 1000,
        fromNormalizedY: value => value * 1000,
        fromNormalizedSize: value => value * 1000,
        RemoteObjects: null,
        DeadReckon: null
    };

    // Production dead-reckoning state/replay callbacks feed the real policy, so
    // the test observes the exact fields a deterministic sample exposes.
    const seed = loadInlineGameFunctions(
        ['Ship', 'ShipInvulnerability', 'assignDefined',
            'createDeadReckoningState', 'replayDeadReckonedShip'],
        globals);
    const DeadReckon = ReplicationPresentation.createDeadReckoningPolicy({
        config,
        nowMs: () => now,
        velocityToDeltaX: velocity => velocity / 60,
        velocityToDeltaY: velocity => velocity / 60,
        shortestAngleDelta,
        createState: seed.createDeadReckoningState,
        isRotationTarget: () => false,
        shouldReplay: () => false,
        getAngularPredictionWindow: () => null,
        replay: seed.replayDeadReckonedShip
    });
    const buffered = ReplicationPresentation.createSnapshotInterpolationPolicy({
        config,
        nowMs: () => now,
        validAtToTime: validAt => validAt - epoch,
        getDelayForMember: () => 100,
        velocityToDeltaX: velocity => velocity / 60,
        velocityToDeltaY: velocity => velocity / 60,
        shortestDeltaX: (from, to) => to - from,
        shortestDeltaY: (from, to) => to - from,
        wrapX: value => value,
        wrapY: value => value,
        distanceBetween: (a, b) => Math.hypot(b.x - a.x, (b.y || 0) - (a.y || 0))
    });
    const RemoteObjects = Object.assign({}, buffered, {
        clock: { offsetInitialized: true },
        serverNowMs: () => epoch + now,
        getDelayForMember: () => 100
    });

    const production = loadInlineGameFunctions([
        'Ship', 'ShipInvulnerability', 'assignDefined', 'indexKinematicInstances',
        'getKinematicInstance', 'currentKinematicData', 'createKinematicPresentation',
        'applyShipReplicaData'
    ], { ...globals, DeadReckon, RemoteObjects });
    const presentation = production.createKinematicPresentation();

    let version = 0;
    function shipData(overrides = {}) {
        return {
            type: 'ship', x: 0.5, y: 0.5, angle: 0,
            velocityX: 0, velocityY: 0, rotationSpeed: 0,
            thrusting: false, invulnerable: 0, invulnerabilityRevision: 0,
            memberId: 'owner', colorIndex: 0, turnControlMode: 0,
            thrustInput: 0, brakeInput: 0,
            ...overrides
        };
    }

    // One receive + render pass for a remote ship, mirroring the runtime order:
    // create replica -> presentation ingest -> presentation sample -> apply.
    function receive(data, { id = 'remote' } = {}) {
        let ship = game.multiplayer.remoteShips.get(id);
        if (!ship) {
            ship = new production.Ship(data.x, data.y, data.colorIndex || 0);
            game.multiplayer.remoteShips.set(id, ship);
        }
        const record = {
            id, version: ++version, validAt: epoch + now,
            arrivalServerTime: epoch + now, data, ownerMemberId: 'owner'
        };
        records.set(id, record);
        const facts = { type: 'ship', objectId: id, ownerMemberId: 'owner' };
        presentation.ingest(id, data, facts, record, { renderTime: now });
        const sampled = presentation.sample(id, facts, record, { renderTime: now });
        production.applyShipReplicaData(ship, sampled, facts, { renderTime: now });
        return { ship, sampled };
    }

    return {
        ...production, config, game, presentation, records,
        shipData, receive, advance: ms => { now += ms; }
    };
}

// Records every stroked path with the colour in effect, so the assertions
// describe what a member actually sees rather than an internal flag.
function recordingContext() {
    const strokes = [];
    let current = [];
    return {
        strokeStyle: null,
        lineWidth: 1,
        strokes,
        beginPath() { current = []; },
        moveTo(x, y) { current.push([x, y]); },
        lineTo(x, y) { current.push([x, y]); },
        closePath() {},
        stroke() { strokes.push({ style: this.strokeStyle, points: current }); }
    };
}

function flameStrokes(ship, config) {
    const ctx = recordingContext();
    ship.draw(ctx);
    return ctx.strokes.filter(stroke => stroke.style === config.THRUST_COLOR);
}

test('deterministic replicas render the owner thrust flame', () => {
    const h = harness({ deterministic: true });
    const { ship, sampled } = h.receive(h.shipData({ thrusting: true, thrustInput: 1 }));
    assert.equal(sampled.thrusting, undefined,
        'dead-reckoned samples carry kinematics only');
    assert.equal(ship.thrusting, true, 'replica must adopt the owner thrust flag');
    assert.equal(flameStrokes(ship, h.config).length, 1,
        'every member must see the remote flame');
});

test('deterministic replicas clear the flame when the owner stops thrusting', () => {
    const h = harness({ deterministic: true });
    h.receive(h.shipData({ thrusting: true, thrustInput: 1 }));
    h.advance(1000 / 60);
    const { ship } = h.receive(h.shipData({ thrusting: false, thrustInput: 0 }));
    assert.equal(ship.thrusting, false);
    assert.equal(flameStrokes(ship, h.config).length, 0);
});

test('deterministic replicas hold the flame across kinematic-only heartbeats', () => {
    const h = harness({ deterministic: true });
    const { ship } = h.receive(h.shipData({ thrusting: true, thrustInput: 1 }));
    for (let frame = 0; frame < 10; frame++) {
        h.advance(1000 / 60);
        h.receive(h.shipData({ thrusting: true, thrustInput: 1, x: 0.5 + frame / 1000 }));
        assert.equal(ship.thrusting, true, `frame ${frame}`);
    }
});

test('buffered replicas keep the delayed sample as the flame authority', () => {
    const h = harness({ deterministic: false });
    const { ship, sampled } = h.receive(h.shipData({ thrusting: true, thrustInput: 1 }));
    assert.equal(sampled.thrusting, true,
        'buffered samples carry the full snapshot');
    assert.equal(ship.thrusting, true);
    assert.equal(flameStrokes(ship, h.config).length, 1);
});

test('buffered replicas do not inherit a newer record ahead of render delay', () => {
    const h = harness({ deterministic: false });
    h.receive(h.shipData({ thrusting: false }));
    h.advance(16);
    // The newest record already says "thrusting", but this member still renders
    // the buffered past; the raw record must not jump the adaptive delay.
    const { ship, sampled } = h.receive(h.shipData({ thrusting: true, thrustInput: 1 }));
    assert.equal(sampled.thrusting, false);
    assert.equal(ship.thrusting, false);
    assert.equal(flameStrokes(ship, h.config).length, 0);
});

test('local ship rendering still gates the flame on its own thrust flag', () => {
    const h = harness({ deterministic: true });
    const ship = new h.Ship(0.5, 0.5, 0);
    assert.equal(flameStrokes(ship, h.config).length, 0);
    ship.thrusting = true;
    assert.equal(flameStrokes(ship, h.config).length, 1);
});
