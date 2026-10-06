import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './test-support/classic-module.mjs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const { SCHEMAS } = require('./wwwroot/js/game-wire-schemas.js');
const { SHARED_DEFAULTS } = require('./wwwroot/js/game-config.js');
const ReplicationRuntime = require('./wwwroot/js/replication-runtime.js');
const ReplicationPresentation = require('./wwwroot/js/replication-presentation.js');
const { createShipGate, createControlEdgeGate } = require('./wwwroot/js/replication-send-policy.js');

SchemaCodec.replaceAll(SCHEMAS);
const shipId = '00000001-1111-2222-3333-aabbccddeeff';
const ownerId = '00000002-1111-2222-3333-aabbccddeeff';
const viewerId = '00000003-1111-2222-3333-aabbccddeeff';
const epoch = 1_800_000_000_000;
const positionQuantum = 2 / 65535;

async function simulate({ deterministic, deltaEncoding, scoreFrames }) {
    let now = 0;
    let version = 1;
    let receiverHandlers;
    const updates = [];
    const config = {
        ...SHARED_DEFAULTS,
        DEADRECKON_MAX_FRAMES: 30, DEADRECKON_SMOOTH_MS: 90, DEADRECKON_SNAP_DIST: 0.2,
        SHIP_FRICTION: 0.99, SHIP_THRUST: 0.009, SHIP_BRAKE_STRENGTH: 0.01,
        SHIP_SIZE: 0.02, SHIP_TURN_ACCEL_TIME: 0, SHIP_TURN_DECEL_TIME: 0,
        SHIP_INPUT_REPLAY_ENABLED: true, SHIP_SEND_ON_CHANGE_ENABLED: true,
        SHIP_EDGE_SEND_ENABLED: true, SEND_ON_CHANGE_HEARTBEAT_MS: 250,
        SEND_ON_CHANGE_VEL_EPS: 1e-4, SEND_ON_CHANGE_ROT_EPS: 1e-4,
        INTERPOLATION_ENABLED: true, SNAPSHOT_BUFFER_SIZE: 6, SNAP_THRESHOLD: 0.2
    };
    function connect(memberId) {
        const handlers = {};
        const SessionClient = {
            on: (event, handler) => { handlers[event] = handler; },
            isInSession: () => true,
            getCurrentMember: () => ({ id: memberId }),
            updateObjects: async (batch, sequence, interval) => {
                assert.equal(memberId, ownerId);
                version++;
                const received = batch.map(update => {
                    assert.equal(update.schemaId, 1);
                    const schema = SchemaCodec.get(update.schemaId);
                    return {
                        id: update.objectId, version,
                        data: SchemaCodec.decode(schema, SchemaCodec.encode(schema, update.data))
                    };
                });
                updates.push({ at: now, data: structuredClone(batch[0].data) });
                receiverHandlers.onObjectsUpdated(
                    received, epoch + now, ownerId, sequence, sequence, interval, epoch + now);
                return { versions: { [shipId]: version }, memberSequence: sequence };
            }
        };
        const sync = loadClassicModule('object-sync.js', 'ObjectSync', {
            SessionClient, AuthoritativeObject, MsgpackCodec, window: {},
            performance: { now: () => now }
        });
        sync.init();
        sync.configure({ deltaEncoding });
        sync.setSchemaIdSelector(() => 1);
        return { sync, handlers };
    }
    const owner = connect(ownerId);
    const receiver = connect(viewerId);
    receiverHandlers = receiver.handlers;
    const game = {
        ship: null,
        multiplayer: { myShipObjectId: shipId, remoteShips: new Map() }
    };
    const dead = {};
    const delayMs = 50;
    const remote = {
        ...ReplicationPresentation.createSnapshotInterpolationPolicy({
            config, nowMs: () => now, validAtToTime: at => at - epoch,
            getDelayForMember: () => delayMs,
            velocityToDeltaX: velocity => velocity,
            velocityToDeltaY: velocity => velocity,
            shortestDeltaX: (a, b) => b - a, shortestDeltaY: (a, b) => b - a,
            wrapX: value => value, wrapY: value => value,
            distanceBetween: (a, b) => Math.hypot(b.x - a.x, b.y - a.y)
        }),
        clock: { offsetInitialized: false },
        isClockOffsetInitialized: () => false,
        getDelayForMember: () => delayMs
    };
    const production = loadInlineGameFunctions([
        'Ship', 'ShipInvulnerability', 'assignDefined', 'rampInputToward',
        'normalizeTurnControlMode', 'getShipTurnSpeed', 'shortestAngleDelta',
        'createDeadReckoningState', 'replayDeadReckonedShip',
        'getDeterministicIngestBaselinePerf', 'getDeterministicJoinBaselinePerf',
        'createKinematicPresentation', 'applyShipReplicaData'
    ], {
        CONFIG: config, game, ObjectSync: receiver.sync,
        DeadReckon: dead, RemoteObjects: remote, ReplicationPresentation,
        performance: { now: () => now },
        isDeterministicMode: () => deterministic,
        OBJECT_TYPES: { SHIP: 'ship' },
        TURN_CONTROL_MODE: { KEYBOARD_RATE: 0, ANALOG_RATE: 1, ANALOG_TARGET: 2 },
        velocityToNormalizedDeltaX: velocity => velocity / config.TARGET_FPS,
        velocityToNormalizedDeltaY: velocity => velocity / config.TARGET_FPS,
        wrapNormalized: value => ((value % 1) + 1) % 1,
        wrapMarginX: () => 0, wrapMarginY: () => 0,
        resolveTerminalSession: () => null,
        calculateShipRateAngularPredictionWindow: () => null
    });
    Object.assign(dead, ReplicationPresentation.createDeadReckoningPolicy({
        config, nowMs: () => now,
        velocityToDeltaX: velocity => velocity / config.TARGET_FPS,
        velocityToDeltaY: velocity => velocity / config.TARGET_FPS,
        shortestAngleDelta: production.shortestAngleDelta,
        createState: production.createDeadReckoningState,
        shouldReplay: state => state.clampAngular,
        replay: production.replayDeadReckonedShip
    }));
    const publisher = loadInlineGameFunctions(['syncLocalShip', 'syncLocalShipScore'], {
        CONFIG: config, game, ObjectSync: owner.sync,
        isSessionMode: () => true, isDeterministicMode: () => deterministic,
        ShipSendGate: createShipGate({
            config, nowMs: () => now, isDeterministic: () => deterministic,
            getTransitionKey: ship => ship.invulnerabilityRevision
        }),
        ShipControlGate: createControlEdgeGate({
            getRotationEpsilon: () => config.SEND_ON_CHANGE_ROT_EPS
        })
    });
    game.ship = new production.Ship(0.4, 0.5);
    Object.assign(game.ship, {
        angle: 0, velocityX: 0.2, thrusting: true,
        thrustInput: 0.2 * (1 - config.SHIP_FRICTION) / config.SHIP_THRUST,
        memberId: ownerId, participantId: ownerId
    });
    const initialData = { ...game.ship.toSyncData(), ...game.ship.toUpdateData() };
    for (const connection of [owner, receiver]) {
        connection.handlers.onSessionJoined({ objects: [{
            id: shipId, data: structuredClone(initialData), version,
            ownerMemberId: ownerId, creatorMemberId: ownerId, scope: 'Member'
        }] });
    }
    const runtime = ReplicationRuntime.createRuntime({
        store: receiver.sync,
        getCurrentMemberId: () => viewerId,
        getActiveMemberIds: () => [ownerId, viewerId]
    });
    runtime.registerType({
        type: 'ship', classify: () => 'replica',
        getInstance: id => game.multiplayer.remoteShips.get(id),
        getInstances: () => game.multiplayer.remoteShips,
        createReplica: record => {
            const ship = new production.Ship(record.data.x, record.data.y);
            game.multiplayer.remoteShips.set(record.id, ship);
            return ship;
        },
        apply: production.applyShipReplicaData,
        remove: id => game.multiplayer.remoteShips.delete(id),
        presentation: production.createKinematicPresentation()
    });
    publisher.syncLocalShip();
    await owner.sync.flushUpdates();
    runtime.reconcileType('ship', { renderTime: now });
    const points = [game.multiplayer.remoteShips.get(shipId).x];
    for (let frame = 1; frame <= 15; frame++) {
        now = frame * 1000 / config.TARGET_FPS;
        game.ship.update();
        if (scoreFrames.includes(frame)) {
            game.ship.score += 40;
            publisher.syncLocalShipScore(true);
            await owner.sync.flushUpdates();
        }
        publisher.syncLocalShip();
        await owner.sync.flushUpdates();
        runtime.reconcileType('ship', { renderTime: now });
        points.push(game.multiplayer.remoteShips.get(shipId).x);
    }
    return { points, updates, score: receiver.sync.getObject(shipId).data.score };
}

for (const deterministic of [true, false]) {
    for (const deltaEncoding of [true, false]) {
        test(`scoring preserves replica motion (deterministic=${deterministic}, delta=${deltaEncoding})`, async () => {
            const control = await simulate({ deterministic, deltaEncoding, scoreFrames: [] });
            for (const scoreFrames of [[9], [12], [9, 12]]) {
                const result = await simulate({ deterministic, deltaEncoding, scoreFrames });
                assert.equal(result.score, scoreFrames.length * 40, 'score remains durable');
                assert.equal(result.updates.filter(update => update.data.score > 0).length,
                    scoreFrames.length, 'confirmed scores add no repeated publications');
                for (let frame = 1; frame < result.points.length; frame++) {
                    const step = result.points[frame] - result.points[frame - 1];
                    const controlStep = control.points[frame] - control.points[frame - 1];
                    assert.ok(step >= -positionQuantum,
                        `score frames ${scoreFrames}: backwards motion at frame ${frame}`);
                    assert.ok(Math.abs(step - controlStep) <= positionQuantum,
                        `score frames ${scoreFrames}: uneven motion at frame ${frame}`);
                    assert.ok(Math.abs(result.points[frame] - control.points[frame]) <= positionQuantum,
                        `score frames ${scoreFrames}: stale pose at frame ${frame}`);
                }
            }
        });
    }
}
