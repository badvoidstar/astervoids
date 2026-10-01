import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './test-support/classic-module.mjs';
import {
    GuidUtils, MsgpackCodec, SchemaCodec, loadSessionClient,
} from './test-support/session-client-harness.mjs';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');
const WireCodec = require('./wwwroot/js/astervoids-wire-codec.js');
const { SCHEMAS } = require('./wwwroot/js/game-wire-schemas.js');
const LEGACY_SCHEMAS = Object.freeze(SCHEMAS.map(schema => schema.id === 4
    ? Object.freeze({ id: 4, fields: Object.freeze(schema.fields.slice(0, 16)) })
    : schema));

const SESSION_ID = '00112233-4455-6677-8899-aabbccddeeff';
const NEXT_SESSION_ID = '10112233-4455-6677-8899-aabbccddeeff';
const MEMBER_ID = 'fedcba98-7654-3210-fedc-ba9876543210';
const REMOTE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NEXT_OWNER_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const OBJECT_ID = '12345678-90ab-cdef-1234-567890abcdef';
const CHILD_ID = '02345678-90ab-cdef-1234-567890abcdef';
const HANDLE = 11;
const CHILD_HANDLE = 12;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function payload(data, schemas = LEGACY_SCHEMAS, schemaId = 4) {
    if (schemaId === 0) return [0, MsgpackCodec.encode(data)];
    const definition = schemas.find(schema => schema.id === schemaId);
    const schema = SchemaCodec.normalizeSchema(definition.id, definition.fields);
    return [schemaId, SchemaCodec.encode(schema, data)];
}

function objectPacket(data, {
    id = OBJECT_ID, handle = HANDLE, version = 1, owner = REMOTE_ID,
    schemas = LEGACY_SCHEMAS, schemaId = 4, compact = true,
} = {}) {
    const fields = [
        GuidUtils.guidToBytes(id), GuidUtils.guidToBytes(owner),
        GuidUtils.guidToBytes(owner), 1, payload(data, schemas, schemaId), version, handle,
    ];
    return compact ? fields : {
        id: fields[0], creatorMemberId: fields[1], ownerMemberId: fields[2],
        scope: fields[3], data: fields[4], version, handle,
    };
}

function updatePacket(data, {
    handle = HANDLE, version = 2, schemas = LEGACY_SCHEMAS, schemaId = 4, compact = true,
} = {}) {
    const dataPayload = payload(data, schemas, schemaId);
    return compact ? [handle, dataPayload, version] : { handle, data: dataPayload, version };
}

function joinResponse({
    sessionId = SESSION_ID, schemas = LEGACY_SCHEMAS, metadata = { schemas },
    objects = [], validAts = [], role = 1,
} = {}) {
    return {
        sessionId: GuidUtils.guidToBytes(sessionId),
        sessionName: 'fixture',
        memberId: GuidUtils.guidToBytes(MEMBER_ID),
        role,
        reconnectToken: 'fixture-reconnect-token',
        members: [
            { id: GuidUtils.guidToBytes(REMOTE_ID), role: 0 },
            { id: GuidUtils.guidToBytes(MEMBER_ID), role },
        ],
        objects, validAts, metadata,
    };
}

async function subject(t, defaults = SCHEMAS) {
    const replies = new Map([
        ['LeaveSession', () => undefined],
        ['UpdateObjects', () => [[], 1, 200]],
    ]);
    const loaded = await loadSessionClient({
        reply(method, ...args) {
            assert.ok(replies.has(method), `unexpected hub method ${method}`);
            return replies.get(method)(...args);
        },
    });
    SchemaCodec.replaceAll(defaults);
    const sync = loadClassicModule('object-sync.js', 'ObjectSync', {
        SessionClient: loaded.client,
        AuthoritativeObject,
        MsgpackCodec,
        window: { ASTERVOIDS_DEBUG: false, SchemaCodec },
        signalR: { HubConnectionState: { Connected: 'Connected', Reconnecting: 'Reconnecting' } },
    });
    sync.init();
    const errors = [];
    const departures = [];
    loaded.client.on('onError', message => errors.push(message));
    const handleDeparture = (info, sender, sequence) => {
        sync.trackEventSequence(sender, sequence);
        sync.handleOwnershipMigration(info.migratedObjects ?? []);
        sync.handleMemberDeparture(info.deletedObjectIds ?? []);
        departures.push(info);
    };
    loaded.client.on('onMemberLeft', handleDeparture);
    t.after(() => loaded.client.disconnect());
    return {
        ...loaded, sync, replies, errors, departures, handleDeparture,
        emit(name, ...args) { loaded.handlers.get(name)(...args); },
    };
}

function holdInvoke(loaded, method = 'JoinSession') {
    const gate = deferred();
    const invoked = deferred();
    loaded.replies.set(method, (...args) => {
        invoked.resolve(args);
        return gate.promise;
    });
    return { ...gate, invoked: invoked.promise };
}

function emitCreate(loaded, packet, sequence = 1) {
    loaded.emit('OnObjectCreated', packet, GuidUtils.guidToBytes(REMOTE_ID), sequence, 100, 90);
}

function emitUpdate(loaded, packet, sequence = 2) {
    loaded.emit('OnObjectsUpdated', [packet], GuidUtils.guidToBytes(REMOTE_ID),
        sequence - 1, sequence, 101, 50, 91);
}

for (const slots of [16, 18]) {
    test(`${slots}-slot defaults retain live score 30/version 2 with a 16-slot creator`, async t => {
        const loaded = await subject(t, slots === 16 ? LEGACY_SCHEMAS : SCHEMAS);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        const create = objectPacket({ type: 'gameState', groupScore: 0 });
        const update = updatePacket({ groupScore: 30 });
        assert.equal(Buffer.from(update[1][1]).toString('hex'), '20001e000000');
        const receiveErrors = [];
        for (const receive of [
            () => emitCreate(loaded, create),
            () => emitUpdate(loaded, update),
        ]) {
            try {
                receive();
            } catch (error) {
                receiveErrors.push(error.message);
            }
        }
        gate.resolve(joinResponse());
        assert.ok(await joining);
        const replica = loaded.sync.getObject(OBJECT_ID);
        assert.deepEqual(receiveErrors, [],
            `valid packets must not decode against the startup registry (replica ${replica ? 'present' : 'absent'})`);
        assert.equal(replica.data.groupScore, 30);
        assert.equal(replica.version, 2);
        assert.equal(replica.validAt, 91);
        assert.equal(SchemaCodec.get(4).fields.length, 16);
        assert.equal(SCHEMAS.find(schema => schema.id === 4).fields.length, 18);
        assert.equal(LEGACY_SCHEMAS.find(schema => schema.id === 4).fields.length, 16);
        assert.equal(Buffer.from(update[1][1]).toString('hex'), '20001e000000');
        assert.deepEqual(loaded.errors, []);
    });
}

test('deferred sparse updates replay in order and an older version cannot overwrite the newest patch', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    const received = [];
    loaded.sync.on('onObjectUpdated', obj => received.push([obj.version, obj.data.groupScore]));
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0, wave: 1 }));
    emitUpdate(loaded, updatePacket({ groupScore: 10 }));
    emitUpdate(loaded, updatePacket({ groupScore: 30, wave: 2 }, { version: 3 }), 3);
    emitUpdate(loaded, updatePacket({ groupScore: 999 }), 4);
    gate.resolve(joinResponse());
    assert.ok(await joining);
    assert.deepEqual(received, [[2, 10], [3, 30]]);
    assert.deepEqual(loaded.sync.getObject(OBJECT_ID).data, {
        type: 'gameState', groupScore: 30, wave: 2,
    });
    assert.equal(loaded.sync.getObject(OBJECT_ID).version, 3);
});

test('packets arriving synchronously during replay stay behind packets already received', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    const received = [];
    loaded.sync.on('onObjectCreated', () => {
        emitUpdate(loaded, updatePacket({ groupScore: 40 }, { version: 3 }), 3);
    });
    loaded.sync.on('onObjectUpdated', obj => received.push([obj.version, obj.data.groupScore]));
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
    emitUpdate(loaded, updatePacket({ groupScore: 30 }));
    gate.resolve(joinResponse());
    assert.ok(await joining);
    assert.deepEqual(received, [[2, 30], [3, 40]]);
    assert.equal(loaded.sync.getObject(OBJECT_ID).data.groupScore, 40);
    assert.equal(loaded.sync.getObject(OBJECT_ID).version, 3);
});

for (const method of ['CreateSession', 'JoinSession', 'RejoinSession']) {
    test(`${method} preserves same-schema 18-slot personal history and live ordering`, async t => {
        const loaded = await subject(t);
        if (method === 'RejoinSession') {
            loaded.replies.set('JoinSession', () => joinResponse({ schemas: SCHEMAS }));
            await loaded.client.joinSession(SESSION_ID);
            loaded.client.clearSessionState();
        }
        const gate = holdInvoke(loaded, method);
        const entering = method === 'CreateSession'
            ? loaded.client.createSession({ schemas: SCHEMAS })
            : loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        const received = [];
        loaded.sync.on('onObjectCreated', obj => received.push(['create', obj.data.groupScore]));
        loaded.sync.on('onObjectUpdated', obj => received.push(['update', obj.data.groupScore]));
        const personal = {
            participantScores: WireCodec.packCounterMap({ [REMOTE_ID]: 30 }),
            participantNumbers: WireCodec.packCounterMap({ [REMOTE_ID]: 1 }),
        };
        emitCreate(loaded, objectPacket({
            type: 'gameState', groupScore: 0,
            participantScores: WireCodec.packCounterMap({ [REMOTE_ID]: 0 }),
            participantNumbers: personal.participantNumbers,
        }, { schemas: SCHEMAS }));
        emitUpdate(loaded, updatePacket({ groupScore: 30, ...personal }, { schemas: SCHEMAS }));
        assert.deepEqual(received, [], 'entry packets remain raw until the session contract is known');
        gate.resolve(joinResponse({ schemas: SCHEMAS, role: method === 'CreateSession' ? 0 : 1 }));
        assert.ok(await entering);
        assert.deepEqual(received, [['create', 0], ['update', 30]]);
        const replica = loaded.sync.getObject(OBJECT_ID);
        assert.equal(replica.version, 2);
        assert.equal(replica.data.groupScore, 30);
        assert.deepEqual(WireCodec.unpackCounterMap(replica.data.participantScores), { [REMOTE_ID]: 30 });
        assert.deepEqual(WireCodec.unpackCounterMap(replica.data.participantNumbers), { [REMOTE_ID]: 1 });
        assert.equal(SchemaCodec.get(4).fields.length, 18);
        assert.deepEqual(loaded.errors, []);
    });
}

test('RejoinSession replaces reinstalled startup schemas before legacy live packets decode', async t => {
    const loaded = await subject(t);
    loaded.replies.set('JoinSession', () => joinResponse());
    await loaded.client.joinSession(SESSION_ID);
    loaded.client.clearSessionState();
    SchemaCodec.replaceAll(SCHEMAS);
    const gate = holdInvoke(loaded, 'RejoinSession');
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
    emitUpdate(loaded, updatePacket({ groupScore: 30 }));
    gate.resolve(joinResponse());
    assert.ok(await joining);
    assert.equal(loaded.sync.getObject(OBJECT_ID).data.groupScore, 30);
    assert.equal(loaded.sync.getObject(OBJECT_ID).version, 2);
    assert.equal(SchemaCodec.get(4).fields.length, 16);
});

for (const compact of [false, true]) {
    test(`pending ${compact ? 'compact' : 'keyed'} custom-schema updates retain handle parking and callback metadata`, async t => {
        const schemas = [{ id: 29, fields: [['type', 'str'], ['value', 'u32']] }];
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        const order = [];
        const batches = [];
        loaded.sync.on('onObjectCreated', obj => order.push(['create', obj.data.value]));
        loaded.sync.on('onObjectUpdated', obj => order.push(['update', obj.data.value]));
        loaded.sync.on('onBatchReceived', (...args) => batches.push(args));
        emitUpdate(loaded, updatePacket({ value: 30 }, { schemas, schemaId: 29, compact }));
        emitCreate(loaded, objectPacket({ type: 'counter', value: 0 }, { schemas, schemaId: 29, compact }));
        assert.deepEqual(order, []);
        gate.resolve(joinResponse({ schemas }));
        assert.ok(await joining);
        assert.deepEqual(order, [['create', 0], ['update', 30]]);
        assert.deepEqual(batches, [[101, null, 50, REMOTE_ID]]);
        const replica = loaded.sync.getObject(OBJECT_ID);
        assert.deepEqual(replica.data, { type: 'counter', value: 30 });
        assert.equal(replica.version, 2);
        assert.equal(replica.ownerMemberId, REMOTE_ID);
        assert.equal(replica.validAt, 91);
    });
}

for (const snapshotVersion of [1, 3]) {
    test(`snapshot version ${snapshotVersion} merges monotonically with deferred live version 2`, async t => {
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
        emitUpdate(loaded, updatePacket({ groupScore: 30 }));
        gate.resolve(joinResponse({
            objects: [objectPacket({ type: 'gameState', groupScore: 90, wave: 7 }, { version: snapshotVersion })],
            validAts: [[GuidUtils.guidToBytes(OBJECT_ID), 80]],
        }));
        assert.ok(await joining);
        const replica = loaded.sync.getObject(OBJECT_ID);
        assert.equal(replica.version, Math.max(snapshotVersion, 2));
        assert.equal(replica.data.groupScore, snapshotVersion > 2 ? 90 : 30);
        assert.equal(replica.data.wave, 7, 'older snapshots still backfill omitted static fields');
        assert.equal(replica.validAt, snapshotVersion > 2 ? 80 : 91);
    });
}

test('the staged snapshot teaches handles before a newer live delta without a live create is replayed', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    emitUpdate(loaded, updatePacket({ groupScore: 30 }));
    gate.resolve(joinResponse({
        objects: [objectPacket({ type: 'gameState', groupScore: 10, wave: 7 })],
        validAts: [[GuidUtils.guidToBytes(OBJECT_ID), 80]],
    }));
    assert.ok(await joining);
    const replica = loaded.sync.getObject(OBJECT_ID);
    assert.deepEqual(replica.data, { groupScore: 30, type: 'gameState', wave: 7 });
    assert.equal(replica.version, 2);
    assert.equal(replica.ownerMemberId, REMOTE_ID);
    assert.equal(replica.creatorMemberId, REMOTE_ID);
    assert.equal(replica.scope, 'Session');
    assert.equal(replica.validAt, 91);
});

for (const slots of [16, 18]) {
    for (const migrationFirst of [true, false]) {
        test(`${slots}-slot join preserves ownership when ${migrationFirst ? 'migration precedes' : 'update precedes'} a live delta without a live create`, async t => {
            const schemas = slots === 16 ? LEGACY_SCHEMAS : SCHEMAS;
            const loaded = await subject(t);
            const gate = holdInvoke(loaded);
            const joining = loaded.client.joinSession(SESSION_ID);
            await gate.invoked;
            const migrate = () => loaded.emit('OnMemberLeft', {
                memberId: GuidUtils.guidToBytes(REMOTE_ID),
                deletedObjectIds: [],
                migratedObjects: [{
                    objectId: GuidUtils.guidToBytes(OBJECT_ID),
                    newOwnerId: GuidUtils.guidToBytes(NEXT_OWNER_ID),
                    newVersion: migrationFirst ? 2 : 3,
                }],
            }, GuidUtils.guidToBytes(REMOTE_ID), 1, 102);
            const update = () => loaded.emit('OnObjectsUpdated', [
                updatePacket({ groupScore: 30 }, { schemas, version: migrationFirst ? 3 : 2 }),
            ], GuidUtils.guidToBytes(migrationFirst ? NEXT_OWNER_ID : REMOTE_ID),
            0, 1, 103, 50, 91);
            if (migrationFirst) {
                migrate();
                update();
            } else {
                update();
                migrate();
            }
            gate.resolve(joinResponse({
                schemas,
                objects: [objectPacket({ type: 'gameState', groupScore: 10, wave: 7 }, { schemas })],
                validAts: [[GuidUtils.guidToBytes(OBJECT_ID), 80]],
            }));
            assert.ok(await joining);
            const replica = loaded.sync.getObject(OBJECT_ID);
            assert.equal(replica.ownerMemberId, NEXT_OWNER_ID,
                'the older snapshot must not restore the departed owner after a live migration');
            assert.equal(replica.version, 3);
            assert.equal(replica.data.groupScore, 30);
            assert.equal(replica.data.wave, 7);
            assert.equal(replica.creatorMemberId, REMOTE_ID);
            assert.equal(replica.scope, 'Session');
            assert.equal(replica.validAt, 91);
            assert.deepEqual(loaded.errors, []);
        });
    }
}

test('snapshot seeds and received membership/object callbacks expose coherent entry state without reentrant overtaking', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    const epoch = loaded.client.getSessionEpoch();
    const order = [];
    const assertIdentity = () => {
        assert.equal(loaded.client.getCurrentSession().id, SESSION_ID);
        assert.equal(loaded.client.getCurrentMember().id, MEMBER_ID);
        assert.equal(loaded.client.getLastSessionId(), SESSION_ID);
        assert.equal(loaded.client.getParticipantId(), MEMBER_ID);
        assert.equal(SchemaCodec.get(4).fields.length, 16);
    };
    loaded.sync.on('onObjectCreated', obj => {
        assertIdentity();
        assert.equal(obj.ownerMemberId, REMOTE_ID);
        assert.equal(obj.version, 1);
        assert.equal(obj.data.groupScore, 10);
        assert.equal(obj.validAt, 80);
        loaded.emit('OnSessionExpired', GuidUtils.guidToBytes(NEXT_SESSION_ID), 'unrelated');
        assert.equal(loaded.client.getSessionEpoch(), epoch);
        order.push('seed');
    });
    loaded.client.on('onMemberLeft', (info, sender, sequence) => {
        assertIdentity();
        assert.equal(loaded.sync.getObject(OBJECT_ID).version, 1);
        assert.ok(!loaded.client.getCurrentSession().members.some(member => member.id === REMOTE_ID));
        loaded.handleDeparture(info, sender, sequence);
        assert.equal(loaded.sync.getObject(OBJECT_ID).ownerMemberId, NEXT_OWNER_ID);
        assert.equal(loaded.sync.getObject(OBJECT_ID).version, 2);
        order.push('left:2');
        loaded.emit('OnObjectsUpdated', [updatePacket({ groupScore: 40 }, { version: 4 })],
            GuidUtils.guidToBytes(NEXT_OWNER_ID), 1, 2, 104, 50, 94);
    });
    loaded.client.on('onRoleChanged', role => {
        assertIdentity();
        assert.equal(role, 'Server');
        assert.equal(loaded.client.getCurrentMember().role, role);
        order.push(`role:${role}`);
    });
    loaded.sync.on('onObjectUpdated', obj => {
        assertIdentity();
        assert.equal(obj.ownerMemberId, NEXT_OWNER_ID);
        assert.equal(loaded.client.getCurrentMember().role, 'Server');
        order.push(`update:${obj.version}:${obj.data.groupScore}`);
    });
    loaded.client.on('onMemberJoined', member => {
        assertIdentity();
        assert.equal(member.id, CHILD_ID);
        assert.ok(loaded.client.getCurrentSession().members.some(m => m.id === CHILD_ID));
        assert.equal(loaded.sync.getObject(OBJECT_ID).version, 3);
        order.push('joined');
    });
    loaded.client.on('onSessionJoined', (session, member) => {
        assertIdentity();
        assert.equal(session, loaded.client.getCurrentSession());
        assert.equal(member, loaded.client.getCurrentMember());
        assert.equal(loaded.sync.getObject(OBJECT_ID).version, 4);
        assert.equal(loaded.sync.getObject(OBJECT_ID).data.groupScore, 40);
        order.push('entry');
    });
    loaded.emit('OnMemberLeft', {
        memberId: GuidUtils.guidToBytes(REMOTE_ID),
        promotedMemberId: GuidUtils.guidToBytes(MEMBER_ID),
        promotedRole: 0,
        deletedObjectIds: [],
        migratedObjects: [{
            objectId: GuidUtils.guidToBytes(OBJECT_ID),
            newOwnerId: GuidUtils.guidToBytes(NEXT_OWNER_ID),
            newVersion: 2,
        }],
    }, GuidUtils.guidToBytes(REMOTE_ID), 1, 102);
    loaded.emit('OnObjectsUpdated', [updatePacket({ groupScore: 30 }, { version: 3 })],
        GuidUtils.guidToBytes(NEXT_OWNER_ID), 0, 1, 103, 50, 91);
    loaded.emit('OnMemberJoined', { id: GuidUtils.guidToBytes(CHILD_ID), role: 1 },
        GuidUtils.guidToBytes(CHILD_ID), 1, 103);
    assert.deepEqual(order, []);
    const response = joinResponse({
        objects: [objectPacket({ type: 'gameState', groupScore: 10 })],
        validAts: [[GuidUtils.guidToBytes(OBJECT_ID), 80]],
    });
    response.members.push({ id: GuidUtils.guidToBytes(NEXT_OWNER_ID), role: 1 });
    gate.resolve(response);
    assert.ok(await joining);
    assert.deepEqual(order, [
        'seed', 'left:2', 'role:Server', 'update:3:30', 'joined', 'update:4:40', 'entry',
    ]);
    assert.equal(loaded.sync.getObject(OBJECT_ID).ownerMemberId, NEXT_OWNER_ID);
    assert.deepEqual(loaded.errors, []);
});

for (const snapshotPresent of [false, true]) {
    test(`an older delayed create cannot rewind migrated ownership or a parked update (${snapshotPresent ? 'with' : 'without'} snapshot)`, async t => {
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        loaded.emit('OnMemberLeft', {
            memberId: GuidUtils.guidToBytes(REMOTE_ID),
            deletedObjectIds: [],
            migratedObjects: [{
                objectId: GuidUtils.guidToBytes(OBJECT_ID),
                newOwnerId: GuidUtils.guidToBytes(NEXT_OWNER_ID),
                newVersion: 2,
            }],
        }, GuidUtils.guidToBytes(REMOTE_ID), 1, 102);
        loaded.emit('OnObjectsUpdated', [updatePacket({ groupScore: 30 }, { version: 3 })],
            GuidUtils.guidToBytes(NEXT_OWNER_ID), 0, 1, 103, 50, 91);
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0, wave: 7 }), 2);
        gate.resolve(joinResponse({
            objects: snapshotPresent ? [objectPacket({ type: 'gameState', groupScore: 10 })] : [],
        }));
        assert.ok(await joining);
        const replica = loaded.sync.getObject(OBJECT_ID);
        assert.equal(replica.ownerMemberId, NEXT_OWNER_ID);
        assert.equal(replica.version, 3);
        assert.deepEqual(replica.data, { type: 'gameState', groupScore: 30, wave: 7 });
        assert.equal(replica.creatorMemberId, REMOTE_ID);
        assert.equal(replica.scope, 'Session');
        assert.equal(replica.validAt, 91);
        assert.deepEqual(loaded.errors, []);
    });
}

for (const deletion of ['object delete', 'member departure']) {
    test(`deferred ${deletion} wins over the older snapshot and removes its handle`, async t => {
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
        emitUpdate(loaded, updatePacket({ groupScore: 30 }));
        if (deletion === 'object delete') {
            loaded.emit('OnObjectDeleted', GuidUtils.guidToBytes(OBJECT_ID),
                GuidUtils.guidToBytes(REMOTE_ID), 3, 102);
        } else {
            loaded.emit('OnMemberLeft', {
                memberId: GuidUtils.guidToBytes(REMOTE_ID),
                deletedObjectIds: [GuidUtils.guidToBytes(OBJECT_ID)],
                migratedObjects: [],
            }, GuidUtils.guidToBytes(REMOTE_ID), 0, 102);
        }
        gate.resolve(joinResponse({ objects: [objectPacket({ type: 'gameState', groupScore: 0 })] }));
        assert.ok(await joining);
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        await loaded.client.updateObjects([{ objectId: OBJECT_ID, data: { groupScore: 99 }, schemaId: 4 }]);
        assert.deepEqual(loaded.calls.at(-1).args[0], [], 'deleted snapshot handles cannot be used for sending');
    });
}

test('deferred replacement, opaque event, and child update keep their received order', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    const order = [];
    loaded.sync.on('onObjectCreated', obj => order.push(`create:${obj.id}`));
    loaded.sync.on('onObjectDeleted', obj => order.push(`delete:${obj.id}`));
    loaded.sync.on('onObjectUpdated', obj => order.push(`update:${obj.id}`));
    loaded.sync.registerEventKind('fixture-cue', 7);
    loaded.sync.on('objectEvent:fixture-cue', (id, data, context) => {
        assert.deepEqual(data, { cue: '0123456789' });
        assert.equal(context.validAt, 93);
        assert.equal(loaded.sync.getObject(id).data.groupScore, 10);
        order.push(`event:${id}`);
    });
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
    loaded.emit('OnObjectReplaced', [
        GuidUtils.guidToBytes(OBJECT_ID),
        [objectPacket({ type: 'gameState', groupScore: 10 }, { id: CHILD_ID, handle: CHILD_HANDLE })],
    ], GuidUtils.guidToBytes(REMOTE_ID), 2, 102, 92);
    const opaque = MsgpackCodec.encode({ cue: '0123456789' });
    assert.equal(opaque.length, 16, 'the opaque payload must not become a GUID');
    loaded.emit('OnObjectEvent', [GuidUtils.guidToBytes(CHILD_ID), 7, opaque],
        GuidUtils.guidToBytes(REMOTE_ID), 3, 103, 93);
    emitUpdate(loaded, updatePacket({ groupScore: 30 }, { handle: CHILD_HANDLE }), 4);
    gate.resolve(joinResponse({ objects: [objectPacket({ type: 'gameState', groupScore: 0 })] }));
    assert.ok(await joining);
    assert.deepEqual(order, [
        `create:${OBJECT_ID}`, `delete:${OBJECT_ID}`, `create:${CHILD_ID}`,
        `event:${CHILD_ID}`, `update:${CHILD_ID}`,
    ]);
    assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
    assert.equal(loaded.sync.getObject(CHILD_ID).data.groupScore, 30);
    assert.equal(loaded.sync.getObject(CHILD_ID).version, 2);
});

test('pending membership callbacks retain authoritative migration metadata and promotion', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
    emitUpdate(loaded, updatePacket({ groupScore: 30 }));
    loaded.emit('OnMemberLeft', {
        memberId: GuidUtils.guidToBytes(REMOTE_ID),
        promotedMemberId: GuidUtils.guidToBytes(MEMBER_ID),
        promotedRole: 0,
        deletedObjectIds: [],
        migratedObjects: [{
            objectId: GuidUtils.guidToBytes(OBJECT_ID),
            newOwnerId: GuidUtils.guidToBytes(NEXT_OWNER_ID),
            newVersion: 3,
        }],
    }, GuidUtils.guidToBytes(REMOTE_ID), 0, 102);
    assert.deepEqual(loaded.departures, []);
    gate.resolve(joinResponse({ objects: [objectPacket({ type: 'gameState', groupScore: 0 })] }));
    const result = await joining;
    const replica = loaded.sync.getObject(OBJECT_ID);
    assert.equal(replica.data.groupScore, 30);
    assert.equal(replica.version, 3);
    assert.equal(replica.ownerMemberId, NEXT_OWNER_ID);
    assert.equal(replica.ownershipMigrationPending, true);
    assert.equal(replica.validAt, 91, 'metadata-only migration does not re-anchor the live sample');
    assert.equal(result.member.role, 'Server');
    assert.deepEqual(result.session.members.map(member => member.id), [MEMBER_ID]);
    assert.equal(loaded.departures.length, 1);
});

for (const failure of ['null response', 'invoke rejection', 'missing credential', 'invalid registry']) {
    test(`${failure} discards raw entry packets before a different session can install its registry`, async t => {
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
        emitUpdate(loaded, updatePacket({ groupScore: 30 }));
        if (failure === 'null response') {
            gate.resolve(null);
            assert.equal(await joining, null);
        } else {
            const rejected = assert.rejects(joining, /fixture rejection|missing reconnectToken|unknown type tag/);
            if (failure === 'invoke rejection') {
                gate.reject(new Error('fixture rejection'));
            } else {
                const response = joinResponse();
                if (failure === 'missing credential') delete response.reconnectToken;
                else response.metadata.schemas = [{ id: 4, fields: [['value', 'invalid-type']] }];
                gate.resolve(response);
            }
            await rejected;
        }
        assert.equal(loaded.client.getCurrentSession(), null);
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        assert.equal(loaded.errors.length, failure === 'null response' ? 0 : 1);
        loaded.replies.set('JoinSession', () => joinResponse({ sessionId: NEXT_SESSION_ID, schemas: SCHEMAS }));
        await loaded.client.joinSession(NEXT_SESSION_ID);
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 70 },
            { id: CHILD_ID, handle: HANDLE, schemas: SCHEMAS }));
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        assert.equal(loaded.sync.getObject(CHILD_ID).data.groupScore, 70);
        assert.equal(SchemaCodec.get(4).fields.length, 18);
    });
}

for (const cancellation of ['reset', 'disconnect', 'replace connection', 'unexpected close', 'expiration']) {
    test(`${cancellation} discards packets owned by the cancelled join epoch`, async t => {
        const loaded = await subject(t);
        let close;
        if (cancellation === 'unexpected close') {
            loaded.connection.onclose = handler => { close = handler; };
            assert.equal(await loaded.client.connect(true), true);
        }
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        const epoch = loaded.client.getSessionEpoch();
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
        emitUpdate(loaded, updatePacket({ groupScore: 30 }));
        if (cancellation === 'reset') loaded.client.clearSessionState();
        else if (cancellation === 'disconnect') {
            await loaded.client.disconnect();
            assert.equal(await loaded.client.connect(), true);
        } else if (cancellation === 'replace connection') {
            assert.equal(await loaded.client.connect(true), true);
        } else if (cancellation === 'unexpected close') {
            loaded.connection.state = 'Disconnected';
            close(null);
            assert.equal(await loaded.client.connect(), true);
        } else {
            loaded.emit('OnSessionExpired', GuidUtils.guidToBytes(SESSION_ID), 'fixture expiration');
        }
        assert.ok(loaded.client.getSessionEpoch() > epoch);
        gate.resolve(joinResponse());
        assert.equal(await joining, null);
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        loaded.replies.set('JoinSession', () => joinResponse({ sessionId: NEXT_SESSION_ID, schemas: SCHEMAS }));
        await loaded.client.joinSession(NEXT_SESSION_ID);
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 70 },
            { id: CHILD_ID, handle: HANDLE, schemas: SCHEMAS }));
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        assert.equal(loaded.sync.getObject(CHILD_ID).data.groupScore, 70);
        assert.deepEqual(loaded.errors, []);
    });
}

for (const outcome of ['success', 'rejection']) {
    test(`an obsolete join ${outcome} cannot replay into a pending replacement session`, async t => {
        const loaded = await subject(t);
        const oldGate = holdInvoke(loaded);
        const oldJoin = loaded.client.joinSession(SESSION_ID);
        await oldGate.invoked;
        const oldHandlers = new Map(loaded.handlers);
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
        emitUpdate(loaded, updatePacket({ groupScore: 30 }));
        assert.equal(await loaded.client.connect(true), true);
        const nextGate = holdInvoke(loaded);
        const nextJoin = loaded.client.joinSession(NEXT_SESSION_ID);
        await nextGate.invoked;
        oldHandlers.get('OnObjectCreated')(objectPacket({ type: 'gameState', groupScore: 999 }),
            GuidUtils.guidToBytes(REMOTE_ID), 3, 102, 92);
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 70 },
            { id: CHILD_ID, handle: HANDLE, schemas: SCHEMAS }));
        emitUpdate(loaded, updatePacket({ groupScore: 80 }, { schemas: SCHEMAS }));
        if (outcome === 'success') oldGate.resolve(joinResponse());
        else oldGate.reject(new Error('obsolete fixture rejection'));
        assert.equal(await oldJoin, null);
        nextGate.resolve(joinResponse({ sessionId: NEXT_SESSION_ID, schemas: SCHEMAS }));
        assert.ok(await nextJoin);
        assert.equal(loaded.client.getCurrentSession().id, NEXT_SESSION_ID);
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        assert.equal(loaded.sync.getObject(CHILD_ID).data.groupScore, 80);
        assert.equal(loaded.sync.getObject(CHILD_ID).version, 2);
        assert.equal(SchemaCodec.get(4).fields.length, 18);
        assert.deepEqual(loaded.errors, []);
    });
}

test('a synchronous reset during raw replay stops decoding the rest of the obsolete queue', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    let creates = 0;
    loaded.sync.on('onObjectCreated', () => {
        creates++;
        loaded.client.clearSessionState();
    });
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
    emitUpdate(loaded, updatePacket({ groupScore: 30 }));
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 40 },
        { id: CHILD_ID, handle: CHILD_HANDLE }), 3);
    gate.resolve(joinResponse());
    assert.equal(await joining, null);
    assert.equal(creates, 1);
    assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
    assert.equal(loaded.sync.getObject(CHILD_ID), undefined);
    assert.equal(loaded.client.getCurrentSession(), null);
    assert.deepEqual(loaded.errors, []);
});

test('a reset during snapshot seeding discards the remaining seeds and undecodable raw tail', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    const epoch = loaded.client.getSessionEpoch();
    const seeds = [];
    loaded.sync.on('onObjectCreated', obj => {
        seeds.push(obj.id);
        loaded.client.clearSessionState();
    });
    loaded.emit('OnMemberLeft', {
        memberId: GuidUtils.guidToBytes(REMOTE_ID),
        deletedObjectIds: [],
        migratedObjects: [{
            objectId: GuidUtils.guidToBytes(OBJECT_ID),
            newOwnerId: GuidUtils.guidToBytes(NEXT_OWNER_ID),
            newVersion: 2,
        }],
    }, GuidUtils.guidToBytes(REMOTE_ID), 1, 102);
    emitUpdate(loaded, [HANDLE, [29, new Uint8Array([0])], 3]);
    gate.resolve(joinResponse({ objects: [
        objectPacket({ type: 'gameState', groupScore: 10 }),
        objectPacket({ type: 'gameState', groupScore: 20 }, { id: CHILD_ID, handle: CHILD_HANDLE }),
    ] }));
    assert.equal(await joining, null);
    assert.deepEqual(seeds, [OBJECT_ID]);
    assert.ok(loaded.client.getSessionEpoch() > epoch);
    assert.equal(loaded.client.getCurrentSession(), null);
    assert.equal(loaded.client.getCurrentMember(), null);
    assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
    assert.equal(loaded.sync.getObject(CHILD_ID), undefined);
    assert.deepEqual(loaded.departures, []);
    assert.deepEqual(loaded.errors, []);
    loaded.sync.on('onObjectCreated', null);
    loaded.replies.set('JoinSession', () => joinResponse({ sessionId: NEXT_SESSION_ID, schemas: SCHEMAS }));
    await loaded.client.joinSession(NEXT_SESSION_ID);
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 70 },
        { id: CHILD_ID, handle: HANDLE, schemas: SCHEMAS }));
    assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
    assert.equal(loaded.sync.getObject(CHILD_ID).data.groupScore, 70);
    assert.deepEqual(loaded.errors, []);
});

test('session-list signals stay immediate and another session expiration cannot cancel the raw queue', async t => {
    const loaded = await subject(t);
    const gate = holdInvoke(loaded);
    const joining = loaded.client.joinSession(SESSION_ID);
    await gate.invoked;
    let signals = 0;
    loaded.client.on('onSessionsChanged', () => signals++);
    emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
    loaded.emit('OnSessionsChanged');
    loaded.emit('OnSessionExpired', GuidUtils.guidToBytes(NEXT_SESSION_ID), 'unrelated');
    emitUpdate(loaded, updatePacket({ groupScore: 30 }));
    assert.equal(signals, 1);
    gate.resolve(joinResponse());
    assert.ok(await joining);
    assert.equal(loaded.sync.getObject(OBJECT_ID).data.groupScore, 30);
});

for (const metadata of [undefined, null, {}, { schemas: null }, { schemas: [] }]) {
    test(`absent positional metadata (${JSON.stringify(metadata)}) clears startup schemas and retains schema-zero fallback`, async t => {
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        emitCreate(loaded, objectPacket({ type: 'counter', value: 0 }, { schemaId: 0 }));
        emitUpdate(loaded, updatePacket({ value: 30 }, { schemaId: 0 }));
        const response = joinResponse({ metadata });
        if (metadata === undefined) delete response.metadata;
        gate.resolve(response);
        assert.ok(await joining);
        assert.equal(SchemaCodec.get(4), null, 'a previous session or startup layout is not an implicit contract');
        assert.deepEqual(loaded.sync.getObject(OBJECT_ID).data, { type: 'counter', value: 30 });
        assert.equal(loaded.sync.getObject(OBJECT_ID).version, 2);
        assert.deepEqual(loaded.errors, []);
    });
}

for (const invalid of ['create', 'update', 'replacement', 'unregistered schema', 'missing schemas']) {
    test(`invalid deferred ${invalid} rejects the join explicitly and does not dispatch its queued tail`, async t => {
        const loaded = await subject(t);
        const gate = holdInvoke(loaded);
        const joining = loaded.client.joinSession(SESSION_ID);
        await gate.invoked;
        const epoch = loaded.client.getSessionEpoch();
        const truncated = [4, new Uint8Array([0x20, 0])];
        if (invalid === 'update' || invalid === 'replacement') {
            emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 0 }));
        }
        if (invalid === 'update') {
            assert.doesNotThrow(() => emitUpdate(loaded, [HANDLE, truncated, 2]));
        } else if (invalid === 'replacement') {
            const child = objectPacket({ type: 'gameState' }, { id: CHILD_ID, handle: CHILD_HANDLE });
            child[4] = truncated;
            assert.doesNotThrow(() => loaded.emit('OnObjectReplaced',
                [GuidUtils.guidToBytes(OBJECT_ID), [child]], GuidUtils.guidToBytes(REMOTE_ID), 2, 102, 92));
        } else {
            const packet = objectPacket({ type: 'gameState', groupScore: 0 });
            packet[4] = invalid === 'unregistered schema' ? [29, new Uint8Array([0])]
                : invalid === 'missing schemas' ? packet[4] : truncated;
            assert.doesNotThrow(() => emitCreate(loaded, packet));
        }
        emitCreate(loaded, objectPacket({ type: 'gameState', groupScore: 100 },
            { id: CHILD_ID, handle: CHILD_HANDLE }), 3);
        const rejected = assert.rejects(joining, /positional decode: truncated|not registered locally/);
        const response = joinResponse();
        if (invalid === 'missing schemas') delete response.metadata;
        gate.resolve(response);
        await rejected;
        assert.ok(loaded.client.getSessionEpoch() > epoch);
        assert.equal(loaded.client.getCurrentSession(), null);
        assert.equal(loaded.client.getCurrentMember(), null);
        assert.equal(loaded.sync.getObject(OBJECT_ID), undefined);
        assert.equal(loaded.sync.getObject(CHILD_ID), undefined);
        assert.equal(loaded.errors.length, 1);
        assert.match(loaded.errors[0], /Failed to join session: .*truncated|Failed to join session: .*not registered locally/);
    });
}
