import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const WireSchemas = require('./wwwroot/js/game-wire-schemas.js');
const WireEnum = require('./wwwroot/js/wire-enum.js');

const SESSION_ID = '00112233-4455-6677-8899-aabbccddeeff';
const MEMBER_ID = 'fedcba98-7654-3210-fedc-ba9876543210';
const OBJECT_ID = '12345678-90ab-cdef-1234-567890abcdef';
const OTHER_ID = '00000000-0000-0000-0000-000000000000';
// Even a GUID-shaped credential is opaque, not a typed Guid parameter.
const RECONNECT_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function loadModule(file, name, globals) {
    const source = readFileSync(new URL(`./wwwroot/js/${file}`, import.meta.url), 'utf8');
    return new Function(...Object.keys(globals), `${source}\nreturn ${name};`)(
        ...Object.values(globals));
}

async function loadClient(guidUtils = GuidUtils) {
    const window = { ASTERVOIDS_DEBUG: false, SchemaCodec };
    const SyncPayload = loadModule('sync-payload.js', 'SyncPayload', {
        window, MsgpackCodec
    });
    const calls = [];
    const handlers = new Map();
    const sessionResponse = () => ({
        sessionId: GuidUtils.guidToBytes(SESSION_ID),
        sessionName: 'fruit',
        memberId: GuidUtils.guidToBytes(MEMBER_ID),
        role: 1,
        reconnectToken: RECONNECT_TOKEN,
        members: [{ id: GuidUtils.guidToBytes(MEMBER_ID), role: 1 }],
        objects: [],
        validAts: [],
        metadata: { schemas: WireSchemas.SCHEMAS }
    });
    const replies = new Map([
        ['CreateSession', sessionResponse],
        ['JoinSession', sessionResponse],
        ['RejoinSession', sessionResponse],
        ['UpdateObjects', () => [[[GuidUtils.guidToBytes(OBJECT_ID), 2]], 7, 1234]],
        ['CreateObject', () => null],
        ['ReplaceObject', () => [[], 9, 2000]],
        ['DeleteObject', () => [true, 8]],
        ['BroadcastObjectEvent', () => true]
    ]);
    const connection = {
        state: 'Disconnected',
        async start() { this.state = 'Connected'; },
        async stop() { this.state = 'Disconnected'; },
        on(name, handler) { handlers.set(name, handler); },
        onreconnecting() {},
        onreconnected() {},
        onclose() {},
        async invoke(method, ...args) {
            calls.push({ method, args });
            assert.ok(replies.has(method), `unexpected hub method ${method}`);
            return replies.get(method)(...args);
        }
    };
    const signalR = {
        HubConnectionState: { Connected: 'Connected' },
        LogLevel: { Information: 1 },
        protocols: { msgpack: { MessagePackHubProtocol: class {} } },
        HubConnectionBuilder: class {
            withUrl() { return this; }
            withHubProtocol() { return this; }
            withAutomaticReconnect() { return this; }
            configureLogging() { return this; }
            build() { return connection; }
        }
    };
    const client = loadModule('session-client.js', 'SessionClient', {
        window, signalR, GuidUtils: guidUtils, WireEnum, SyncPayload,
        ObjectSync: { triggerReconciliation() {} }
    });
    assert.equal(await client.connect(), true);
    return { client, calls, replies, handlers, SyncPayload };
}

function assertBinaryGuid(actual, expected) {
    assert.ok(actual instanceof Uint8Array);
    assert.equal(actual.length, 16);
    assert.deepEqual(actual, GuidUtils.guidToBytes(expected));
    assert.equal(GuidUtils.bytesToGuid(actual), expected.toLowerCase());
}

test('JoinSession writes a mixed-endian binary Guid and keeps public IDs as strings', async () => {
    const { client, calls } = await loadClient();
    const joined = await client.joinSession(SESSION_ID);

    assert.deepEqual(calls, [{
        method: 'JoinSession',
        args: [new Uint8Array([
            0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66,
            0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff
        ])]
    }]);
    assert.equal(joined.session.id, SESSION_ID);
    assert.equal(joined.member.id, MEMBER_ID);
    assert.equal(joined.session.members[0].id, MEMBER_ID);
    assert.equal(client.getLastSessionId(), SESSION_ID);
    assert.equal(client.getCurrentSession(), joined.session);
    assert.equal(client.getCurrentMember(), joined.member);
    assert.equal((await client.joinSession(SESSION_ID)).session, joined.session);
    assert.equal(calls.length, 1, 'joining the current session stays a local fast path');
});

test('RejoinSession writes both typed IDs as binary but leaves the reconnect token alone', async () => {
    const { client, calls } = await loadClient();
    await client.joinSession(SESSION_ID);
    client.clearSessionState();
    const rejoined = await client.joinSession(SESSION_ID);

    assert.deepEqual(calls.at(-1), {
        method: 'RejoinSession',
        args: [
            GuidUtils.guidToBytes(SESSION_ID),
            GuidUtils.guidToBytes(MEMBER_ID),
            RECONNECT_TOKEN
        ]
    });
    assert.equal(rejoined.session.id, SESSION_ID);
    assert.equal(rejoined.member.id, MEMBER_ID);
});

test('UpdateObjects converts every DTO ID without rewriting or mutating game data', async () => {
    const { client, calls, SyncPayload } = await loadClient();
    await client.createSession();
    const genericData = Object.freeze({
        objectId: MEMBER_ID,
        ownerMemberId: OTHER_ID,
        nested: Object.freeze({ sessionId: SESSION_ID })
    });
    const ballisticData = Object.freeze({ x: 0.5, y: 0.25, lifetime: 42 });
    const opaqueBytes = new Uint8Array(16).fill(0x2a);
    const envelope = Object.freeze([0, opaqueBytes]);
    const updates = Object.freeze([
        Object.freeze({ objectId: OBJECT_ID, data: genericData }),
        Object.freeze({ objectId: OTHER_ID, data: ballisticData, schemaId: 3 }),
        Object.freeze({ objectId: MEMBER_ID, data: envelope }),
        Object.freeze({ objectId: SESSION_ID, data: null, schemaId: null })
    ]);

    const response = await client.updateObjects(updates, 17, 50, 123456);
    const { method, args } = calls.at(-1);
    assert.equal(method, 'UpdateObjects');
    assert.deepEqual(args.slice(1), [17, 50, 123456]);
    assert.equal(args[0].length, 4);
    for (let i = 0; i < updates.length; i++) {
        assertBinaryGuid(args[0][i][0], updates[i].objectId);
        assert.equal(updates[i].objectId, [OBJECT_ID, OTHER_ID, MEMBER_ID, SESSION_ID][i]);
    }
    assert.deepEqual(SyncPayload.unwrap(args[0][0][1]), genericData);
    assert.equal(args[0][1][1][0], 3);
    assert.equal(SyncPayload.unwrap(args[0][1][1]).lifetime, 42);
    assert.equal(args[0][2][1], envelope);
    assert.equal(args[0][2][1][1], opaqueBytes);
    assert.deepEqual(SyncPayload.unwrap(args[0][3][1]), {});
    assert.deepEqual(response, {
        versions: { [OBJECT_ID]: 2 }, memberSequence: 7, serverTimestamp: 1234
    });
});

test('CreateSession and CreateObject leave metadata, owner overrides, and game IDs unchanged', async () => {
    const { client, calls, SyncPayload } = await loadClient();
    const metadata = { ownerMemberId: MEMBER_ID, nested: { sessionId: SESSION_ID } };
    await client.createSession(metadata);
    assert.equal(calls.at(-1).args[0], metadata);
    assert.deepEqual(metadata, { ownerMemberId: MEMBER_ID, nested: { sessionId: SESSION_ID } });

    const data = { objectId: OBJECT_ID, ownerMemberId: MEMBER_ID };
    await client.createObject(data, 'Member', MEMBER_ID, 1000);
    assert.equal(calls.at(-1).method, 'CreateObject');
    assert.deepEqual(calls.at(-1).args.slice(1), ['Member', MEMBER_ID, 1000]);
    assert.deepEqual(SyncPayload.unwrap(calls.at(-1).args[0]), data);
    await client.createObject(data);
    assert.deepEqual(calls.at(-1).args.slice(1), ['Member', null, null]);
});

test('ReplaceObject converts only the deleted typed Guid, preserving string owners and payloads', async () => {
    const { client, calls, replies, SyncPayload } = await loadClient();
    await client.createSession();
    const data = Object.freeze({ objectId: OBJECT_ID, ownerMemberId: MEMBER_ID });
    replies.set('ReplaceObject', () => [[[
        GuidUtils.guidToBytes(OTHER_ID),
        GuidUtils.guidToBytes(MEMBER_ID),
        GuidUtils.guidToBytes(MEMBER_ID),
        1, SyncPayload.wrap(data), 1
    ]], 9, 1999]);
    const notifications = [];
    client.on('onObjectReplaced', (...args) => notifications.push(args));
    const result = await client.replaceObject(OBJECT_ID, [data], 'Session', MEMBER_ID, 2000);

    assert.equal(calls.at(-1).method, 'ReplaceObject');
    const args = calls.at(-1).args;
    assertBinaryGuid(args[0], OBJECT_ID);
    assert.deepEqual(args.slice(2), ['Session', MEMBER_ID, 2000]);
    assert.deepEqual(SyncPayload.unwrap(args[1][0]), data);
    assert.equal(result[0].id, OTHER_ID);
    assert.equal(result[0].ownerMemberId, MEMBER_ID);
    assert.equal(result[0].creatorMemberId, MEMBER_ID);
    assert.deepEqual(result[0].data, data);
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], [
        { deletedObjectId: OBJECT_ID, createdObjects: result }, MEMBER_ID, 9, 1999
    ]);
});

test('DeleteObject and BroadcastObjectEvent convert IDs while preserving opaque payload bytes', async () => {
    const { client, calls } = await loadClient();
    await client.createSession();
    assert.deepEqual(await client.deleteObject(OBJECT_ID.toUpperCase()), {
        success: true, memberSequence: 8
    });
    assert.deepEqual(calls.at(-1), {
        method: 'DeleteObject', args: [GuidUtils.guidToBytes(OBJECT_ID)]
    });

    const payload = new Uint8Array(16).fill(0x2a);
    assert.equal(await client.broadcastObjectEvent(OBJECT_ID, 255, payload, 3000), true);
    assert.deepEqual(calls.at(-1), {
        method: 'BroadcastObjectEvent',
        args: [GuidUtils.guidToBytes(OBJECT_ID), 255, payload, 3000]
    });
    assert.equal(calls.at(-1).args[2], payload);
    await client.broadcastObjectEvent(OTHER_ID, 0, null);
    assert.deepEqual(calls.at(-1).args, [GuidUtils.guidToBytes(OTHER_ID), 0, null, null]);
});

test('typed Guid arguments reject invalid IDs rather than falling back to string encoding', async () => {
    const { client, calls } = await loadClient();
    await assert.rejects(client.joinSession('not-a-guid'), /Invalid GUID/);
    assert.equal(calls.length, 0);
    await client.createSession();
    const count = calls.length;
    for (const operation of [
        () => client.updateObjects([{ objectId: OBJECT_ID, data: {} }, { objectId: 'bad', data: {} }]),
        () => client.deleteObject('bad'),
        () => client.replaceObject('bad', [{}]),
        () => client.broadcastObjectEvent('bad', 1, null)
    ]) {
        await assert.rejects(operation(), /Invalid GUID/);
        assert.equal(calls.length, count, 'invalid IDs must not reach the hub');
    }
});

test('missing outbound Guid support fails instead of silently sending strings', async () => {
    const { client, calls } = await loadClient({
        transformBinaryGuids: GuidUtils.transformBinaryGuids
    });
    await assert.rejects(client.joinSession(SESSION_ID), /guidToBytes/);
    assert.equal(calls.length, 0);
});

test('binary IDs cost 18 instead of 38 bytes and reduce a normal bullet update from 51 to 31', async () => {
    const { client, calls } = await loadClient();
    await client.createSession();
    await client.updateObjects([{
        objectId: OBJECT_ID,
        schemaId: WireSchemas.SCHEMA_BY_OBJECT_TYPE.bullet,
        data: { x: 0.5, y: 0.25, lifetime: 42 }
    }]);
    const update = calls.at(-1).args[0][0];
    assertBinaryGuid(update[0], OBJECT_ID);
    assert.equal(update[1][0], 3);
    assert.equal(update[1][1].length, 8);
    const binaryId = MsgpackCodec.encode(update[0]);
    const stringId = MsgpackCodec.encode(OBJECT_ID);
    assert.deepEqual(Array.from(binaryId.slice(0, 2)), [0xc4, 16]);
    assert.deepEqual(Array.from(stringId.slice(0, 2)), [0xd9, 36]);
    assert.equal(binaryId.length, 18);
    assert.equal(stringId.length, 38);

    // Per ObjectUpdateRequest, excluding the shared batch/SignalR framing.
    const before = MsgpackCodec.encode([OBJECT_ID, update[1]]);
    const after = MsgpackCodec.encode(update);
    assert.equal(before.length, 51);
    assert.equal(after.length, 31);
    assert.deepEqual(MsgpackCodec.decode(after), update);
    assert.deepEqual(before.slice(39), after.slice(19), 'only the ID encoding changes');
});
