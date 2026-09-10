import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const WireSchemas = require('./wwwroot/js/game-wire-schemas.js');
const { createDeadReckoningPolicy } = require('./wwwroot/js/replication-presentation.js');

function harness() {
    let now = 1000;
    let initialized = true;
    let deterministic = true;
    let fires = 0;
    const writes = [];
    const records = new Map();
    const session = { members: [], simulationSuspended: false };
    const game = { ship: null, astervoids: [], bullets: [],
        multiplayer: { remoteShips: new Map() } };
    const simulationTiming = {
        tick: 0, stepPerf: null, stepServerMs: null, dtMs: 0,
        presentationDelayMs: 30, lastPresentationPerf: null,
    };
    const CONFIG = {
        TARGET_FPS: 60, MAX_EXTRAPOLATION: 2, DEADRECKON_MAX_FRAMES: 30,
        DEADRECKON_SMOOTH_MS: 90, DEADRECKON_SNAP_DIST: 0.2,
        SEND_ON_CHANGE_HEARTBEAT_MS: 250,
        SHIP_SIZE: 0.025, SHIP_FRICTION: 0.99, SHIP_THRUST: 0.009,
        SHIP_MAX_SPEED: 1, SHIP_TURN_ACCEL_TIME: 0, SHIP_TURN_DECEL_TIME: 0,
        SHIP_BRAKE_STRENGTH: 0.018, INVULNERABILITY_TIME: 180,
        SHOOT_COOLDOWN: 10, BULLET_SPEED: 1, BULLET_LIFETIME: 60,
        SHIP_ROTATION_TARGET_ENABLED: true,
    };
    const RemoteObjects = {
        isClockOffsetInitialized: () => initialized,
        serverNowMs: () => now + 10_000,
        validAtToPerfNow: value => value - 10_000,
        getDelay: () => 200,
        getDelayForMember: () => 200,
        getJitter: () => 0,
        memberDelays: new Map(),
        getClockSampleRtt: () => 60,
        recordObjectSample() {},
        remove() {},
    };
    const DeadReckon = {};
    const dependencies = {
        game, simulationTiming, CONFIG, RemoteObjects, MsgpackCodec, DeadReckon,
        SessionClient: { getCurrentSession: () => session, getCurrentMember: () => ({ id: 'local' }) },
        ObjectSync: { getObject: id => records.get(id),
            updateObject: (id, data) => writes.push({ id, data }),
            isDataConfirmed: (id, fields) => Object.entries(fields).every(
                ([key, value]) => records.get(id)?.confirmed?.[key] === value) },
        isSessionMode: () => true,
        SendGate: { shouldSend: () => true },
        OBJECT_TYPES: { SHIP: 'ship', BULLET: 'bullet', ASTEROID: 'asteroid' },
        TURN_CONTROL_MODE: { KEYBOARD_RATE: 0, ANALOG_TARGET: 1 },
        normalizeTurnControlMode: mode => mode || 0,
        getShipTurnSpeed: () => 0.125,
        performance: { now: () => now },
        resolveTerminalSession: () => null,
        isDeterministicMode: () => deterministic,
        sizeToNormalizedX: size => size,
        sizeToNormalizedY: size => size,
        velocityToNormalizedDeltaX: velocity => velocity / 60,
        velocityToNormalizedDeltaY: velocity => velocity / 60,
        wrapNormalized: value => value,
        wrapMarginX: () => 0, wrapMarginY: () => 0,
        AudioSystem: { playFire() { fires++; } },
        rampInputToward: (_current, target) => target,
    };
    const production = loadInlineGameFunctions([
        'Ship', 'Asteroid', 'Bullet', 'getPoseTiming', 'getSimulationStepMs',
        'resetEntityHistory', 'captureCollisionState', 'beginSimulationStep',
        'finishSimulationStep', 'advancePresentationTime', 'getPresentationTime',
        'isShipDiscontinuity', 'applyRemoteShipState',
        'getDeterministicIngestBaselinePerf', 'getDeterministicJoinBaselinePerf',
        'createDeadReckoningState', 'getBallisticPredictionFrames',
        'createKinematicPresentation', 'lifecycleSampleData', 'hasLifecycleResetAnchor', 'isLifecycleFrozen',
        'currentKinematicData', 'getKinematicInstance', 'refreshQueuedKinematicUpdate',
        'sampleBulletPresentation', 'syncLocalBullets',
    ], dependencies);
    Object.assign(DeadReckon, createDeadReckoningPolicy({
        config: CONFIG, nowMs: () => now,
        velocityToDeltaX: value => value / 60,
        velocityToDeltaY: value => value / 60,
        shortestAngleDelta: (to, from) => to - from,
        createState: production.createDeadReckoningState,
        getMaxPredictionFrames: state => state.predictionFrames,
    }));
    return { ...production, game, records, session, writes, CONFIG, simulationTiming, RemoteObjects,
        at: value => { now = value; },
        mode: value => { deterministic = value; },
        fireCount: () => fires,
        clockReady: value => { initialized = value; } };
}

test('remote canonical flags and identity survive a kinematic-only presentation', () => {
    const h = harness();
    const ship = new h.Ship(0, 0);
    h.records.set('ship', { data: {
        x: 0.3, y: 0.4, angle: 1, memberId: 'remote',
        invulnerable: 180, thrusting: true, colorIndex: 2, respawnEpoch: 0,
        sampleAt: 10_900,
    } });
    h.applyRemoteShipState(ship, { x: 0.31, y: 0.41, angle: 1.1 },
        { objectId: 'ship' });
    assert.equal(ship.x, 0.31);
    assert.equal(ship.memberId, 'remote');
    assert.equal(ship.thrusting, true);
    assert.equal(ship.colorIndex, 2);
    assert.ok(Math.abs(ship.invulnerable - 175.8) < 1e-9);
    assert.equal(h.isShipDiscontinuity(ship, { respawnEpoch: 0, invulnerable: 180 }), false);
    assert.equal(h.isShipDiscontinuity(ship, { respawnEpoch: 0, invulnerable: 179 }), false);
    assert.equal(h.isShipDiscontinuity(ship, { respawnEpoch: 1, invulnerable: 180 }), true);
    assert.equal(h.isShipDiscontinuity(ship, { respawnEpoch: 1, invulnerable: 179 }), false);
});

test('buffered firing activation follows the shooter delay and emits sound once', () => {
    const h = harness();
    h.mode(false);
    const bullet = new h.Bullet(0.2, 0.3, 1, 0);
    const record = { ownerMemberId: 'owner', data: { bornAt: 10_900 } };
    h.sampleBulletPresentation(bullet, record);
    assert.equal(bullet.presentationHidden, true);
    assert.equal(h.fireCount(), 0);
    h.at(1150);
    h.sampleBulletPresentation(bullet, record);
    assert.equal(bullet.presentationHidden, false);
    assert.equal(h.fireCount(), 1);
    h.sampleBulletPresentation(bullet, record);
    assert.equal(h.fireCount(), 1);
});

test('production adapter uses the sample clock through asymmetric delivery and catch-up steps', () => {
    for (const [uplink, downlink] of [[10, 80], [80, 10], [50, 50]]) {
        for (const fps of [30, 60, 120, 144]) {
            const h = harness();
            const presenter = h.createKinematicPresentation();
            const arrival = 1000 + uplink + downlink;
            const consumed = Math.ceil(arrival / (1000 / fps)) * 1000 / fps;
            h.at(consumed);
            const data = {
                type: 'asteroid', x: 0.2, y: 0.3, angle: 0,
                velocityX: 0.2, velocityY: 0, rotationSpeed: 0.01,
                sampleAt: 11_000,
            };
            const record = { data, validAt: 11_000 + uplink, arrivalTime: arrival,
                arrivalServerTime: 10_000 + arrival, version: 1, ownerMemberId: 'owner' };
            const facts = { type: 'asteroid' };
            presenter.ingest('a', data, facts, record,
                { presentationTime: consumed - 30 });
            let previous;
            for (const time of [1200, 1200 + 1000 / 60, 1200 + 2000 / 60]) {
                const pose = presenter.sample('a', facts, record, { presentationTime: time });
                assert.ok(Math.abs(pose.x - (0.2 + (time - 1000) * 0.0002)) < 1e-9);
                assert.ok(Math.abs(pose.angle - (time - 1000) * 0.0006) < 1e-9);
                if (previous) assert.ok(pose.x > previous.x, 'catch-up steps sample successive times');
                previous = pose;
            }
        }
    }
});

test('respawn resets simulation, sweep, and render history without blending a teleport', () => {
    const h = harness();
    const ship = new h.Ship(0.1, 0.9);
    ship.angle = 2;
    ship.reset();
    for (const prefix of ['_prev', '_collisionPrev', '_simulation']) {
        assert.equal(ship[`${prefix}X`], 0.5);
        assert.equal(ship[`${prefix}Y`], 0.5);
        assert.equal(ship[`${prefix}Angle`], -Math.PI / 2);
    }
    assert.equal(ship.respawnEpoch, 1);
});

test('birth timestamps stay cold while current poses use the shared batch anchor', () => {
    const h = harness();
    h.beginSimulationStep(1, 980);
    const ship = new h.Ship(0.5, 0.5);
    const data = ship.toSyncData();
    assert.equal(data.sampleAt, 10_980);
    assert.equal(data.sampleTick, undefined);
    assert.equal(h.simulationTiming.tick, 1, 'simulation still advances every frame');
    assert.equal(ship.toUpdateData().sampleAt, undefined);
    assert.equal(ship.toUpdateData().sampleTick, undefined);
    assert.equal(ship.toUpdateData().respawnEpoch, undefined);
    h.finishSimulationStep();
    h.at(1300);
    assert.equal(data.sampleAt, 10_980, 'birth remains anchored to the simulation step');
    assert.equal(h.getDeterministicIngestBaselinePerf(
        { data, validAt: 11_300, arrivalTime: 1300, version: 1 }, {}), 980);
    assert.equal(h.getDeterministicIngestBaselinePerf(
        { data, validAt: 11_300, arrivalTime: 1300, version: 2 }, {}), 980,
        'an ownership-only version must preserve the exact birth anchor');
    assert.equal(h.getDeterministicIngestBaselinePerf(
        { data: { ...data, sampleAt: 0 }, validAt: 11_300, arrivalTime: 1300, version: 3 }, {}), 1300,
        'a retired birth anchor must not timestamp a newer pose');
    h.clockReady(false);
    assert.equal(h.getPoseTiming().sampleAt, undefined, 'no invented pre-bootstrap wall axis');
    assert.equal(h.getDeterministicIngestBaselinePerf(
        { data: {}, arrivalTime: 1250 }, {}), 1220);
});

test('queued ship poses refresh without resending confirmed lifecycle epochs', () => {
    const h = harness();
    h.game.ship = new h.Ship(0.5, 0.5);
    h.game.multiplayer.myShipObjectId = 'ship';
    const record = { data: { type: 'ship', sampleAt: 10_000 }, ownerMemberId: 'local',
        confirmed: { respawnEpoch: 0 } };
    h.records.set('ship', record);
    h.game.ship.x = 0.7;
    assert.deepEqual(h.refreshQueuedKinematicUpdate('ship', record),
        { ...h.game.ship.toUpdateData(), sampleAt: 0 });
    record.data.sampleAt = 0;
    assert.equal(h.refreshQueuedKinematicUpdate('ship', record).sampleAt, 0,
        'a failed retirement must be retried despite optimistic local data');
    record.confirmed.sampleAt = 0;
    assert.deepEqual(h.refreshQueuedKinematicUpdate('ship', record), h.game.ship.toUpdateData());
    h.game.ship.reset();
    assert.equal(h.refreshQueuedKinematicUpdate('ship', record).respawnEpoch, 1);
    assert.equal(h.refreshQueuedKinematicUpdate('ship', record).respawnEpoch, 1,
        'failed or in-flight lifecycle writes remain retryable');
    record.confirmed.respawnEpoch = 1;
    assert.equal(h.refreshQueuedKinematicUpdate('ship', record).respawnEpoch, undefined);
    record.ownerMemberId = 'remote';
    assert.equal(h.refreshQueuedKinematicUpdate('ship', record), null);
});

test('all motion serializers omit timing, even as the simulation advances every frame', () => {
    const h = harness();
    for (const Model of [h.Ship, h.Asteroid, h.Bullet]) {
        const entity = Object.assign(Object.create(Model.prototype),
            { x: 0.2, y: 0.3, angle: 1, velocityX: 0.1, velocityY: 0,
                rotationSpeed: 0.01, lifetime: 42, respawnEpoch: 0 });
        const initial = entity.toUpdateData();
        h.beginSimulationStep(1, 1000);
        h.finishSimulationStep();
        assert.deepEqual(entity.toUpdateData(), initial);
        assert.equal('sampleAt' in initial || 'sampleTick' in initial || 'respawnEpoch' in initial, false);
    }
});

test('frozen claims retry until confirmation then stop even when the send gate is always eligible', () => {
    const h = harness();
    const bullet = new h.Bullet(0.2, 0.3, 1, 0);
    Object.assign(bullet, { ownerMemberId: 'local', syncObjectId: 'bullet', pendingHit: true });
    h.game.bullets.push(bullet);
    h.syncLocalBullets();
    h.syncLocalBullets();
    assert.equal(h.writes.length, 2, 'missing confirmations leave the claim retryable');
    h.records.set('bullet', { confirmed: bullet.toUpdateData() });
    h.at(2000);
    h.syncLocalBullets();
    assert.equal(h.writes.length, 2, 'confirmed frozen state has no heartbeat payload');
});

test('collision history follows simulation poses rather than intervening render samples', () => {
    const h = harness();
    const asteroid = { x: 0.1, y: 0.2, angle: 0.3 };
    h.game.astervoids.push(asteroid);
    h.beginSimulationStep(1, 1000);
    asteroid.x = 0.2;
    asteroid.angle = 0.4;
    h.finishSimulationStep();
    asteroid.x = 0.25;
    asteroid.angle = 0.5;
    h.beginSimulationStep(1, 1016);
    assert.equal(asteroid._collisionPrevX, 0.2);
    assert.equal(asteroid._collisionPrevAngle, 0.4);
    h.finishSimulationStep();
});

test('shared presentation time advances monotonically while delay increases', () => {
    const h = harness();
    h.advancePresentationTime(1000);
    let previous = h.getPresentationTime(1000);
    for (const fps of [30, 60, 120, 144]) {
        for (let frame = 1; frame <= fps; frame++) {
            const time = 1000 + frame * 1000 / fps;
            if (time <= h.simulationTiming.lastPresentationPerf) continue;
            h.advancePresentationTime(time);
            const sampled = h.getPresentationTime(time);
            assert.ok(sampled > previous);
            previous = sampled;
        }
    }
    assert.ok(h.simulationTiming.presentationDelayMs <= 130 + 1e-9);
});

test('production firing references the pre-step muzzle without adding ship velocity', () => {
    const h = harness();
    const ship = new h.Ship(0.2, 0.4);
    ship.syncObjectId = 'ship';
    ship.memberId = 'member';
    ship.angle = 0;
    ship.velocityX = 0.75;
    h.beginSimulationStep(1, 1000);
    const bullet = ship.shoot();
    const shot = MsgpackCodec.decode(bullet.shot);
    assert.equal(bullet.x, 0.225);
    assert.equal(bullet.velocityX, 1, 'retain actual production bullet physics');
    assert.equal(shot.shipId, 'ship');
    assert.equal(shot.muzzleX, bullet.x);
    assert.deepEqual(Object.keys(shot), ['shipId', 'muzzleX', 'muzzleY']);
    assert.ok(Math.abs(bullet.bornAt - (11_000 - 1000 / 60)) < 1e-9);
    h.finishSimulationStep();
});

test('pose and discontinuity fields survive production positional schemas', () => {
    SchemaCodec.replaceAll(WireSchemas.SCHEMAS);
    for (const id of [1, 2, 3]) {
        const schema = SchemaCodec.get(id);
        const data = { sampleAt: 1_700_000_000_123.5, sampleTick: 12 };
        if (id === 1) data.respawnEpoch = 2;
        else data.bornAt = 1_700_000_000_000;
        const decoded = SchemaCodec.decode(schema, SchemaCodec.encode(schema, data));
        assert.deepEqual(decoded, data);
    }
});

test('inactive replicas hold their displayed pose and resume from rebased anchors', () => {
    const h = harness();
    const ship = new h.Ship(0.4, 0.3);
    h.game.multiplayer.remoteShips.set('ship', ship);
    h.session.members.push({ id: 'owner', simulationActive: false });
    const record = { ownerMemberId: 'owner', data: {
        type: 'ship', x: 0.2, y: 0.3, sampleAt: 1000,
        velocityX: 0.2, invulnerable: 120,
    }, validAt: 11_000, simulationAnchorReset: true };
    const facts = { type: 'ship' };
    const presenter = h.createKinematicPresentation();
    presenter.ingest('ship', record.data, facts, record, { presentationTime: 970 });
    const pose = presenter.sample('ship', facts, record, { presentationTime: 10_000 });
    assert.equal(pose.x, 0.4, 'hidden owner must not continue predicted motion');
    assert.equal(h.getDeterministicIngestBaselinePerf(record, facts), 1000,
        'resume must not project the payload through the idle interval');
    h.session.simulationSuspended = true;
    h.session.members[0].simulationActive = true;
    assert.equal(h.isLifecycleFrozen(record), true, 'whole-session suspension wins');
});

test('ballistic budget includes serialized cadence and unseen transit but stays bounded', () => {
    const h = harness();
    h.simulationTiming.presentationDelayMs = 250;
    h.RemoteObjects.memberDelays.set('owner', {
        remoteSendInterval: 1000, packetIntervals: [1500, 1500],
        lagSamples: [750, 750],
    });
    assert.equal(h.getBallisticPredictionFrames('owner'), 120);
    assert.equal(h.getBallisticPredictionFrames('unknown'), 30);
    h.RemoteObjects.memberDelays.get('owner').packetIntervals = [10_000];
    assert.equal(h.getBallisticPredictionFrames('owner'), 120);
});

test('production pose sampling is independent of packet-consumption frame rate', () => {
    const h = harness();
    for (const fps of [30, 60, 120, 144]) {
        const policy = createDeadReckoningPolicy({
            config: h.CONFIG, nowMs: () => 1000,
            velocityToDeltaX: value => value / 60,
            velocityToDeltaY: value => value / 60,
            shortestAngleDelta: (to, from) => to - from,
            createState: h.createDeadReckoningState,
        });
        const data = { type: 'asteroid', x: 0.2, y: 0.3, angle: 0,
            velocityX: 0.2, velocityY: 0, rotationSpeed: 0.01, sampleAt: 10_900 };
        policy.updateState('a', data, 900, false);
        for (let time = 900; time < 1100; time += 1000 / fps) policy.getReckoned('a', time);
        const sampled = policy.getReckoned('a', 1100);
        assert.ok(Math.abs(sampled.x - 0.24) < 1e-9);
        assert.ok(Math.abs(sampled.angle - 0.12) < 1e-9);
    }
});
