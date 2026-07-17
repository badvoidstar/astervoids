import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const {
    createRuntime,
    RemovalReason
} = require('./wwwroot/js/replication-runtime.js');

function makeHarness({ presentation, classify, type = 'counter' } = {}) {
    const records = new Map();
    const instances = new Map();
    const applied = [];
    const removed = [];
    const adopted = [];
    const adoptionFacts = [];
    let currentMemberId = 'local';
    let activeMemberIds = ['local', 'remote'];

    const store = {
        getObjectsByType(recordType) {
            return Array.from(records.values())
                .filter(record => record.type === recordType);
        },
        getObject(id) {
            return records.get(id);
        },
        getAllObjects() {
            return records.values();
        }
    };
    const descriptor = {
        type,
        classify: classify || (record =>
            record.ownerMemberId === currentMemberId ? 'owned' : 'replica'),
        getInstance: id => instances.get(id),
        getInstances: () => instances,
        createReplica(record) {
            const instance = { id: record.id, scalar: null };
            instances.set(record.id, instance);
            return instance;
        },
        adoptOwned(record, instance, facts) {
            const adoptedInstance = instance || { id: record.id, scalar: 'owned' };
            instances.set(record.id, adoptedInstance);
            adopted.push(record.id);
            adoptionFacts.push(facts);
            return adoptedInstance;
        },
        apply(instance, data, facts) {
            instance.scalar = data;
            applied.push({ id: instance.id, data, facts });
        },
        remove(instance, reason, facts) {
            instances.delete(instance.id);
            removed.push({ id: instance.id, reason, facts });
        },
        presentation
    };
    const runtime = createRuntime({
        store,
        getCurrentMemberId: () => currentMemberId,
        getActiveMemberIds: () => activeMemberIds
    });
    runtime.registerType(descriptor);

    return {
        runtime,
        records,
        instances,
        applied,
        removed,
        adopted,
        adoptionFacts,
        setCurrentMemberId: value => { currentMemberId = value; },
        setActiveMemberIds: value => { activeMemberIds = value; },
        record(id, version, scalar, ownerMemberId = 'remote') {
            const record = { id, type, version, data: scalar, ownerMemberId };
            records.set(id, record);
            return record;
        }
    };
}

function makePresentation() {
    const states = new Map();
    const ingests = [];
    const samples = [];
    const removals = [];
    const resets = [];
    return {
        states,
        ingests,
        samples,
        removals,
        resets,
        adapter: {
            has: id => states.has(id),
            ingest(id, data, facts, record, context) {
                ingests.push({ id, data, facts, record, context });
                states.set(id, { opaqueValue: `presented:${data}` });
            },
            sample(id, facts, record, context) {
                samples.push({ id, facts, record, context });
                return states.get(id).opaqueValue;
            },
            remove(id, reason, facts) {
                states.delete(id);
                removals.push({ id, reason, facts });
            },
            reset(facts) {
                states.clear();
                resets.push(facts);
            }
        }
    };
}

test('raw scalar replicas create, apply, and remove without kinematic fields', () => {
    const h = makeHarness();
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    h.record('score', 1, 37);

    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.instances.get('score').scalar, 37);
    assert.deepEqual(Object.keys(h.records.get('score').data), []);

    h.records.delete('score');
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.instances.has('score'), false);
    assert.equal(h.removed.at(-1).reason, RemovalReason.DELETED);
});

test('opaque presentation owns ingest and sample without exposing its state', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 's', snapshotObjectIds: [] });
    h.record('n', 1, 5);

    const context = { epoch: 's', renderTime: 123 };
    h.runtime.reconcileType('counter', context);
    assert.equal(p.ingests.length, 1);
    assert.equal(p.samples.length, 1);
    assert.equal(h.instances.get('n').scalar, 'presented:5');
    assert.equal(p.ingests[0].record, h.records.get('n'));
    assert.equal(p.ingests[0].context, context);
    assert.equal(p.samples[0].record, h.records.get('n'));
    assert.equal(p.samples[0].context, context);
    assert.equal('states' in h.runtime.getSnapshot(), false);
});

test('join marker is one-shot and ingest receives active-owner session facts', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 4, snapshotObjectIds: ['n'] });
    h.record('n', 1, 8);

    h.runtime.reconcileType('counter', { epoch: 4 });
    assert.equal(p.ingests[0].facts.joinSnapshot, true);
    assert.equal(p.ingests[0].facts.ownerIsActive, true);
    assert.equal(p.ingests[0].facts.currentMemberId, 'local');
    assert.deepEqual(p.ingests[0].facts.activeMemberIds, ['local', 'remote']);
    assert.equal(p.ingests[0].facts.epoch, 4);

    p.states.delete('n');
    h.runtime.reconcileType('counter', { epoch: 4 });
    assert.equal(p.ingests[1].facts.joinSnapshot, false);
});

test('equal consumed versions suppress re-ingest while presentation still samples', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    h.record('n', 3, 11);
    h.runtime.reconcileType('counter', { epoch: 1 });
    h.runtime.reconcileType('counter', { epoch: 1 });

    assert.equal(p.ingests.length, 1);
    assert.equal(p.samples.length, 2);
    assert.equal(h.runtime.getConsumedVersion('n'), 3);
});

test('migration version is metadata-only when presentation state exists', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', 1, 10);
    h.runtime.reconcileType('counter', { epoch: 1 });

    record.version = 2;
    record.ownerMemberId = 'next-owner';
    h.runtime.handleOwnershipMigrations(
        [{ objectId: 'n', newVersion: 2 }], { epoch: 1 });
    h.runtime.reconcileType('counter', { epoch: 1 });

    assert.equal(p.ingests.length, 1);
    assert.equal(h.runtime.getConsumedVersion('n'), 2);
    assert.equal(h.runtime.isOwnershipMigrationPending('n'), true);
});

test('ownership-marked version initializes a replica with no presentation state', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    h.record('n', 9, 12);
    h.runtime.handleOwnershipMigrations(
        [{ objectId: 'n', newVersion: 9 }], { epoch: 1 });

    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(p.ingests.length, 1);
    assert.equal(p.ingests[0].facts.preserveDirection, false);
    assert.equal(h.runtime.isOwnershipMigrationPending('n'), true);
});

test('records without migration metadata do not create phantom transitions', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', undefined, 12);
    delete record.ownershipMigrationVersion;

    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.runtime.isOwnershipMigrationPending('n'), false);
    assert.deepEqual(h.runtime.getSnapshot().pendingOwnershipObjectIds, []);
});

test('first later data version preserves direction and consumes migration pending', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', 1, 1);
    h.runtime.reconcileType('counter', { epoch: 1 });
    record.version = 2;
    record.ownershipMigrationVersion = 2;
    record.ownershipMigrationPending = true;
    h.runtime.handleOwnershipMigrations(
        [{ objectId: 'n', newVersion: 2 }], { epoch: 1 });
    h.runtime.reconcileType('counter', { epoch: 1 });

    record.version = 3;
    record.data = 2;
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(p.ingests.at(-1).facts.preserveDirection, true);
    assert.equal(p.ingests.at(-1).facts.ownershipMigrationPending, true);
    assert.equal(h.runtime.isOwnershipMigrationPending('n'), false);
    assert.equal(record.ownershipMigrationPending, false);

    record.version = 4;
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(p.ingests.at(-1).facts.preserveDirection, false);
});

test('stale migration cannot resurrect a transition after newer state arrived', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', 5, 10);
    h.runtime.reconcileType('counter', { epoch: 1 });

    h.runtime.handleOwnershipMigrations(
        [{ objectId: 'n', newVersion: 4 }], { epoch: 1 });
    assert.equal(h.runtime.isOwnershipMigrationPending('n'), false);

    record.version = 6;
    record.data = 11;
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(p.ingests.at(-1).facts.preserveDirection, false);
});

test('replica becoming owner clears presentation and adopts the instance', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', 1, 7);
    h.runtime.reconcileType('counter', { epoch: 1 });

    record.ownerMemberId = 'local';
    record.version = 2;
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(p.removals.at(-1).reason, RemovalReason.OWNERSHIP_GAINED);
    assert.deepEqual(h.adopted, ['n']);
    assert.equal(h.runtime.getBinding('n').role, 'owned');
});

test('owned adoption receives and consumes the one-shot join marker', () => {
    const h = makeHarness();
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: ['n'] });
    h.record('n', 1, 7, 'local');

    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.deepEqual(h.adopted, ['n']);
    assert.equal(h.adoptionFacts[0].joinSnapshot, true);
    assert.deepEqual(h.runtime.getSnapshot().joinSnapshotObjectIds, []);
});

test('first owned binding adopts an existing instance with join facts', () => {
    const h = makeHarness();
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: ['n'] });
    const existing = { id: 'n', scalar: 'local' };
    h.instances.set('n', existing);
    h.record('n', 1, 7, 'local');

    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.instances.get('n'), existing);
    assert.deepEqual(h.adopted, ['n']);
    assert.equal(h.adoptionFacts[0].joinSnapshot, true);
});

test('owned classification consumes a migration seen before first binding', () => {
    const h = makeHarness();
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', 2, 7, 'local');
    record.ownershipMigrationPending = true;
    h.runtime.handleOwnershipMigrations(
        [{ objectId: 'n', newVersion: 2 }], { epoch: 1 });

    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.runtime.isOwnershipMigrationPending('n'), false);
    assert.equal(record.ownershipMigrationPending, false);
});

test('owner becoming replica initializes raw replica state', () => {
    const h = makeHarness();
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    const record = h.record('n', 1, 100, 'local');
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.applied.length, 0);

    record.ownerMemberId = 'remote';
    record.version = 2;
    record.data = 101;
    h.runtime.reconcileType('counter', { epoch: 1 });
    assert.equal(h.instances.get('n').scalar, 101);
    assert.equal(h.runtime.getBinding('n').role, 'replica');
});

test('external presentation work can mark a version consumed with epoch safety', () => {
    const h = makeHarness();
    h.runtime.beginSession({ epoch: 'current', snapshotObjectIds: ['n'] });
    assert.equal(h.runtime.markVersionConsumed(
        'n', 4, { epoch: 'stale' }), false);
    assert.equal(h.runtime.getConsumedVersion('n'), undefined);

    assert.equal(h.runtime.markVersionConsumed(
        'n',
        4,
        { epoch: 'current', consumeJoinSnapshot: true }), true);
    assert.equal(h.runtime.getConsumedVersion('n'), 4);
    assert.deepEqual(h.runtime.getSnapshot().joinSnapshotObjectIds, []);
});

test('deletion, ignored roles, and type changes carry explicit cleanup reasons', () => {
    const ignored = new Set();
    const h = makeHarness({
        classify: record => ignored.has(record.id) ? 'ignore' : 'replica'
    });
    h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
    h.record('deleted', 1, 1);
    h.record('ignored', 1, 2);
    h.record('moved', 1, 3);
    h.runtime.reconcileType('counter', { epoch: 1 });

    h.runtime.handleDeletedObjectIds(['deleted'], { epoch: 1 });
    ignored.add('ignored');
    h.records.get('moved').type = 'other';
    h.runtime.reconcileType('counter', { epoch: 1 });

    assert.deepEqual(
        new Map(h.removed.map(entry => [entry.id, entry.reason])),
        new Map([
            ['deleted', RemovalReason.DELETED],
            ['ignored', RemovalReason.ROLE_IGNORED],
            ['moved', RemovalReason.TYPE_MISSING]
        ]));
});

test('bindings and presentation retire after game code removes the instance first', () => {
        const p = makePresentation();
        const h = makeHarness({ presentation: p.adapter });
        h.runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });
        h.record('expired', 1, 4);
        h.runtime.reconcileType('counter', { epoch: 1 });

        h.instances.delete('expired');
        h.records.delete('expired');
        h.runtime.reconcileType('counter', { epoch: 1 });

        assert.equal(h.runtime.getBinding('expired'), undefined);
        assert.equal(h.runtime.getConsumedVersion('expired'), undefined);
        assert.equal(p.states.has('expired'), false);
        assert.equal(p.removals.at(-1).reason, RemovalReason.DELETED);
});

test('session reset is explicit and stale epoch work cannot mutate a new session', () => {
    const p = makePresentation();
    const h = makeHarness({ presentation: p.adapter });
    h.runtime.beginSession({ epoch: 'old', snapshotObjectIds: ['old-object'] });
    h.record('n', 1, 1);
    h.runtime.reconcileType('counter', { epoch: 'old' });
    assert.equal(h.runtime.resetSession('old'), true);
    assert.equal(h.removed.at(-1).reason, RemovalReason.SESSION_RESET);
    assert.equal(p.resets.length, 1);

    h.records.clear();
    h.runtime.beginSession({ epoch: 'new', snapshotObjectIds: [] });
    h.record('fresh', 1, 2);
    assert.equal(
        h.runtime.reconcileType('counter', { epoch: 'old' }).stale,
        true);
    assert.equal(h.runtime.handleDeletedObjectIds(
        ['fresh'], { epoch: 'old' }), 0);
    assert.equal(h.runtime.handleOwnershipMigrations(
        [{ objectId: 'fresh', newVersion: 2 }], { epoch: 'old' }), 0);
    assert.equal(h.runtime.resetSession('old'), false);
    assert.equal(h.instances.has('fresh'), false);

    h.runtime.reconcileType('counter', { epoch: 'new' });
    assert.equal(h.instances.get('fresh').scalar, 'presented:2');
});

test('multiple types register and duplicate or incomplete descriptors fail loudly', () => {
    const store = {
        getObjectsByType: () => [],
        getObject: () => undefined
    };
    const runtime = createRuntime({
        store,
        getCurrentMemberId: () => null
    });
    const descriptor = type => ({
        type,
        classify: () => 'ignore',
        getInstance: () => undefined,
        getInstances: () => [],
        createReplica: () => ({}),
        apply: () => {},
        remove: () => {}
    });
    runtime.registerType(descriptor('a'));
    runtime.registerType(descriptor('b'));
    assert.throws(
        () => runtime.registerType(descriptor('a')),
        /already registered: a/);
    assert.throws(
        () => runtime.registerType({ type: 'broken' }),
        /broken\.classify must be a function/);
});

test('runtime classic script loads after policy modules and before inline game', () => {
    const html = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');
    const presentation = html.indexOf('/js/replication-presentation.js');
    const sendPolicy = html.indexOf('/js/replication-send-policy.js');
    const runtime = html.indexOf('/js/replication-runtime.js');
    const inlineGame = html.indexOf('ASTERVOIDS GAME');
    assert.ok(presentation < runtime);
    assert.ok(sendPolicy < runtime);
    assert.ok(runtime < inlineGame);
});

test('runtime stays transport-free and does not inspect game fields', () => {
    const source = readFileSync(
        resolve(here, 'wwwroot/js/replication-runtime.js'),
        'utf8');
    assert.doesNotMatch(
        source,
        /\b(?:ObjectSync|SessionClient|performance|document)\b/);
    assert.doesNotMatch(
        source,
        /\.(?:x|y|angle|velocityX|velocityY|rotationSpeed|pendingHit)\b/);
    assert.doesNotMatch(
        source,
        /\b(?:asteroid|astervoid|bullet|ship|collision)\b/i);
});
