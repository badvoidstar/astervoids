import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './test-support/classic-module.mjs';

// The UpdateObjects acknowledgement is positional on the wire: entry i is the
// version assigned to wire element i, and 0 marks an element the server did
// not apply. SessionClient owns that wire shape and folds it back into the
// {objectId: version} form ObjectSync consumes, so these tests pin the fold.
//
// Updates are addressed by session-scoped handle, so each object has to be
// announced before it can be updated; the session snapshot below does that.

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const WireSchemas = require('./wwwroot/js/game-wire-schemas.js');
const WireEnum = require('./wwwroot/js/wire-enum.js');

const SESSION_ID = '00112233-4455-6677-8899-aabbccddeeff';
const MEMBER_ID = 'fedcba98-7654-3210-fedc-ba9876543210';
const A_ID = '11111111-1111-1111-1111-111111111111';
const B_ID = '22222222-2222-2222-2222-222222222222';
const C_ID = '33333333-3333-3333-3333-333333333333';
const HANDLES = { [A_ID]: 11, [B_ID]: 12, [C_ID]: 13 };

async function loadClient() {
    const window = { ASTERVOIDS_DEBUG: false, SchemaCodec };
    const SyncPayload = loadClassicModule('sync-payload.js', 'SyncPayload', {
        window, MsgpackCodec
    });
    const objectInfo = objectId => [
        GuidUtils.guidToBytes(objectId), GuidUtils.guidToBytes(MEMBER_ID),
        GuidUtils.guidToBytes(MEMBER_ID), 1, [0, MsgpackCodec.encode({})], 1,
        HANDLES[objectId]
    ];
    const sessionResponse = () => ({
        sessionId: GuidUtils.guidToBytes(SESSION_ID),
        sessionName: 'fruit',
        memberId: GuidUtils.guidToBytes(MEMBER_ID),
        role: 1,
        reconnectToken: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        members: [{ id: GuidUtils.guidToBytes(MEMBER_ID), role: 1 }],
        objects: [objectInfo(A_ID), objectInfo(B_ID), objectInfo(C_ID)],
        validAts: [],
        metadata: { schemas: WireSchemas.SCHEMAS }
    });
    // Mutable so each test can choose the acknowledgement it wants back.
    const ack = { value: [[], 0, 0] };
    const replies = new Map([
        ['CreateSession', sessionResponse],
        ['JoinSession', sessionResponse],
        ['UpdateObjects', () => ack.value]
    ]);
    const connection = {
        state: 'Disconnected',
        async start() { this.state = 'Connected'; },
        async stop() { this.state = 'Disconnected'; },
        on() {}, onreconnecting() {}, onreconnected() {}, onclose() {},
        async invoke(method, ...args) {
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
    const client = loadClassicModule('session-client.js', 'SessionClient', {
        window, signalR, GuidUtils, WireEnum, SyncPayload,
        ObjectSync: { triggerReconciliation() {} }
    });
    assert.equal(await client.connect(), true);
    // Join rather than create: a create response carries no objects, and the
    // client can only address objects whose handles it has been taught.
    await client.joinSession(SESSION_ID);
    return { client, ack };
}

const update = (objectId, x) => ({ objectId, data: { x } });

test('positional versions are folded back onto the ids that were sent', async () => {
    const { client, ack } = await loadClient();
    ack.value = [[11, 12, 13], 7, 1234];

    const response = await client.updateObjects(
        [update(A_ID, 0.1), update(B_ID, 0.2), update(C_ID, 0.3)]);

    assert.deepEqual(response.versions, { [A_ID]: 11, [B_ID]: 12, [C_ID]: 13 });
    assert.equal(response.memberSequence, 7);
    assert.equal(response.serverTimestamp, 1234);
});

test('zero marks an unapplied update and is omitted so it is re-sent', async () => {
    // ObjectSync treats "absent from versions" as "not confirmed" and re-sends
    // the full field set, so rejected entries must not appear at all.
    const { client, ack } = await loadClient();
    ack.value = [[0, 12, 0], 7, 1234];

    const response = await client.updateObjects(
        [update(A_ID, 0.1), update(B_ID, 0.2), update(C_ID, 0.3)]);

    assert.deepEqual(response.versions, { [B_ID]: 12 });
    assert.ok(!(A_ID in response.versions));
    assert.ok(!(C_ID in response.versions));
});

test('an all-rejected batch confirms nothing', async () => {
    const { client, ack } = await loadClient();
    ack.value = [[0, 0], 7, 1234];

    const response = await client.updateObjects([update(A_ID, 0.1), update(B_ID, 0.2)]);

    assert.deepEqual(response.versions, {});
});

test('a duplicated id keeps the newest version it was acknowledged with', async () => {
    // The server applies each occurrence separately, so the later index carries
    // the newer version and must win.
    const { client, ack } = await loadClient();
    ack.value = [[11, 12], 7, 1234];

    const response = await client.updateObjects([update(A_ID, 0.1), update(A_ID, 0.2)]);

    assert.deepEqual(response.versions, { [A_ID]: 12 });
});

test('a duplicated id is unaffected by acknowledgement order', async () => {
    const { client, ack } = await loadClient();
    ack.value = [[12, 11], 7, 1234];

    const response = await client.updateObjects([update(A_ID, 0.1), update(A_ID, 0.2)]);

    assert.deepEqual(response.versions, { [A_ID]: 12 }, 'the highest version wins');
});

test('a short or over-long versions array does not misalign ids', async () => {
    const { client, ack } = await loadClient();

    ack.value = [[11], 7, 1234];
    let response = await client.updateObjects([update(A_ID, 0.1), update(B_ID, 0.2)]);
    assert.deepEqual(response.versions, { [A_ID]: 11 },
        'a truncated acknowledgement confirms only what it covers');

    ack.value = [[11, 12, 13], 7, 1234];
    response = await client.updateObjects([update(A_ID, 0.1)]);
    assert.deepEqual(response.versions, { [A_ID]: 11 },
        'surplus entries have no id to attach to and are dropped');
});

test('a missing or malformed versions array yields no confirmations', async () => {
    const { client, ack } = await loadClient();

    ack.value = [null, 7, 1234];
    let response = await client.updateObjects([update(A_ID, 0.1)]);
    assert.deepEqual(response.versions, {});

    ack.value = [undefined, 7, 1234];
    response = await client.updateObjects([update(A_ID, 0.1)]);
    assert.deepEqual(response.versions, {});
});

test('an empty batch produces an empty confirmation set', async () => {
    const { client, ack } = await loadClient();
    ack.value = [[], 7, 1234];

    const response = await client.updateObjects([]);

    assert.deepEqual(response.versions, {});
});

test('the request array is not mutated while folding the acknowledgement', async () => {
    const { client, ack } = await loadClient();
    ack.value = [[11, 0], 7, 1234];
    const updates = [update(A_ID, 0.1), update(B_ID, 0.2)];
    const snapshot = JSON.parse(JSON.stringify(updates));

    await client.updateObjects(updates);

    assert.deepEqual(updates, snapshot);
});
