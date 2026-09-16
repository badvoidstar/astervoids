// The shared extra-life bonus pays each participant exactly once, so it needs an
// identity that outlives a member id. The server evicts and re-registers a
// member on every rejoin (SessionService.JoinSessionCore), which mints a fresh
// Guid, and re-entering the game builds a fresh ship object — so neither is a
// usable key. SessionClient therefore pins the id this client first entered a
// given session with and reuses it for every later entry into that session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './test-support/classic-module.mjs';

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const WireEnum = require('./wwwroot/js/wire-enum.js');

const SESSION_A = '00112233-4455-6677-8899-aabbccddeeff';
const SESSION_B = '11223344-5566-7788-99aa-bbccddeeff00';
const RECONNECT_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function memoryStorage(seed = new Map()) {
    return {
        entries: seed,
        getItem: key => seed.get(key) ?? null,
        setItem: (key, value) => seed.set(key, String(value))
    };
}

// The server mints a new member id for every entry, including rejoins, and
// never reuses one — not even across a page reload.
let memberSerial = 0;

async function loadClient(storage) {
    const window = { ASTERVOIDS_DEBUG: false, SchemaCodec };
    const SyncPayload = loadClassicModule('sync-payload.js', 'SyncPayload', {
        window, MsgpackCodec
    });
    const state = { sessionId: SESSION_A, get memberId() { return this.lastMemberId; } };
    const response = () => {
        const memberId = `00000000-0000-0000-0000-${String(++memberSerial).padStart(12, '0')}`;
        state.lastMemberId = memberId;
        return {
            sessionId: GuidUtils.guidToBytes(state.sessionId),
            sessionName: 'fruit',
            memberId: GuidUtils.guidToBytes(memberId),
            role: 1,
            reconnectToken: RECONNECT_TOKEN,
            members: [{ id: GuidUtils.guidToBytes(memberId), role: 1 }],
            objects: [],
            validAts: [],
            metadata: {}
        };
    };
    const invocations = [];
    const connection = {
        state: 'Disconnected',
        async start() { this.state = 'Connected'; },
        async stop() { this.state = 'Disconnected'; },
        on() {},
        onreconnecting() {},
        onreconnected() {},
        onclose() {},
        async invoke(method) {
            invocations.push(method);
            return method === 'LeaveSession' ? true : response();
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
    const previousStorage = globalThis.sessionStorage;
    globalThis.sessionStorage = storage;
    try {
        const client = loadClassicModule('session-client.js', 'SessionClient', {
            window, signalR, GuidUtils, WireEnum, SyncPayload,
            ObjectSync: { triggerReconciliation() {} }
        });
        assert.equal(await client.connect(), true);
        return { client, state, invocations };
    } finally {
        globalThis.sessionStorage = previousStorage;
    }
}

// The module reads storage lazily, so rebind it for the duration of each call.
async function withStorage(storage, action) {
    const previous = globalThis.sessionStorage;
    globalThis.sessionStorage = storage;
    try {
        return await action();
    } finally {
        globalThis.sessionStorage = previous;
    }
}

test('the participant id is pinned on entry and reused for every later entry', async () => {
    const storage = memoryStorage();
    const { client, state, invocations } = await loadClient(storage);

    await withStorage(storage, () => client.createSession());
    const participantId = client.getParticipantId();
    assert.equal(participantId, state.lastMemberId, 'the first member id seeds the identity');

    // Auto-rejoin after a transient drop: a new member id, the same participant.
    client.clearSessionState();
    await withStorage(storage, () => client.joinSession(SESSION_A));
    assert.ok(invocations.includes('RejoinSession'));
    assert.notEqual(client.getCurrentMember().id, participantId, 'the member id moved');
    assert.equal(client.getParticipantId(), participantId);

    // Leaving the session for the picker and coming back is still the same
    // person: a clean leave drops the reconnect token, so this is a plain join.
    await withStorage(storage, () => client.leaveSession());
    assert.equal(client.getParticipantId(), null, 'no identity outside a session');
    invocations.length = 0;
    await withStorage(storage, () => client.joinSession(SESSION_A));
    assert.ok(invocations.includes('JoinSession'));
    assert.equal(client.getParticipantId(), participantId);

    // A different session is a different game, and a different participant.
    state.sessionId = SESSION_B;
    await withStorage(storage, () => client.joinSession(SESSION_B));
    const secondParticipantId = client.getParticipantId();
    assert.equal(secondParticipantId, client.getCurrentMember().id);
    assert.notEqual(secondParticipantId, participantId);
});

test('a page reload rejoins the same session as the same participant', async () => {
    const storage = memoryStorage();
    const first = await loadClient(storage);
    await withStorage(storage, () => first.client.createSession());
    const participantId = first.client.getParticipantId();

    // A reload re-evaluates the module: only per-tab storage carries over.
    const second = await loadClient(storage);
    await withStorage(storage, () => second.client.joinSession(SESSION_A));
    assert.notEqual(second.client.getCurrentMember().id, participantId);
    assert.equal(second.client.getParticipantId(), participantId);
});

test('an unusable sessionStorage costs stickiness, never a session entry', async () => {
    const blocked = {
        getItem() { throw new Error('storage disabled'); },
        setItem() { throw new Error('storage disabled'); }
    };
    for (const storage of [blocked, undefined]) {
        const { client, state } = await loadClient(storage);
        await withStorage(storage, () => client.createSession());
        assert.equal(client.getParticipantId(), state.lastMemberId);
        await withStorage(storage, () => client.joinSession(SESSION_A));
        assert.equal(client.getParticipantId(), state.lastMemberId,
            'in-memory identity still survives a rejoin without storage');
    }
});
