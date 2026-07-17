import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function deferred() {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function drainMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

class FakeConnection {
    constructor(startGate = null, stopGate = null) {
        this.state = 'Disconnected';
        this.startGate = startGate;
        this.stopGate = stopGate;
        this.handlers = new Map();
        this.invokers = new Map();
        this.invokeCalls = [];
        this.stopCalls = 0;
    }

    async start() {
        if (this.startGate) await this.startGate.promise;
        this.state = 'Connected';
    }

    async stop() {
        this.stopCalls++;
        if (this.stopGate) await this.stopGate.promise;
        this.state = 'Disconnected';
    }

    on(name, handler) {
        this.handlers.set(name, handler);
    }

    onreconnecting(handler) {
        this.reconnectingHandler = handler;
    }

    onreconnected(handler) {
        this.reconnectedHandler = handler;
    }

    onclose(handler) {
        this.closeHandler = handler;
    }

    invoke(method, ...args) {
        this.invokeCalls.push({ method, args });
        const invoker = this.invokers.get(method);
        if (!invoker) throw new Error(`No fake invoker for ${method}`);
        return invoker(...args);
    }

    emit(name, ...args) {
        const handler = this.handlers.get(name);
        assert.ok(handler, `handler registered for ${name}`);
        handler(...args);
    }
}

function makeSignalR(connections) {
    return {
        HubConnectionState: {
            Connected: 'Connected',
            Reconnecting: 'Reconnecting'
        },
        LogLevel: { Information: 'Information' },
        protocols: {
            msgpack: {
                MessagePackHubProtocol: class {}
            }
        },
        HubConnectionBuilder: class {
            withUrl(url) {
                this.url = url;
                return this;
            }

            withHubProtocol() {
                return this;
            }

            withAutomaticReconnect() {
                return this;
            }

            configureLogging() {
                return this;
            }

            build() {
                const connection = connections.shift();
                assert.ok(connection, 'a fake connection is available');
                connection.url = this.url;
                return connection;
            }
        }
    };
}

const WireEnum = {
    roleFromWire: value => value,
    translateMember: value => value,
    translateObject: value => value,
    pairsToObject(value) {
        if (!value) return {};
        return Array.isArray(value) ? Object.fromEntries(value) : value;
    }
};

const SyncPayload = {
    wrap: value => value,
    unwrapObjectData: () => {}
};

function evaluateModule(relativePath, exportName, globals) {
    const source = readFileSync(resolve(here, relativePath), 'utf8');
    const moduleHost = { exports: {} };
    const fn = new Function(
        ...Object.keys(globals),
        'module',
        `${source}\nmodule.exports = ${exportName};`
    );
    fn(...Object.values(globals), moduleHost);
    return moduleHost.exports;
}

function loadSessionClient(
    connections,
    objectSyncBridge = { triggerReconciliation() {} },
    guidUtils = { transformBinaryGuids: value => value },
    syncPayload = SyncPayload) {
    const window = { ASTERVOIDS_DEBUG: false };
    const signalR = makeSignalR(connections);
    const client = evaluateModule('wwwroot/js/session-client.js', 'SessionClient', {
        window,
        console,
        signalR,
        GuidUtils: guidUtils,
        WireEnum,
        SyncPayload: syncPayload,
        ObjectSync: objectSyncBridge,
        setTimeout: (callback, delay) => {
            const timer = setTimeout(callback, delay);
            timer.unref();
            return timer;
        }
    });
    return { client, window };
}

function loadObjectSync(sessionClient, window = { ASTERVOIDS_DEBUG: false }) {
    return evaluateModule('wwwroot/js/object-sync.js', 'ObjectSync', {
        window,
        console,
        SessionClient: sessionClient,
        signalR: {
            HubConnectionState: {
                Connected: 'Connected',
                Reconnecting: 'Reconnecting'
            }
        }
    });
}

function joinResponse(sessionId, objects = []) {
    return {
        sessionId,
        sessionName: sessionId,
        members: [],
        objects,
        validAts: {},
        memberId: `member-${sessionId}`,
        role: 'Client',
        reconnectToken: `token-${sessionId}`,
        metadata: {}
    };
}

function objectInfo(id, version, data, ownerMemberId = 'owner') {
    return {
        id,
        version,
        data,
        ownerMemberId,
        creatorMemberId: ownerMemberId,
        scope: 'Session'
    };
}

async function connectImmediately(client, connection) {
    const result = await client.connect();
    assert.equal(result, true);
    assert.equal(connection.state, 'Connected');
}

function makeObjectSyncClient() {
    const handlers = {};
    let epoch = 0;
    let inSession = true;
    let member = { id: 'me' };
    const client = {
        handlers,
        on(event, callback) {
            handlers[event] = callback;
        },
        getSessionEpoch: () => epoch,
        isInSession: () => inSession,
        getCurrentMember: () => member,
        transition(kind = 'join') {
            epoch++;
            handlers.onSessionTransition?.(kind, epoch);
        },
        join(session, nextMember = member) {
            member = nextMember;
            inSession = true;
            handlers.onSessionJoined?.(session, member);
        },
        leave() {
            epoch++;
            inSession = false;
            handlers.onSessionTransition?.('leave', epoch);
            handlers.onSessionLeft?.();
        },
        broadcastObjectEvent: async () => true
    };
    return client;
}

test('SessionClient keeps only the newest overlapping connect completion', async () => {
    const firstStart = deferred();
    const secondStart = deferred();
    const first = new FakeConnection(firstStart);
    const second = new FakeConnection(secondStart);
    const { client } = loadSessionClient([first, second]);
    let connectedCallbacks = 0;
    client.on('onConnected', () => connectedCallbacks++);

    const firstConnect = client.connect(true, 'https://first.invalid');
    const secondConnect = client.connect(true, 'https://second.invalid');
    await drainMicrotasks();

    secondStart.resolve();
    assert.equal(await secondConnect, true);
    firstStart.resolve();
    assert.equal(await firstConnect, false);

    assert.equal(client.getCurrentHubHostname(), 'https://second.invalid');
    assert.equal(client.isConnected(), true);
    assert.equal(connectedCallbacks, 1);
});

test('SessionClient disconnect completion cannot clear a replacement connection', async () => {
    const stopGate = deferred();
    const first = new FakeConnection(null, stopGate);
    const second = new FakeConnection();
    const { client } = loadSessionClient([first, second]);
    await connectImmediately(client, first);

    const disconnecting = client.disconnect();
    const reconnecting = client.connect(true, 'https://replacement.invalid');
    assert.equal(await reconnecting, true);
    stopGate.resolve();
    await disconnecting;

    assert.equal(client.isConnected(), true);
    assert.equal(client.getCurrentHubHostname(), 'https://replacement.invalid');
});

test('SessionClient serializes overlapping joins through an acknowledged leave', async () => {
    const connection = new FakeConnection();
    const joins = new Map();
    connection.invokers.set('JoinSession', sessionId => joins.get(sessionId).promise);
    connection.invokers.set('LeaveSession', () => Promise.resolve());
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);

    const joined = [];
    let leftCallbacks = 0;
    client.on('onSessionJoined', session => joined.push(session.id));
    client.on('onSessionLeft', () => leftCallbacks++);

    joins.set('old', deferred());
    joins.set('new', deferred());
    const oldJoin = client.joinSession('old');
    const newJoin = client.joinSession('new');

    await drainMicrotasks();
    assert.deepEqual(
        connection.invokeCalls.map(call => call.method),
        ['JoinSession']);

    joins.get('old').resolve(joinResponse('old'));
    assert.equal((await oldJoin).session.id, 'old');
    await drainMicrotasks();
    joins.get('new').resolve(joinResponse('new'));
    assert.equal((await newJoin).session.id, 'new');

    assert.equal(client.getCurrentSession().id, 'new');
    assert.deepEqual(joined, ['old', 'new']);
    assert.equal(leftCallbacks, 1);
    assert.deepEqual(
        connection.invokeCalls.map(call => call.method),
        ['JoinSession', 'LeaveSession', 'JoinSession']);
});

test('SessionClient serializes create then join without orphaning membership', async () => {
    const connection = new FakeConnection();
    const createGate = deferred();
    connection.invokers.set('CreateSession', () => createGate.promise);
    connection.invokers.set('LeaveSession', () => Promise.resolve());
    connection.invokers.set('JoinSession', sessionId => Promise.resolve(joinResponse(sessionId)));
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);

    let createdCallbacks = 0;
    client.on('onSessionCreated', () => createdCallbacks++);
    const creating = client.createSession();
    const joining = client.joinSession('newer');
    createGate.resolve({
        sessionId: 'created',
        sessionName: 'created',
        memberId: 'creator',
        role: 'Server',
        reconnectToken: 'created-token',
        metadata: {}
    });

    assert.equal((await creating).session.id, 'created');
    const joined = await joining;
    assert.equal(joined.session.id, 'newer');
    assert.equal(client.getCurrentSession().id, 'newer');
    assert.equal(createdCallbacks, 1);
    assert.deepEqual(
        connection.invokeCalls.map(call => call.method),
        ['CreateSession', 'LeaveSession', 'JoinSession']);
});

test('SessionClient proves reconnect ownership with the server-issued token', async () => {
    const connection = new FakeConnection();
    connection.invokers.set('JoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId)));
    connection.invokers.set('RejoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId)));
    const { client } = loadSessionClient([connection]);
    assert.equal(
        await client.connect(false, 'https://regional.example.com'),
        true);

    await client.joinSession('session');
    assert.equal(
        client.getReconnectHubHostname(),
        'https://regional.example.com');
    const freshJoinCall = connection.invokeCalls
        .filter(call => call.method === 'JoinSession')
        .at(-1);
    assert.deepEqual(freshJoinCall.args, ['session']);
    client.clearSessionState();
    await client.joinSession('session');

    const reconnectCall = connection.invokeCalls
        .filter(call => call.method === 'RejoinSession')
        .at(-1);
    assert.deepEqual(
        reconnectCall.args,
        ['session', 'member-session', 'token-session']);
});

test('SessionClient ignores delayed expiration for a replaced session', async () => {
    const connection = new FakeConnection();
    connection.invokers.set('JoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId)));
    connection.invokers.set('LeaveSession', () => Promise.resolve());
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);
    const expirations = [];
    client.on('onSessionExpired', (reason, sessionId) =>
        expirations.push({ reason, sessionId }));

    await client.joinSession('old');
    await client.joinSession('new');
    connection.emit('OnSessionExpired', 'old', 'old expired');

    assert.equal(client.getCurrentSession().id, 'new');
    assert.deepEqual(expirations, []);

    connection.emit('OnSessionExpired', 'new', 'new expired');
    assert.equal(client.getCurrentSession(), null);
    assert.deepEqual(expirations, [{
        reason: 'new expired',
        sessionId: 'new'
    }]);
});

test('failed leave keeps reconnect identity available for recovery', async () => {
    const connection = new FakeConnection();
    connection.invokers.set('JoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId)));
    connection.invokers.set('LeaveSession', () =>
        Promise.reject(new Error('ambiguous transport failure')));
    connection.invokers.set('RejoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId)));
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);
    await client.joinSession('session');

    assert.equal(await client.leaveSession(), false);
    assert.equal(client.getCurrentSession().id, 'session');

    client.clearSessionState();
    await client.joinSession('session');
    const recovery = connection.invokeCalls
        .filter(call => call.method === 'RejoinSession')
        .at(-1);
    assert.deepEqual(
        recovery.args,
        ['session', 'member-session', 'token-session']);
});

test('SessionClient rejects session responses without reconnect credentials', async () => {
    const connection = new FakeConnection();
    connection.invokers.set('JoinSession', sessionId => {
        const response = joinResponse(sessionId);
        delete response.reconnectToken;
        return Promise.resolve(response);
    });
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);

    await assert.rejects(
        client.joinSession('session'),
        /missing reconnectToken/);
    assert.equal(client.getCurrentSession(), null);
});

test('SessionClient adapts compact object DTO arrays at every wire boundary', async () => {
    const connection = new FakeConnection();
    const compact = (id, version, data, owner = 'owner') =>
        [id, owner, owner, 'Session', data, version];
    connection.invokers.set('JoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId, [
            compact('snapshot', 1, { type: 'ship', x: 1 })
        ])));
    connection.invokers.set('UpdateObjects', updates => {
        assert.deepEqual(updates, [['snapshot', { x: 2 }]]);
        return Promise.resolve([[['snapshot', 2]], 17, 123]);
    });
    connection.invokers.set('CreateObject', () =>
        Promise.resolve([compact('owned-create', 1, { type: 'bullet' }), 18, 124]));
    connection.invokers.set('DeleteObject', () => Promise.resolve([true, 19]));
    connection.invokers.set('ReplaceObject', () =>
        Promise.resolve([compact('owned-child', 1, { type: 'asteroid' })]));
    connection.invokers.set('GetSessionState', () => Promise.resolve({
        members: [],
        objects: [compact('reconciled', 4, { type: 'gameState' })],
        validAts: [],
        memberSequences: []
    }));
    const { client } = loadSessionClient([connection]);
    const created = [];
    const updated = [];
    const replaced = [];
    const events = [];
    client.on('onObjectCreated', value => created.push(value));
    client.on('onObjectsUpdated', value => updated.push(value));
    client.on('onObjectReplaced', value => replaced.push(value));
    client.on('onObjectEvent', value => events.push(value));

    await connectImmediately(client, connection);
    const joined = await client.joinSession('session');
    assert.equal(joined.session.objects[0].id, 'snapshot');
    assert.equal(joined.session.objects[0].data.x, 1);

    connection.emit('OnObjectCreated',
        compact('created', 1, { type: 'asteroid' }), 'sender', 1, 10, 10);
    connection.emit('OnObjectsUpdated',
        [['created', { x: 2 }, 2]], 'sender', 1, 2, 10, 16, 10);
    connection.emit('OnObjectReplaced',
        ['created', [compact('child', 1, { type: 'asteroid' })]],
        'sender', 3, 10, 10);
    connection.emit('OnObjectEvent',
        ['snapshot', 1, new Uint8Array([0x80])], 'sender', 4, 10, 10);

    assert.equal(created[0].id, 'created');
    assert.equal(updated[0][0].id, 'created');
    assert.equal(replaced[0].deletedObjectId, 'created');
    assert.equal(replaced[0].createdObjects[0].id, 'child');
    assert.equal(events[0].objectId, 'snapshot');

    const updateResponse = await client.updateObjects([
        { objectId: 'snapshot', data: { x: 2 } }
    ]);
    const createResponse = await client.createObject({ type: 'bullet' }, 'Member');
    const replacement = await client.replaceObject('snapshot', [{ type: 'asteroid' }]);
    const deleteResponse = await client.deleteObject('snapshot');
    const reconciliation = await client.getSessionState();
    assert.deepEqual(updateResponse.versions, { snapshot: 2 });
    assert.equal(updateResponse.memberSequence, 17);
    assert.equal(createResponse.objectInfo.id, 'owned-create');
    assert.equal(createResponse.memberSequence, 18);
    assert.equal(replacement[0].id, 'owned-child');
    assert.equal(deleteResponse.success, true);
    assert.equal(deleteResponse.memberSequence, 19);
    assert.equal(reconciliation.objects[0].id, 'reconciled');
});

test('SessionClient installs session schemas before decoding a join snapshot', async () => {
    const connection = new FakeConnection();
    connection.invokers.set('JoinSession', sessionId => Promise.resolve({
        ...joinResponse(sessionId, [
            ['snapshot', 'owner', 'owner', 'Session', [7, new Uint8Array([0])], 1]
        ]),
        metadata: {
            schemas: [{ id: 7, fields: [['type', 'str']] }]
        }
    }));
    let schemasInstalled = false;
    const syncPayload = {
        wrap: value => value,
        replaceSchemas(schemas) {
            assert.equal(schemas[0].id, 7);
            schemasInstalled = true;
        },
        unwrapObjectData(objectInfo) {
            assert.equal(schemasInstalled, true);
            objectInfo.data = { type: 'widget' };
        }
    };
    const { client } = loadSessionClient(
        [connection],
        { triggerReconciliation() {} },
        { transformBinaryGuids: value => value },
        syncPayload);

    await connectImmediately(client, connection);
    const joined = await client.joinSession('session');

    assert.equal(joined.session.objects[0].data.type, 'widget');
});

test('SessionClient preserves 16-byte opaque event payloads during GUID normalization', async () => {
    const connection = new FakeConnection();
    connection.invokers.set('JoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId, [])));
    const transformBinaryGuids = value => {
        if (value instanceof Uint8Array && value.length === 16) return 'converted-guid';
        if (Array.isArray(value)) return value.map(transformBinaryGuids);
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) =>
                    [key, transformBinaryGuids(item)]));
        }
        return value;
    };
    const { client } = loadSessionClient(
        [connection],
        { triggerReconciliation() {} },
        { transformBinaryGuids });
    let received;
    client.on('onObjectEvent', eventInfo => { received = eventInfo; });
    await connectImmediately(client, connection);
    await client.joinSession('session');

    const payload = new Uint8Array(16);
    payload.fill(0x2a);
    connection.emit(
        'OnObjectEvent',
        [new Uint8Array(16), 1, payload],
        new Uint8Array(16),
        1,
        10,
        10);

    assert.equal(received.objectId, 'converted-guid');
    assert.ok(received.payload instanceof Uint8Array);
    assert.deepEqual(received.payload, payload);
});

test('join snapshot preserves object events delivered before JoinSession returns', async () => {
    const connection = new FakeConnection();
    const joinGate = deferred();
    connection.invokers.set('JoinSession', () => joinGate.promise);

    let objectSync;
    const bridge = {
        triggerReconciliation() {
            return objectSync?.triggerReconciliation();
        }
    };
    const loaded = loadSessionClient([connection], bridge);
    objectSync = loadObjectSync(loaded.client, loaded.window);
    objectSync.init();
    await connectImmediately(loaded.client, connection);

    const joining = loaded.client.joinSession('session');
    await drainMicrotasks();
    connection.emit(
        'OnObjectCreated',
        objectInfo('live', 2, { type: 'ship', x: 2 }, 'live-owner'),
        'remote',
        1,
        100,
        90
    );
    connection.emit(
        'OnObjectsUpdated',
        [{ id: 'live', version: 3, data: { x: 3 } }],
        'remote',
        1,
        2,
        101,
        33,
        91
    );
    connection.emit('OnObjectDeleted', 'deleted-during-join', 'remote', 3, 102);

    joinGate.resolve(joinResponse('session', [
        objectInfo('live', 1, { type: 'ship', x: 1, staticValue: 42 }, 'snapshot-owner'),
        objectInfo('snapshot-only', 1, { type: 'rock' }),
        objectInfo('deleted-during-join', 1, { type: 'ghost' })
    ]));
    await joining;

    const live = objectSync.getObject('live');
    assert.equal(live.version, 3);
    assert.equal(live.data.x, 3);
    assert.equal(live.data.staticValue, 42);
    assert.equal(live.ownerMemberId, 'live-owner');
    assert.ok(objectSync.getObject('snapshot-only'));
    assert.equal(objectSync.getObject('deleted-during-join'), undefined);
});

test('reconciliation merges monotonically with events received while awaiting', async () => {
    const client = makeObjectSyncClient();
    const snapshotGate = deferred();
    let snapshotCalls = 0;
    client.getSessionState = () => {
        snapshotCalls++;
        return snapshotGate.promise;
    };
    const objectSync = loadObjectSync(client);
    objectSync.init();
    client.transition();
    client.join({
        objects: [objectInfo('existing', 1, { x: 1 }, 'owner-1')],
        validAts: {},
        metadata: {}
    });

    const reconciliation = objectSync.triggerReconciliation();
    objectSync.handleOwnershipMigration([
        { objectId: 'existing', newOwnerId: 'live-owner', newVersion: 3 }
    ]);
    client.handlers.onObjectCreated(
        objectInfo('live-create', 1, { x: 9 }),
        'remote',
        7,
        100
    );

    snapshotGate.resolve({
        objects: [objectInfo('existing', 2, { x: 2 }, 'snapshot-owner')],
        validAts: {},
        memberSequences: { remote: 5 }
    });
    await reconciliation;

    assert.equal(objectSync.getObject('existing').version, 3);
    assert.equal(objectSync.getObject('existing').ownerMemberId, 'live-owner');
    assert.ok(objectSync.getObject('live-create'));

    objectSync.trackEventSequence('remote', 8);
    await drainMicrotasks();
    assert.equal(snapshotCalls, 1, 'snapshot sequence did not lower the live baseline');
});

test('stale reconciliation cannot mutate a new session or clear its in-flight flag', async () => {
    const client = makeObjectSyncClient();
    const firstSnapshot = deferred();
    const secondSnapshot = deferred();
    const snapshots = [firstSnapshot, secondSnapshot];
    client.getSessionState = () => snapshots.shift().promise;
    const objectSync = loadObjectSync(client);
    objectSync.init();

    client.transition();
    client.join({
        objects: [objectInfo('shared', 1, { session: 'first' })],
        validAts: {},
        metadata: {}
    });
    const firstReconciliation = objectSync.triggerReconciliation();

    client.transition();
    client.join({
        objects: [objectInfo('shared', 10, { session: 'second' })],
        validAts: {},
        metadata: {}
    });
    const secondReconciliation = objectSync.triggerReconciliation();

    firstSnapshot.resolve({
        objects: [objectInfo('shared', 99, { session: 'stale' })],
        validAts: {},
        memberSequences: {}
    });
    await firstReconciliation;
    assert.equal(objectSync.getObject('shared').data.session, 'second');
    assert.equal(objectSync.isReconciling(), true);

    secondSnapshot.resolve({
        objects: [objectInfo('shared', 11, { session: 'second-new' })],
        validAts: {},
        memberSequences: {}
    });
    await secondReconciliation;
    assert.equal(objectSync.getObject('shared').data.session, 'second-new');
    assert.equal(objectSync.isReconciling(), false);
});

test('stale flush cannot mutate or unlock a new session flush', async () => {
    const client = makeObjectSyncClient();
    const updateGates = [deferred(), deferred(), deferred()];
    let updateCalls = 0;
    client.updateObjects = () => updateGates[updateCalls++].promise;
    const objectSync = loadObjectSync(client);
    objectSync.init();

    client.transition();
    client.join({
        objects: [objectInfo('shared', 1, { x: 1 })],
        validAts: {},
        metadata: {}
    });
    objectSync.updateObject('shared', { x: 2 });
    const firstFlush = objectSync.flushUpdates();

    client.transition();
    client.join({
        objects: [objectInfo('shared', 10, { x: 10 })],
        validAts: {},
        metadata: {}
    });
    objectSync.updateObject('shared', { x: 11 });
    const secondFlush = objectSync.flushUpdates();
    assert.equal(updateCalls, 2);

    updateGates[0].resolve({ versions: { shared: 99 }, memberSequence: 99 });
    await firstFlush;
    assert.equal(objectSync.getObject('shared').version, 10);

    objectSync.updateObject('shared', { x: 12 });
    await objectSync.flushUpdates();
    assert.equal(updateCalls, 2, 'old finally did not unlock the new flush');

    updateGates[1].resolve({ versions: { shared: 11 }, memberSequence: 1 });
    await secondFlush;
    assert.equal(objectSync.getObject('shared').version, 11);

    const thirdFlush = objectSync.flushUpdates();
    assert.equal(updateCalls, 3);
    updateGates[2].resolve({ versions: { shared: 12 }, memberSequence: 2 });
    await thirdFlush;
});

test('outbound confirmation is tracked with delta encoding disabled', async () => {
    const client = makeObjectSyncClient();
    client.updateObjects = async () => ({
        versions: { accepted: 2 },
        memberSequence: 1
    });
    const objectSync = loadObjectSync(client);
    objectSync.init();
    objectSync.configure({ deltaEncoding: false });

    client.transition();
    client.join({
        objects: [
            objectInfo('accepted', 1, { x: 0 }),
            objectInfo('rejected', 1, { x: 0 })
        ],
        validAts: {},
        metadata: {}
    });
    const terminal = {
        terminalEpoch: 10,
        terminalX: 0.25,
        terminalY: 0.75
    };
    objectSync.updateObject('accepted', terminal);
    objectSync.updateObject('rejected', terminal);
    assert.equal(objectSync.isDataConfirmed('accepted', terminal), false);

    await objectSync.flushUpdates();

    assert.equal(objectSync.isDataConfirmed('accepted', terminal), true);
    assert.equal(objectSync.isDataConfirmed('rejected', terminal), false);
    assert.equal(objectSync.isDataConfirmed(
        'accepted',
        { ...terminal, terminalX: 0.5 }), false);
});

test('byte-array deltas and confirmations compare by content', async () => {
    const client = makeObjectSyncClient();
    let updateCalls = 0;
    client.updateObjects = async updates => {
        updateCalls++;
        return {
            versions: Object.fromEntries(updates.map(update => [update.objectId, 2])),
            memberSequence: 1
        };
    };
    const objectSync = loadObjectSync(client);
    objectSync.init();
    objectSync.configure({ deltaEncoding: true });

    client.transition();
    client.join({
        objects: [objectInfo('state', 1, {
            processedHits: new Uint8Array([1, 2])
        })],
        validAts: {},
        metadata: {}
    });

    objectSync.updateObject('state', {
        processedHits: new Uint8Array([1, 2])
    });
    await objectSync.flushUpdates();
    assert.equal(updateCalls, 0, 'equal byte content must not produce a delta');

    objectSync.updateObject('state', {
        processedHits: new Uint8Array([1, 3])
    });
    await objectSync.flushUpdates();
    assert.equal(updateCalls, 1);
    assert.equal(objectSync.isDataConfirmed('state', {
        processedHits: new Uint8Array([1, 3])
    }), true);
});

test('byte-array confirmation snapshots cannot drift while a flush is in flight', async () => {
    const client = makeObjectSyncClient();
    const firstResponse = deferred();
    let updateCalls = 0;
    let sentBytes;
    client.updateObjects = updates => {
        updateCalls++;
        sentBytes = updates[0].data.processedHits.slice();
        if (updateCalls === 1) return firstResponse.promise;
        return Promise.resolve({
            versions: { state: 3 },
            memberSequence: updateCalls
        });
    };
    const objectSync = loadObjectSync(client);
    objectSync.init();
    objectSync.configure({ deltaEncoding: true });
    client.transition();
    client.join({
        objects: [objectInfo('state', 1, {
            processedHits: new Uint8Array([1, 2])
        })],
        validAts: {},
        metadata: {}
    });

    const mutable = new Uint8Array([1, 3]);
    objectSync.updateObject('state', { processedHits: mutable });
    const flush = objectSync.flushUpdates();
    await drainMicrotasks();
    mutable[1] = 4;
    firstResponse.resolve({ versions: { state: 2 }, memberSequence: 1 });
    await flush;

    assert.deepEqual(Array.from(sentBytes), [1, 3]);
    assert.equal(objectSync.isDataConfirmed('state', {
        processedHits: new Uint8Array([1, 3])
    }), true);
    assert.equal(objectSync.isDataConfirmed('state', {
        processedHits: mutable
    }), false);

    objectSync.updateObject('state', { processedHits: mutable });
    await objectSync.flushUpdates();
    assert.equal(updateCalls, 2, 'the post-send mutation must remain eligible');
});

test('authoritative reconciliation confirms a write whose response was lost', async () => {
    const client = makeObjectSyncClient();
    const terminal = {
        terminalEpoch: 10,
        terminalX: 0.25,
        terminalY: 0.75
    };
    client.updateObjects = async () => {
        throw new Error('response lost after server commit');
    };
    client.getSessionState = async () => ({
        objects: [objectInfo('shared', 2, { x: 0, ...terminal }, 'me')],
        validAts: {},
        memberSequences: {}
    });
    const objectSync = loadObjectSync(client);
    objectSync.init();
    objectSync.configure({ deltaEncoding: false });

    client.transition();
    client.join({
        objects: [objectInfo('shared', 1, { x: 0 }, 'me')],
        validAts: {},
        metadata: {}
    });
    objectSync.updateObject('shared', terminal);
    await objectSync.flushUpdates();
    assert.equal(objectSync.isDataConfirmed('shared', terminal), false);

    await objectSync.triggerReconciliation();

    assert.equal(objectSync.isDataConfirmed('shared', terminal), true);
});

test('immediate update flushes now and coalesces behind in-flight backpressure', async () => {
    const client = makeObjectSyncClient();
    const firstUpdate = deferred();
    const calls = [];
    client.updateObjects = (updates, senderSequence) => {
        calls.push({ updates, senderSequence });
        if (calls.length === 1) return firstUpdate.promise;
        return Promise.resolve({
            versions: { shared: 3 },
            memberSequence: 2,
            serverTimestamp: Date.now()
        });
    };
    const objectSync = loadObjectSync(client);
    objectSync.init();
    objectSync.configure({ deltaEncoding: false });

    client.transition();
    client.join({
        objects: [objectInfo('shared', 1, { x: 1 })],
        validAts: {},
        metadata: {}
    });

    objectSync.updateObject('shared', { x: 2 }, true);
    assert.equal(calls.length, 1, 'immediate update enters the transport in the same turn');
    assert.equal(calls[0].updates[0].data.x, 2);

    objectSync.updateObject('shared', { x: 3 }, true);
    assert.equal(calls.length, 1, 'an immediate edge never overlaps an in-flight invoke');

    firstUpdate.resolve({
        versions: { shared: 2 },
        memberSequence: 1,
        serverTimestamp: Date.now()
    });
    await drainMicrotasks();

    objectSync.tick(1);
    await drainMicrotasks();
    assert.equal(calls.length, 2, 'coalesced state leaves on the first eligible tick');
    assert.equal(calls[1].updates[0].data.x, 3);
});

test('stale create completion is ignored after reset', async () => {
    const client = makeObjectSyncClient();
    const createGate = deferred();
    client.createObject = () => createGate.promise;
    client.deleteObject = async () => ({ success: true });
    const objectSync = loadObjectSync(client);
    objectSync.init();

    client.transition();
    client.join({ objects: [], validAts: {}, metadata: {} });
    const creating = objectSync.createObject({ type: 'old' });

    client.transition();
    client.join({ objects: [], validAts: {}, metadata: {} });
    createGate.resolve({
        objectInfo: objectInfo('old-object', 1, { type: 'old' }),
        memberSequence: 1
    });

    assert.equal(await creating, null);
    assert.equal(objectSync.getObject('old-object'), undefined);
});

test('stale delete completion cannot clear the next session pending delete', async () => {
    const client = makeObjectSyncClient();
    const deleteGates = [deferred(), deferred()];
    let deleteCalls = 0;
    client.deleteObject = () => deleteGates[deleteCalls++].promise;
    client.getSessionState = async () => ({
        objects: [objectInfo('shared', 10, { session: 'second' })],
        validAts: {},
        memberSequences: {}
    });
    const objectSync = loadObjectSync(client);
    objectSync.init();

    client.transition();
    client.join({
        objects: [objectInfo('shared', 1, { session: 'first' })],
        validAts: {},
        metadata: {}
    });
    const firstDelete = objectSync.deleteObject('shared');

    client.transition();
    client.join({
        objects: [objectInfo('shared', 10, { session: 'second' })],
        validAts: {},
        metadata: {}
    });
    const secondDelete = objectSync.deleteObject('shared');

    deleteGates[0].resolve({ success: true, memberSequence: 9 });
    assert.equal(await firstDelete, false);
    await objectSync.triggerReconciliation();
    assert.equal(
        objectSync.getObject('shared'),
        undefined,
        'new session pending delete remained protected from reconciliation'
    );

    deleteGates[1].resolve({ success: true, memberSequence: 1 });
    assert.equal(await secondDelete, true);
});

test('ownership migration is strictly version-monotonic', () => {
    const client = makeObjectSyncClient();
    const objectSync = loadObjectSync(client);
    objectSync.init();
    client.transition();
    client.join({
        objects: [objectInfo('owned', 5, { x: 1 }, 'current-owner')],
        validAts: {},
        metadata: {}
    });

    objectSync.handleOwnershipMigration([
        { objectId: 'owned', newOwnerId: 'older-owner', newVersion: 4 },
        { objectId: 'owned', newOwnerId: 'equal-owner', newVersion: 5 },
        { objectId: 'missing', newOwnerId: 'nobody', newVersion: 8 }
    ]);
    assert.equal(objectSync.getObject('owned').ownerMemberId, 'current-owner');
    assert.equal(objectSync.getObject('owned').version, 5);
    assert.equal(objectSync.getObject('missing'), undefined);

    objectSync.handleOwnershipMigration([
        { objectId: 'owned', newOwnerId: 'new-owner', newVersion: 6 }
    ]);
    assert.equal(objectSync.getObject('owned').ownerMemberId, 'new-owner');
    assert.equal(objectSync.getObject('owned').version, 6);
    assert.equal(objectSync.getObject('owned').ownershipMigrationVersion, 6);
    assert.equal(objectSync.getObject('owned').ownershipMigrationPending, true);
});

test('inline async systems are generation-scoped in production source', () => {
    const source = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');

    assert.match(source, /queuePingBurst\(burstSize, generation = this\.clock\.generation\)/);
    assert.match(source, /startGameOperation === operation\s*&& isGameStartContextCurrent\(context\)/);
    assert.match(source, /await init\(isCurrent\)/);
    assert.match(source, /await spawnWave\(isCurrentStart\)/);
    assert.match(source, /connectToSessionHub\(true, reconnectHubHostname\)/);
});
