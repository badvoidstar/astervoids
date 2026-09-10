import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');

function section(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `production section: ${start}`);
    return source.slice(first, last);
}

function harness({ deterministic = true, width = 1, height = 1 } = {}) {
    let now = 1200;
    let sampleAt = 1200;
    let randomValues = [];
    let randomCalls = 0;
    const records = new Map();
    const handlers = new Map();
    const removed = [];
    class Asteroid {
        constructor(x, y, radius, velocityX, velocityY) {
            Object.assign(this, {
                x, y, radius, boundRadius: radius, velocityX, velocityY,
                angle: 0, rotationSpeed: 0, vertices: [{ angle: 0, distance: radius }]
            });
        }
        static fromSyncData(data) {
            const asteroid = new Asteroid(data.x, data.y, data.radius,
                data.velocityX, data.velocityY);
            asteroid.fromSyncData(data);
            return asteroid;
        }
        fromSyncData(data) {
            for (const key of ['x', 'y', 'angle', 'velocityX', 'velocityY', 'rotationSpeed']) {
                if (data[key] !== undefined) this[key] = data[key];
            }
        }
    }
    const game = {
        ship: null, state: 'playing', speedMultiplier: 1,
        astervoids: [], bullets: [], cosmeticAstervoids: [],
        multiplayer: {
            myShipObjectId: 'my-ship',
            collisionEffects: new Map(),
            remoteShips: new Map()
        }
    };
    const members = [{ id: 'me' }, { id: 'other' }];
    const config = {
        TARGET_FPS: 60, MAX_EXTRAPOLATION: 1, BULLET_RADIUS: 0,
        SHIP_SIZE: 0, SPAWN_MIN_DISTANCE: 0.25,
        ASTEROID_BASE_SPEED: 0.1, ASTEROID_SPEED_VARIANCE: 0,
        INITIAL_ASTEROID_RADIUS: 0.05
    };
    const context = vm.createContext({
        CONFIG: config, game, Asteroid, Bullet: class Bullet {},
        OBJECT_TYPES: { ASTEROID: 'asteroid', SHIP: 'ship' },
        getPoseTiming: () => ({ sampleAt, sampleTick: 1 }),
        getGameWidth: () => width, getGameHeight: () => height,
        getReferenceDimension: () => Math.min(width, height),
        wrapMarginX: () => 0, wrapMarginY: () => 0,
        shortestAngleDelta: (to, from) => Math.atan2(Math.sin(to - from), Math.cos(to - from)),
        shortestRemoteDeltaX: (from, to) => to - from,
        shortestRemoteDeltaY: (from, to) => to - from,
        isDeterministicMode: () => deterministic,
        isSessionMode: () => true,
        performance: { now: () => now },
        resolveTerminalSession: () => null,
        resetEntityHistory: entity => {
            for (const axis of ['X', 'Y', 'Angle']) {
                entity[`_prev${axis}`] = entity[axis.toLowerCase()];
                entity[`_collisionPrev${axis}`] = entity[axis.toLowerCase()];
                entity[`_simulation${axis}`] = entity[axis.toLowerCase()];
            }
        },
        seedReplicaAtTerminalTarget: entity => entity,
        deterministicTerminalState: { transitions: new Map() },
        RemoteObjects: {
            projectSpawnData: (data, seconds) => ({
                ...data,
                x: data.x + (data.velocityX || 0) * seconds * Math.min(width, height) / width,
                y: data.y + (data.velocityY || 0) * seconds * Math.min(width, height) / height,
                angle: (data.angle || 0) + (data.rotationSpeed || 0) * 60 * seconds
            }),
            remove: id => removed.push(`buffer:${id}`),
            states: new Map()
        },
        DeadReckon: { states: new Map(), remove: id => removed.push(`dr:${id}`) },
        SendGate: { remove: id => removed.push(`send:${id}`) },
        SessionClient: {
            on: (name, callback) => handlers.set(name, callback),
            getCurrentMember: () => ({ id: 'me' }),
            getSessionEpoch: () => 1,
            getCurrentSession: () => ({ members })
        },
        ObjectSync: {
            on: (name, callback) => handlers.set(name, callback),
            getObject: id => records.get(id),
            getObjectsByType: type => [...records.values()].filter(record => record.data.type === type),
            handleOwnershipMigration: migrations => {
                for (const migration of migrations) {
                    const record = records.get(migration.objectId);
                    if (record && record.version < migration.newVersion) {
                        record.ownerMemberId = migration.newOwnerId;
                        record.version = migration.newVersion;
                    }
                }
            }
        },
        replicationRuntime: { handleOwnershipMigrations() {} },
        resetAuthorityTiming() {},
        CollisionEffects: { resolveTarget: id => removed.push(`cue:${id}`) },
        simRandom: () => { randomCalls++; return randomValues.shift() ?? 0.5; },
        simRandomRange: () => 0,
        simRng: { nextSeed: () => 1 },
        getEffectiveAsteroidAspectScales: () => ({ speedScale: 1, radiusScale: 1 }),
        createSyncedAsteroid: async asteroid => game.astervoids.push(asteroid)
    });
    vm.runInContext(
        section('    function projectLifecyclePose(', '    // Ship descriptor:')
        + section('    function interpNormalized(', '    function sampleTerminalTransition(')
        + section('    async function spawnAsteroidAwayFromShip(', '    /**\n     * Compute the compact bullet-impact')
        + section("                ObjectSync.on('onObjectDeleted',", '                // Handle reconciliation failure')
        + section("    SessionClient.on('onSimulationActivityChanged',", '    // A hidden browser'),
        context);
    return {
        api: context, game, records, handlers, removed, members, config,
        setNow(value) { now = value; },
        setSampleAt(value) { sampleAt = value; },
        setRandom(values) { randomValues = [...values]; randomCalls = 0; },
        get randomCalls() { return randomCalls; }
    };
}

test('ownership adoption projects canonical samples, never a displayed puppet pose', () => {
    const h = harness();
    const data = { type: 'asteroid', x: 0.2, y: 0.3, angle: 0,
        radius: 0.05, velocityX: 0.1, velocityY: 0, rotationSpeed: 0.01, sampleAt: 1000 };
    const record = { id: 'a', ownerMemberId: 'other', version: 1, data, validAt: 1150 };
    h.records.set('a', record);
    const asteroid = h.api.Asteroid.fromSyncData(data);
    Object.assign(asteroid, { syncObjectId: 'a', x: 0.12,
        _lastRenderedX: 0.1, _lastRenderedY: 0.3, _lastRenderedAngle: -0.2 });
    h.game.astervoids.push(asteroid);
    h.api.migrateKinematicAuthority([{ objectId: 'a', newOwnerId: 'me', newVersion: 2 }]);
    assert.ok(Math.abs(asteroid.x - 0.22) < 1e-12);
    assert.equal(asteroid.velocityX, 0.1);
    assert.equal(asteroid._collisionPrevX, asteroid.x);
    assert.equal(asteroid._simulationSampleAt, 1200);
    const canonicalX = asteroid.x;
    h.api.withLocalRenderInterpolation(1, () => assert.equal(asteroid.x, 0.1));
    assert.equal(asteroid.x, canonicalX, 'render correction must restore physics');
    assert.deepEqual(h.removed, ['dr:a', 'buffer:a', 'send:a']);
    h.setNow(1500);
    h.api.withLocalRenderInterpolation(1, () => assert.equal(asteroid.x, canonicalX));
    assert.equal(asteroid._lifecycleCorrection, undefined);
    h.api.migrateKinematicAuthority([{ objectId: 'a', newOwnerId: 'me', newVersion: 2 }]);
    assert.equal(asteroid._lifecycleCorrection, undefined, 'duplicate metadata cannot reseed motion');
});

test('birth sample time, not operation flush time, anchors owner adoption', () => {
    const h = harness();
    const data = { x: 0.1, y: 0.2, radius: 0.05, velocityX: 0.2,
        velocityY: 0, angle: 0, sampleAt: 1000 };
    const asteroid = h.api.adoptCanonicalAsteroid(
        { id: 'child', version: 1, validAt: 1190, data });
    assert.ok(Math.abs(asteroid.x - 0.14) < 1e-12);
    assert.equal(data.x, 0.1, 'canonical birth record stays immutable');
});

test('resumed idle snapshots never project the idle interval', () => {
    const h = harness();
    h.setSampleAt(60000);
    const data = { x: 0.1, y: 0.2, radius: 0.05, velocityX: 0.2,
        velocityY: 0, angle: 0, sampleAt: 1000 };
    for (const [id, record, facts] of [
        ['join', {}, { joinSnapshot: true }],
        ['resume', { lifecycleResumeFromIdle: true }, {}]
    ]) {
        const asteroid = h.api.adoptCanonicalAsteroid({ id, version: 1, data, ...record }, null, facts);
        assert.equal(asteroid.x, 0.1);
        assert.equal(asteroid.velocityX, 0.2);
    }
});

test('activity snapshots installed before migration still seed canonical resumed ownership', () => {
    const h = harness();
    h.setSampleAt(60000);
    const data = { type: 'asteroid', x: 0.1, y: 0.2, radius: 0.05,
        velocityX: 0.2, velocityY: 0, angle: 0, sampleAt: 1000 };
    const record = { id: 'a', version: 3, ownerMemberId: 'me', validAt: 60000, data };
    h.records.set('a', record);
    const asteroid = h.api.Asteroid.fromSyncData(data);
    Object.assign(asteroid, { syncObjectId: 'a', x: 0.5,
        _lastRenderedX: 0.4, _lastRenderedY: 0.2 });
    h.game.astervoids.push(asteroid);
    h.api.applyAsteroidActivity({
        resetObjectIds: ['a'],
        migratedObjects: [{ objectId: 'a', newOwnerId: 'me', newVersion: 3 }]
    });
    assert.equal(asteroid.x, 0.1, 'no capped idle-time projection is permitted');
    assert.equal(asteroid.velocityX, 0.2);
    assert.equal(asteroid._simulationX, 0.1);
    assert.equal(record.data.sampleAt, 1000, 'generic canonical payload stays opaque');
    assert.equal(h.api.lifecycleSampleData(record).sampleAt, 60000);
    h.api.withLocalRenderInterpolation(1, () => assert.equal(asteroid.x, 0.4));
    assert.equal(asteroid.x, 0.1);
});

test('activity migration without suspension projects canonical motion at the preserved sample time', () => {
    const h = harness();
    const record = { id: 'a', version: 3, ownerMemberId: 'me', validAt: 1150,
        data: { type: 'asteroid', x: 0.1, y: 0.2, radius: 0.05,
            velocityX: 0.2, velocityY: 0, angle: 0, sampleAt: 1000 } };
    h.records.set('a', record);
    h.api.applyAsteroidActivity({
        resetObjectIds: [],
        migratedObjects: [{ objectId: 'a', newOwnerId: 'me', newVersion: 3 }]
    });
    assert.ok(Math.abs(h.game.astervoids[0].x - 0.14) < 1e-12);
});

test('temporal reset anchors survive metadata transfer but not a newer authored sample', () => {
    const h = harness();
    const record = { version: 3, validAt: 60000, simulationCanonicalVersion: 3,
        simulationAnchorReset: true, data: { sampleAt: 1000 } };
    assert.equal(h.api.lifecycleSampleData(record).sampleAt, 60000);
    record.version = record.ownershipMigrationVersion = 4;
    assert.equal(h.api.lifecycleSampleData(record).sampleAt, 60000);
    record.version = 5;
    record.data = { sampleAt: 60100 };
    record.validAt = 60150;
    assert.equal(h.api.lifecycleSampleData(record).sampleAt, 60100);
});

test('activity callback respects store filtering of stale reset versions', () => {
    const h = harness();
    const record = { id: 'a', version: 5, ownerMemberId: 'me', validAt: 1200,
        data: { type: 'asteroid', x: 0.4, y: 0.2, radius: 0.05,
            velocityX: 0.2, velocityY: 0, angle: 0, sampleAt: 1200 } };
    h.records.set('a', record);
    const asteroid = h.api.Asteroid.fromSyncData(record.data);
    asteroid.syncObjectId = 'a';
    h.game.astervoids.push(asteroid);
    h.api.ObjectSync.handleSimulationActivity = info => {
        info.resetObjectIds = [];
        return true;
    };
    h.handlers.get('onSimulationActivityChanged')({
        resetObjectIds: ['a'],
        migratedObjects: [],
        objects: [{ id: 'a', version: 3 }]
    });
    assert.equal(asteroid.x, 0.4);
    assert.equal(record.simulationAnchorReset, undefined);
    assert.equal(asteroid._lifecycleCorrection, undefined);
});

test('replacement rigid transform includes the displayed parent rotation and centroid', () => {
    const h = harness({ width: 2, height: 1 });
    const child = { x: 0.45, y: 0.3, angle: 0, velocityX: -0.3, rotationSpeed: 0.07 };
    const pose = h.api.replacementChildDisplayPose(
        { x: 0.4, y: 0.3, angle: 0 },
        { x: 0.2, y: 0.1, angle: Math.PI / 2 }, child);
    assert.ok(Math.abs(pose.x - 0.2) < 1e-12);
    assert.ok(Math.abs(pose.y - 0.2) < 1e-12);
    assert.equal(pose.angle, Math.PI / 2);
    assert.equal(child.velocityX, -0.3);
    assert.equal(child.rotationSpeed, 0.07, 'fracture impulse remains canonical');
});

test('production replacement callback transfers corrected rigid pose to local and remote children', () => {
    const h = harness({ width: 2, height: 1 });
    const parentData = { type: 'asteroid', x: 0.4, y: 0.3, angle: 0,
        radius: 0.05, velocityX: 0.2, velocityY: 0, sampleAt: 1000 };
    const parent = h.api.Asteroid.fromSyncData(parentData);
    Object.assign(parent, { syncObjectId: 'parent', _lastRenderedX: 0.2,
        _lastRenderedY: 0.1, _lastRenderedAngle: Math.PI / 2 });
    h.game.astervoids.push(parent);
    const parentRecord = { id: 'parent', data: parentData, validAt: 1150 };
    h.handlers.get('onObjectDeleted')(parentRecord);
    const children = ['local', 'remote'].map((id, index) => ({
        id, version: 1, ownerMemberId: index ? 'other' : 'me',
        data: { type: 'asteroid', x: 0.45, y: 0.3, radius: 0.025,
            angle: 0, velocityX: -0.3, velocityY: 0.1, rotationSpeed: 0.07, sampleAt: 1000 }
    }));
    for (const child of children) h.records.set(child.id, child);
    h.handlers.get('onObjectReplaced')('parent', children, 1190);
    for (const child of children) {
        assert.ok(Math.abs(child.lifecycleDisplayPose.x - 0.2) < 1e-12);
        assert.ok(Math.abs(child.lifecycleDisplayPose.y - 0.2) < 1e-12);
        assert.equal(child.lifecycleDisplayPose.angle, Math.PI / 2);
        assert.equal(child.data.velocityX, -0.3);
        assert.equal(child.data.rotationSpeed, 0.07);
        assert.equal(child.replacementBaselinePerf, undefined, 'no timing bridge changes canonical motion');
    }
    assert.equal(parent._lifecycleReplaced, true);
    const owned = h.api.adoptCanonicalAsteroid(children[0]);
    const canonical = { x: owned.x, y: owned.y, angle: owned.angle };
    h.api.withLocalRenderInterpolation(1, () => {
        assert.ok(Math.abs(owned.x - 0.2) < 1e-12);
        assert.ok(Math.abs(owned.y - 0.2) < 1e-12);
    });
    assert.equal(owned.x, canonical.x);
    assert.equal(owned.y, canonical.y);
    assert.equal(owned.angle, canonical.angle);
});

test('historical fracture uses exact TOI parent metadata rather than the latest motion snapshot', () => {
    const h = harness({ width: 2, height: 1 });
    const parent = new h.api.Asteroid(0.8, 0.7, 0.1, 0.6, -0.2);
    Object.assign(parent, { syncObjectId: 'parent', angle: 2,
        _lastRenderedX: 0.2, _lastRenderedY: 0.1, _lastRenderedAngle: Math.PI / 2 });
    h.game.astervoids.push(parent);
    h.handlers.get('onObjectDeleted')({
        id: 'parent', version: 5, validAt: 1190,
        data: { type: 'asteroid', x: 0.8, y: 0.7, angle: 2,
            velocityX: 0.6, velocityY: -0.2, rotationSpeed: 0.2, sampleAt: 1150 }
    });
    const child = { id: 'child', version: 1, ownerMemberId: 'me',
        data: { type: 'asteroid', x: 0.45, y: 0.3, angle: 0, radius: 0.025,
            velocityX: -0.3, velocityY: 0.1, rotationSpeed: 0.07, sampleAt: 1000,
            parentX: 0.4, parentY: 0.3, parentAngle: 0 } };
    h.records.set('child', child);
    h.handlers.get('onObjectReplaced')('parent', [child], 1190);
    assert.ok(Math.abs(child.lifecycleDisplayPose.x - 0.2) < 1e-12);
    assert.ok(Math.abs(child.lifecycleDisplayPose.y - 0.2) < 1e-12);
    assert.equal(child.lifecycleDisplayPose.angle, Math.PI / 2);
    assert.equal(child.data.velocityX, -0.3);
    assert.equal(child.data.rotationSpeed, 0.07);
});

test('render-only corrections also apply in buffered mode and restore on draw failure', () => {
    const h = harness({ deterministic: false });
    const asteroid = new h.api.Asteroid(0.4, 0.2, 0.05, 0.2, 0);
    h.game.astervoids.push(asteroid);
    h.api.initializeLifecycleCorrection(asteroid, { x: 0.3, y: 0.1, angle: 0.2 });
    assert.throws(() => h.api.withLocalRenderInterpolation(1, () => {
        assert.equal(asteroid.x, 0.3);
        throw new Error('draw failed');
    }), /draw failed/);
    assert.equal(asteroid.x, 0.4);
    assert.equal(asteroid.y, 0.2);
    assert.equal(asteroid.velocityX, 0.2);
});

test('deletion removes physics immediately but freezes the last displayed silhouette', () => {
    const h = harness();
    const asteroid = new h.api.Asteroid(0.4, 0.2, 0.05, 0.2, 0);
    Object.assign(asteroid, { syncObjectId: 'a', _lastRenderedX: 0.3,
        _lastRenderedY: 0.1, _lastRenderedAngle: 0.2 });
    h.api.beginAsteroidDeletion(asteroid);
    const effect = h.game.multiplayer.collisionEffects.get('asteroid-delete:a');
    assert.equal(effect.pose.x, 0.3);
    assert.equal(effect.pose.angle, 0.2);
    assert.equal(asteroid.x, 0.4);
    assert.deepEqual(h.removed, ['cue:a']);
    h.game.multiplayer.collisionEffects.clear();
    asteroid._lifecycleReplaced = true;
    h.api.beginAsteroidDeletion(asteroid);
    assert.equal(h.game.multiplayer.collisionEffects.size, 0, 'replacement must not ghost the parent');
});

test('deletion silhouette expires on the cue clock without reintroducing a collider', () => {
    const h = harness();
    h.config.COLLISION_CUE_MIN_MS = 120;
    h.config.COLLISION_CUE_FADE_MS = 180;
    h.config.COLLISION_CUE_MAX_MS = 1000;
    h.api.fromNormalizedX = value => value;
    h.api.fromNormalizedY = value => value;
    vm.runInContext(
        section('    const CollisionEffects = {', '    // Helper to check if this client has authority')
        + '\nglobalThis.productionEffects = CollisionEffects;',
        h.api);
    const asteroid = new h.api.Asteroid(0.4, 0.2, 0.05, 0.2, 0);
    asteroid.syncObjectId = 'a';
    h.api.beginAsteroidDeletion(asteroid);
    let strokes = 0;
    const canvas = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        closePath() {}, stroke() { strokes++; } };
    h.api.productionEffects.draw(canvas, 1200);
    assert.equal(strokes, 1);
    h.api.productionEffects.draw(canvas, 1320);
    assert.equal(strokes, 1);
    assert.equal(h.game.multiplayer.collisionEffects.size, 0);
    assert.equal(h.game.astervoids.length, 0);
});

test('final-destruction result ledgers do not suppress the parent deletion transition', () => {
    const h = harness();
    const asteroid = new h.api.Asteroid(0.4, 0.2, 0.05, 0.2, 0);
    asteroid.syncObjectId = 'a';
    h.game.astervoids.push(asteroid);
    h.handlers.get('onObjectReplaced')('a', [
        { id: 'result', data: { type: 'hitResult', hitTargetId: 'a' } }
    ], 1200);
    assert.equal(asteroid._lifecycleReplaced, false);
    h.api.beginAsteroidDeletion(asteroid);
    assert.ok(h.game.multiplayer.collisionEffects.has('asteroid-delete:a'));
});

test('spawn avoids every active canonical ship, including toroidal seam neighbors', async () => {
    const h = harness();
    h.game.ship = { x: 0.2, y: 0.2 };
    h.records.set('remote-ship', {
        id: 'remote-ship', data: { type: 'ship', memberId: 'other', x: 0.98,
            y: 0.5, velocityX: 0, velocityY: 0, sampleAt: 1200 }
    });
    h.setRandom([0.02, 0.5, 0.6, 0.5, 0.1, 0.1, 0.1]);
    const asteroid = await h.api.spawnAsteroidAwayFromShip();
    assert.equal(asteroid.x, 0.6);
    assert.equal(asteroid.y, 0.5);
    assert.equal(asteroid.bornAt, 1200);
});

test('spawn retry budget is bounded and chooses maximum minimum clearance', async () => {
    const h = harness();
    h.game.ship = { x: 0.5, y: 0.5 };
    h.config.SPAWN_MIN_DISTANCE = 2;
    h.setRandom([0.25, 0.25, 0.1, 0.1]);
    const asteroid = await h.api.spawnAsteroidAwayFromShip();
    assert.equal(asteroid.x, 0.1);
    assert.equal(asteroid.y, 0.1);
    assert.ok(h.randomCalls <= 132, `bounded random draws: ${h.randomCalls}`);
});
