import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const ReplicationRuntime = require('./wwwroot/js/replication-runtime.js');
const OBJECT_TYPES = { SHIP: 'ship', ASTEROID: 'asteroid', BULLET: 'bullet' };
const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');
const descriptorsSource = source.slice(
    source.indexOf('const asteroidReplicationDescriptor ='),
    source.indexOf('function applyGameStateData('));

function harness() {
    const game = {
        ship: {},
        astervoids: [],
        bullets: [],
        multiplayer: { myShipObjectId: 'local-ship', remoteShips: new Map() }
    };
    const records = new Map();
    let epoch = 1;
    const functions = loadInlineGameFunctions([
        'indexKinematicInstances', 'getKinematicInstance', 'currentKinematicData',
        'buildReplicationContext'
    ], {
        game, OBJECT_TYPES, performance: { now: () => 100 },
        SessionClient: { getSessionEpoch: () => epoch }
    });
    const entity = data => ({
        ...data,
        fromSyncData(next) { Object.assign(this, next); }
    });
    const dependencies = {
        ...functions, game, OBJECT_TYPES, ReplicationRuntime,
        Asteroid: { fromSyncData: entity },
        Bullet: { fromSyncData: entity },
        ObjectSync: { getObject: id => records.get(id) },
        shouldDeferTerminalBootstrap: () => false,
        seedReplicaAtTerminalTarget: instance => instance,
        kinematicPresentation: undefined,
        RemoteObjects: { isClockOffsetInitialized: () => false },
        resolveTerminalSession: () => true,
        CollisionEffects: { resolveTarget() {}, resolveBullet() {} },
        SendGate: { remove() {} },
        forgetDeterministicTerminalObject() {}
    };
    const descriptors = compileFunction(
        `${descriptorsSource}\nreturn [asteroidReplicationDescriptor, bulletReplicationDescriptor];`,
        Object.keys(dependencies)
    )(...Object.values(dependencies));
    const runtime = ReplicationRuntime.createRuntime({
        store: {
            getObjectsByType: type => [...records.values()].filter(r => r.type === type),
            getObject: id => records.get(id)
        },
        getCurrentMemberId: () => 'local',
        getActiveMemberIds: () => ['local', 'remote'],
        descriptors
    });
    runtime.beginSession({ epoch });
    return {
        game, records, runtime, descriptors, ...functions,
        setEpoch: value => { epoch = value; },
        record(id, type, ownerMemberId = 'remote') {
            const record = { id, type, ownerMemberId, version: 1,
                data: { x: 0.2, ownerMemberId } };
            records.set(id, record);
            return record;
        }
    };
}

test('reconciliation indexes existing references once instead of scanning for every record', () => {
    const h = harness();
    for (const [type, collection] of [
        [OBJECT_TYPES.ASTEROID, h.game.astervoids],
        [OBJECT_TYPES.BULLET, h.game.bullets]
    ]) {
        for (let i = 0; i < 200; i++) {
            const record = h.record(`${type}-${i}`, type);
            collection.push({ syncObjectId: record.id, fromSyncData() {} });
        }
        collection.find = () => assert.fail('quadratic lookup during reconciliation');
        const originalOrder = [...collection];
        const context = h.buildReplicationContext(type);
        h.runtime.reconcileType(type, context);
        assert.deepEqual([...collection], originalOrder);
        for (const instance of collection) {
            assert.equal(h.getKinematicInstance(type, instance.syncObjectId, context), instance);
        }
    }
});

test('a fresh pivot observes asynchronous IDs, expiry, array replacement and session reset', () => {
    const h = harness();
    const pending = { syncObjectId: null };
    h.game.astervoids.push(pending);
    assert.equal(h.buildReplicationContext(OBJECT_TYPES.ASTEROID).instances.size, 0);
    pending.syncObjectId = 'assigned';
    const context = h.buildReplicationContext(OBJECT_TYPES.ASTEROID);
    assert.equal(context.instances.get('assigned'), pending);
    h.game.astervoids = [{ syncObjectId: 'replacement' }];
    const replacement = h.buildReplicationContext(OBJECT_TYPES.ASTEROID);
    assert.equal(replacement.instances.has('assigned'), false);
    assert.equal(replacement.instances.get('replacement'), h.game.astervoids[0]);
    assert.equal(h.getKinematicInstance(OBJECT_TYPES.ASTEROID, 'replacement'), h.game.astervoids[0]);
    h.game.astervoids = [];
    h.setEpoch(2);
    const reset = h.buildReplicationContext(OBJECT_TYPES.ASTEROID);
    assert.equal(reset.instances.size, 0);
    assert.equal(reset.epoch, 2);
});

test('create, adoption and removal keep the synchronous reference index current', () => {
    const h = harness();
    h.record('replica', OBJECT_TYPES.ASTEROID);
    h.record('adopted', OBJECT_TYPES.ASTEROID, 'local');
    const context = h.buildReplicationContext(OBJECT_TYPES.ASTEROID);
    h.runtime.reconcileType(OBJECT_TYPES.ASTEROID, context);
    assert.equal(context.instances.size, 2);
    assert.equal(context.instances.get('replica'), h.game.astervoids[0]);
    assert.equal(context.instances.get('adopted'), h.game.astervoids[1]);
    assert.equal(h.currentKinematicData(
        OBJECT_TYPES.ASTEROID, 'replica', h.records.get('replica'), context).x, 0.2);

    h.records.get('replica').ownerMemberId = 'departed';
    const next = h.buildReplicationContext(OBJECT_TYPES.ASTEROID);
    h.runtime.reconcileType(OBJECT_TYPES.ASTEROID, next);
    assert.equal(next.instances.has('replica'), false);
    assert.deepEqual(h.game.astervoids.map(a => a.syncObjectId), ['adopted']);
    h.records.clear();
    h.runtime.reconcileType(OBJECT_TYPES.ASTEROID, h.buildReplicationContext(OBJECT_TYPES.ASTEROID));
    assert.equal(h.game.astervoids.length, 0);
    h.runtime.resetSession();
    assert.equal(h.runtime.getBinding('adopted'), undefined);
});

test('type changes do not read or delete the new type through an old descriptor', () => {
    const h = harness();
    h.record('changing', OBJECT_TYPES.ASTEROID);
    h.runtime.reconcileType(OBJECT_TYPES.ASTEROID, h.buildReplicationContext(OBJECT_TYPES.ASTEROID));
    h.records.get('changing').type = OBJECT_TYPES.BULLET;
    const bullet = { syncObjectId: 'changing', fromSyncData() {} };
    h.game.bullets.push(bullet);
    const context = h.buildReplicationContext(OBJECT_TYPES.BULLET);
    h.runtime.reconcileType(OBJECT_TYPES.BULLET, context);
    assert.equal(h.game.astervoids.length, 0);
    assert.equal(context.instances.get('changing'), bullet);
    assert.equal(h.game.bullets[0], bullet);
});

test('post-reconciliation orphan cleanup retains array storage and synced order', () => {
    const kept = [{ syncObjectId: 'first' }, { syncObjectId: 'second' }];
    const game = { astervoids: [{}, kept[0], {}, kept[1], {}] };
    const original = game.astervoids;
    let reconciled = false;
    const { updateAstervoidsFromSync } = loadInlineGameFunctions(['updateAstervoidsFromSync'], {
        game, OBJECT_TYPES,
        isSessionMode: () => true,
        buildReplicationContext: () => ({}),
        replicationRuntime: {
            reconcileType() {
                assert.equal(game.astervoids.length, 5, 'cleanup remains after reconciliation');
                reconciled = true;
            }
        }
    });
    updateAstervoidsFromSync();
    assert.ok(reconciled);
    assert.equal(game.astervoids, original);
    assert.deepEqual(game.astervoids, kept);
});
