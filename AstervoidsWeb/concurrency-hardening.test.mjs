import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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

const AuthoritativeObject = evaluateModule(
    'wwwroot/js/authoritative-object.js',
    'AuthoritativeObject',
    {});

const GuidUtils = evaluateModule('wwwroot/js/guid-utils.js', 'GuidUtils', {});

function fixtureGuid(label) {
    const hex = createHash('sha256').update(label).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadSessionClient(
    connections,
    objectSyncBridge = { triggerReconciliation() {} },
    guidUtils = GuidUtils,
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
        AuthoritativeObject,
        signalR: {
            HubConnectionState: {
                Connected: 'Connected',
                Reconnecting: 'Reconnecting'
            }
        }
    });
}

function joinResponse(sessionId, objects = []) {
    sessionId = GuidUtils.transformBinaryGuids(sessionId);
    return {
        sessionId,
        sessionName: sessionId,
        members: [],
        objects,
        validAts: {},
        memberId: fixtureGuid(`member-${sessionId}`),
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
    connection.invokers.set('JoinSession', sessionId =>
        joins.get(GuidUtils.bytesToGuid(sessionId)).promise);
    connection.invokers.set('LeaveSession', () => Promise.resolve());
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);

    const joined = [];
    let leftCallbacks = 0;
    client.on('onSessionJoined', session => joined.push(session.id));
    client.on('onSessionLeft', () => leftCallbacks++);

    joins.set(fixtureGuid('old'), deferred());
    joins.set(fixtureGuid('new'), deferred());
    const oldJoin = client.joinSession(fixtureGuid('old'));
    const newJoin = client.joinSession(fixtureGuid('new'));

    await drainMicrotasks();
    assert.deepEqual(
        connection.invokeCalls.map(call => call.method),
        ['JoinSession']);

    joins.get(fixtureGuid('old')).resolve(joinResponse(fixtureGuid('old')));
    assert.equal((await oldJoin).session.id, fixtureGuid('old'));
    await drainMicrotasks();
    joins.get(fixtureGuid('new')).resolve(joinResponse(fixtureGuid('new')));
    assert.equal((await newJoin).session.id, fixtureGuid('new'));

    assert.equal(client.getCurrentSession().id, fixtureGuid('new'));
    assert.deepEqual(joined, [fixtureGuid('old'), fixtureGuid('new')]);
    assert.equal(leftCallbacks, 1);
    assert.deepEqual(
        connection.invokeCalls.map(call => call.method),
        ['JoinSession', 'LeaveSession', 'JoinSession']);
});

test('SessionClient merges member events that overtake a pending join snapshot', async () => {
    const connection = new FakeConnection();
    const joinGate = deferred();
    const joiningMemberId = joinResponse(fixtureGuid('race')).memberId;
    connection.invokers.set('JoinSession', () => joinGate.promise);
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);

    const callbacks = [];
    client.on('onSessionJoined', session => {
        callbacks.push(`session:${session.members.map(member => member.id).sort().join(',')}`);
    });
    client.on('onMemberJoined', member => callbacks.push(`joined:${member.id}`));
    client.on('onMemberLeft', info => callbacks.push(`left:${info.memberId}`));
    client.on('onRoleChanged', role => callbacks.push(`role:${role}`));

    const joining = client.joinSession(fixtureGuid('race'));
    await drainMicrotasks();
    connection.emit(
        'OnMemberJoined',
        { id: 'late-member', role: 'Client' },
        'late-member',
        1,
        1000);
    connection.emit(
        'OnMemberLeft',
        {
            memberId: 'old-server',
            promotedMemberId: joiningMemberId,
            promotedRole: 'Server',
            deletedObjectIds: [],
            migratedObjects: []
        },
        'old-server',
        2,
        1001);

    assert.deepEqual(callbacks, [], 'member callbacks wait until the snapshot is installed');

    const response = joinResponse(fixtureGuid('race'));
    response.members = [
        { id: 'old-server', role: 'Server' },
        { id: joiningMemberId, role: 'Client' }
    ];
    joinGate.resolve(response);
    const result = await joining;

    assert.deepEqual(
        result.session.members.map(member => member.id).sort(),
        ['late-member', joiningMemberId].sort());
    assert.equal(result.member.role, 'Server');
    assert.deepEqual(callbacks, [
        `session:${['late-member', joiningMemberId].sort().join(',')}`,
        'joined:late-member',
        'left:old-server',
        'role:Server'
    ]);
});

async function sessionEntryHarness(method) {
    const connection = new FakeConnection();
    const { client } = loadSessionClient([connection]);
    await connectImmediately(client, connection);
    const sessionId = fixtureGuid('entry');
    if (method === 'RejoinSession') {
        connection.invokers.set('JoinSession', () => Promise.resolve(joinResponse(sessionId)));
        await client.joinSession(sessionId);
        client.clearSessionState();
    }
    const gate = deferred();
    connection.invokers.set(method, () => gate.promise);
    const response = joinResponse(sessionId);
    response.role = method === 'CreateSession' ? 'Server' : 'Client';
    response.members = [{ id: response.memberId, role: response.role }];
    response.reconnectToken = 'replacement-reconnect-token';
    return {
        client, connection, gate, response,
        eventName: method === 'CreateSession' ? 'onSessionCreated' : 'onSessionJoined',
        enter: () => method === 'CreateSession'
            ? client.createSession() : client.joinSession(sessionId)
    };
}

for (const method of ['CreateSession', 'JoinSession', 'RejoinSession']) {
    test(`${method} installs identity and pending members before entry callbacks`, async () => {
        const { client, connection, gate, response, eventName, enter } = await sessionEntryHarness(method);
        const events = [];
        client.on(eventName, (session, member) => {
            assert.equal(client.getCurrentSession(), session);
            assert.equal(client.getCurrentMember(), member);
            assert.equal(client.getLastSessionId(), session.id);
            assert.deepEqual(session.members.map(m => m.id), [member.id, 'first', 'second']);
            events.push('entry');
            connection.emit('OnMemberJoined', { id: 'during-callback', role: 'Client' }, 'sender', 3, 1003);
        });
        client.on('onMemberJoined', member => events.push(member.id));
        const entering = enter();
        await drainMicrotasks();
        for (const id of ['first', 'second']) {
            connection.emit('OnMemberJoined', { id, role: 'Client' }, 'sender', 1, 1000);
        }
        assert.deepEqual(events, []);
        gate.resolve(response);
        const result = await entering;
        assert.equal(result.session, client.getCurrentSession());
        assert.equal(result.member.role, response.role);
        assert.deepEqual(events, ['entry', 'during-callback', 'first', 'second'],
            'transition is finished before entry callback; buffered callbacks retain their order');

        client.clearSessionState();
        connection.invokers.set('RejoinSession', () => Promise.resolve(response));
        client.on(eventName, null);
        await client.joinSession(response.sessionId);
        assert.deepEqual(connection.invokeCalls.at(-1).args, [
            GuidUtils.guidToBytes(response.sessionId),
            GuidUtils.guidToBytes(response.memberId),
            response.reconnectToken
        ], 'entry installs the latest reconnect credential');
    });

    for (const resetAt of ['entry', 'member']) {
        test(`${method} stops completion after a synchronous ${resetAt} callback reset`, async () => {
            const { client, connection, gate, response, eventName, enter } = await sessionEntryHarness(method);
            const events = [];
            client.on(eventName, () => {
                events.push('entry');
                if (resetAt === 'entry') client.clearSessionState();
            });
            client.on('onMemberJoined', member => {
                events.push(member.id);
                if (resetAt === 'member') client.clearSessionState();
            });
            const entering = enter();
            await drainMicrotasks();
            for (const id of ['first', 'second']) {
                connection.emit('OnMemberJoined', { id, role: 'Client' }, 'sender', 1, 1000);
            }
            gate.resolve(response);
            assert.equal(await entering, null);
            assert.equal(client.getCurrentSession(), null);
            assert.equal(client.getCurrentMember(), null);
            assert.deepEqual(events, resetAt === 'entry' ? ['entry'] : ['entry', 'first']);
        });
    }

    for (const outcome of ['success', 'failure']) {
        test(`${method} ignores a stale ${outcome} response`, async () => {
            const { client, gate, response, eventName, enter } = await sessionEntryHarness(method);
            const events = [];
            client.on(eventName, () => events.push('entry'));
            client.on('onError', () => events.push('error'));
            const entering = enter();
            await drainMicrotasks();
            client.clearSessionState();
            if (outcome === 'success') gate.resolve(response);
            else gate.reject(new Error('stale failure'));
            assert.equal(await entering, null);
            assert.equal(client.getCurrentSession(), null);
            assert.equal(client.getCurrentMember(), null);
            assert.deepEqual(events, []);
        });
    }

    test(`${method} preserves callback failures and can process the next transition`, async () => {
        const { client, connection, gate, response, eventName, enter } = await sessionEntryHarness(method);
        const error = new Error('entry callback failed');
        const errors = [];
        client.on(eventName, () => { throw error; });
        client.on('onError', message => errors.push(message));
        const entering = enter();
        gate.resolve(response);
        await assert.rejects(entering, actual => actual === error);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /entry callback failed/);
        assert.equal(client.getCurrentSession().id, response.sessionId);
        client.on(eventName, null);
        connection.invokers.set('LeaveSession', () => Promise.resolve());
        assert.equal(await client.leaveSession(), true);
        assert.equal(client.getCurrentSession(), null);
    });
}

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
    const joining = client.joinSession(fixtureGuid('newer'));
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
    assert.equal(joined.session.id, fixtureGuid('newer'));
    assert.equal(client.getCurrentSession().id, fixtureGuid('newer'));
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

    await client.joinSession(fixtureGuid('session'));
    assert.equal(
        client.getReconnectHubHostname(),
        'https://regional.example.com');
    const freshJoinCall = connection.invokeCalls
        .filter(call => call.method === 'JoinSession')
        .at(-1);
    assert.deepEqual(freshJoinCall.args, [GuidUtils.guidToBytes(fixtureGuid('session'))]);
    client.clearSessionState();
    await client.joinSession(fixtureGuid('session'));

    const reconnectCall = connection.invokeCalls
        .filter(call => call.method === 'RejoinSession')
        .at(-1);
    assert.deepEqual(
        reconnectCall.args,
        [
            GuidUtils.guidToBytes(fixtureGuid('session')),
            GuidUtils.guidToBytes(joinResponse(fixtureGuid('session')).memberId),
            `token-${fixtureGuid('session')}`
        ]);
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

    await client.joinSession(fixtureGuid('old'));
    await client.joinSession(fixtureGuid('new'));
    connection.emit('OnSessionExpired', fixtureGuid('old'), 'old expired');

    assert.equal(client.getCurrentSession().id, fixtureGuid('new'));
    assert.deepEqual(expirations, []);

    connection.emit('OnSessionExpired', fixtureGuid('new'), 'new expired');
    assert.equal(client.getCurrentSession(), null);
    assert.deepEqual(expirations, [{
        reason: 'new expired',
        sessionId: fixtureGuid('new')
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
    await client.joinSession(fixtureGuid('session'));

    assert.equal(await client.leaveSession(), false);
    assert.equal(client.getCurrentSession().id, fixtureGuid('session'));

    client.clearSessionState();
    await client.joinSession(fixtureGuid('session'));
    const recovery = connection.invokeCalls
        .filter(call => call.method === 'RejoinSession')
        .at(-1);
    assert.deepEqual(
        recovery.args,
        [
            GuidUtils.guidToBytes(fixtureGuid('session')),
            GuidUtils.guidToBytes(joinResponse(fixtureGuid('session')).memberId),
            `token-${fixtureGuid('session')}`
        ]);
});

for (const method of ['CreateSession', 'JoinSession', 'RejoinSession']) {
    test(`${method} rejects session responses without reconnect credentials`, async () => {
        const { client, gate, response, eventName, enter } = await sessionEntryHarness(method);
        let notified = false;
        client.on(eventName, () => { notified = true; });
        delete response.reconnectToken;
        gate.resolve(response);
        await assert.rejects(enter(), /missing reconnectToken/);
        assert.equal(client.getCurrentSession(), null);
        assert.equal(client.getCurrentMember(), null);
        assert.equal(notified, false);
    });
}

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
        GuidUtils,
        syncPayload);

    await connectImmediately(client, connection);
    const joined = await client.joinSession(fixtureGuid('session'));

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
        { ...GuidUtils, transformBinaryGuids });
    let received;
    client.on('onObjectEvent', eventInfo => { received = eventInfo; });
    await connectImmediately(client, connection);
    await client.joinSession(fixtureGuid('session'));

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

    const joining = loaded.client.joinSession(fixtureGuid('session'));
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

    joinGate.resolve(joinResponse(fixtureGuid('session'), [
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

    objectSync.updateObject('shared', { x: 4 });
    assert.equal(calls.length, 1, 'completion is not a flush loop');
    objectSync.tick(0.001);
    await drainMicrotasks();
    assert.equal(calls.length, 2, 'coalesced state leaves on the first eligible tick');
    assert.equal(calls[1].updates[0].data.x, 4);
});

async function replacementHarness() {
    const connection = new FakeConnection();
    const parentId = fixtureGuid('replace-parent');
    const responseGate = deferred();
    connection.invokers.set('JoinSession', sessionId =>
        Promise.resolve(joinResponse(sessionId, [
            objectInfo(parentId, 1, { type: 'counter', value: 1 })
        ])));
    connection.invokers.set('ReplaceObject', () => responseGate.promise);
    let objectSync;
    const loaded = loadSessionClient([connection], {
        triggerReconciliation: () => objectSync?.triggerReconciliation()
    });
    objectSync = loadObjectSync(loaded.client, loaded.window);
    objectSync.init();
    await connectImmediately(loaded.client, connection);
    await loaded.client.joinSession(fixtureGuid('replace-session'));
    return { ...loaded, connection, parentId, responseGate, objectSync };
}

test('replace response applies once, atomically, before resolving the public array', async () => {
    const h = await replacementHarness();
    const children = [
        objectInfo('first', 1, { type: 'counter', value: 2 }, 'me'),
        objectInfo('second', 1, { type: 'counter', value: 3 }, 'other')
    ];
    const order = [];
    const assertAtomic = () => {
        assert.equal(h.objectSync.getObject(h.parentId), undefined);
        assert.deepEqual(h.objectSync.getAllObjects().map(obj => obj.id), ['first', 'second']);
    };
    h.objectSync.on('onObjectDeleted', obj => { assertAtomic(); order.push(['delete', obj.id]); });
    h.objectSync.on('onObjectCreated', obj => { assertAtomic(); order.push(['create', obj.id]); });
    h.objectSync.on('onObjectReplaced', (id, infos, validAt) => {
        assertAtomic();
        assert.deepEqual(infos, children);
        order.push(['replace', id, validAt]);
    });
    const replacing = h.objectSync.replaceObject(h.parentId, children.map(child => child.data));
    assert.ok(h.objectSync.getObject(h.parentId), 'not speculative/local-first');
    h.responseGate.resolve([children, 19, 1234]);
    const result = await replacing;
    assert.ok(Array.isArray(result));
    assert.deepEqual(result, children);
    assert.deepEqual(order, [
        ['delete', h.parentId], ['create', 'first'], ['create', 'second'],
        ['replace', h.parentId, 1234]
    ]);
    assert.equal(h.objectSync.getObject('first').validAt, 1234);
    assert.equal(h.objectSync.getObject('second').validAt, 1234);
    assert.equal(h.objectSync.getReconciliationCount(), 0, 'own sequence jumps do not reconcile');
});

test('delayed replacement cannot resurrect deleted children or rewind updates and migrations', async () => {
    const h = await replacementHarness();
    const ids = ['updated', 'deleted', 'departed', 'migrated', 'snapshotted', 'fresh'];
    const children = ids.map(id =>
        objectInfo(id, 1, { type: 'counter', value: 1, staticField: 'seed' }, 'old-owner'));
    let anchored;
    h.objectSync.on('onObjectReplaced', (_, infos) => { anchored = infos.map(obj => obj.id); });
    const replacing = h.objectSync.replaceObject(h.parentId, children.map(child => child.data));
    h.connection.emit('OnObjectsUpdated',
        [{ id: 'updated', data: { value: 4 }, version: 4 }], 'other', 1, 1, 4000, 50, 3990);
    h.connection.emit('OnObjectDeleted', 'deleted', 'other', 2, 4001);
    h.objectSync.handleMemberDeparture(['departed']);
    h.objectSync.handleOwnershipMigration([
        { objectId: 'migrated', newOwnerId: 'new-owner', newVersion: 2 }
    ]);
    h.connection.emit('OnObjectCreated',
        objectInfo('snapshotted', 1, { type: 'counter', value: 1 }),
        'other', 3, 4002, 1200);
    h.responseGate.resolve([children, 8, 1200]);
    assert.equal((await replacing).length, 6, 'public result remains the server array');
    assert.equal(h.objectSync.getObject('deleted'), undefined);
    assert.equal(h.objectSync.getObject('departed'), undefined);
    assert.equal(h.objectSync.getObject('updated').version, 4);
    assert.equal(h.objectSync.getObject('updated').data.value, 4);
    assert.equal(h.objectSync.getObject('updated').data.staticField, 'seed');
    assert.equal(h.objectSync.getObject('updated').validAt, 3990);
    assert.equal(h.objectSync.getObject('migrated').ownerMemberId, 'new-owner');
    assert.equal(h.objectSync.getObject('migrated').version, 2);
    assert.equal(h.objectSync.getObject('migrated').ownershipMigrationPending, true);
    assert.deepEqual(anchored, ['fresh'], 'older spawn anchors never replace newer presentation');
});

for (const reset of ['clear', 'session']) {
    test(`replacement result is inert after ${reset} epoch reset`, async () => {
        const h = await replacementHarness();
        let notifications = 0;
        h.objectSync.on('onObjectCreated', () => notifications++);
        h.objectSync.on('onObjectReplaced', () => notifications++);
        const replacing = h.objectSync.replaceObject(h.parentId, [{ type: 'counter' }]);
        if (reset === 'clear') h.objectSync.clear();
        else h.client.clearSessionState();
        h.responseGate.resolve([[objectInfo('old-child', 1, { type: 'counter' })], 10, 2000]);
        assert.equal(await replacing, null);
        assert.equal(h.objectSync.getObjectCount(), 0);
        assert.equal(notifications, 0);
    });
}

test('replacement callbacks stop after a synchronous reset', async () => {
    const h = await replacementHarness();
    const notifications = [];
    h.objectSync.on('onObjectDeleted', () => {
        notifications.push('delete');
        h.objectSync.clear();
    });
    h.objectSync.on('onObjectCreated', () => notifications.push('create'));
    h.objectSync.on('onObjectReplaced', () => notifications.push('replace'));
    const replacing = h.objectSync.replaceObject(h.parentId, [{ type: 'counter' }]);
    h.responseGate.resolve([[objectInfo('child', 1, { type: 'counter' })], 10, 2000]);
    assert.equal(await replacing, null);
    assert.deepEqual(notifications, ['delete']);
    assert.equal(h.objectSync.getObjectCount(), 0);
});

test('a lost replacement response reconciles the committed children and removes the ghost parent', async () => {
    const h = await replacementHarness();
    const child = objectInfo('committed-child', 1, { type: 'counter', value: 2 });
    h.connection.invokers.set('GetSessionState', () => Promise.resolve({
        members: [], objects: [child], validAts: [['committed-child', 1234]],
        memberSequences: [[h.client.getCurrentMember().id, 10]]
    }));
    const reconciled = deferred();
    h.objectSync.on('onReconciliationComplete', reconciled.resolve);
    const replacing = h.objectSync.replaceObject(h.parentId, [child.data]);
    h.responseGate.reject(new Error('response lost after commit'));
    await assert.rejects(replacing, /response lost/);
    await reconciled.promise;
    assert.equal(h.objectSync.getObject(h.parentId), undefined);
    assert.equal(h.objectSync.getObject('committed-child').validAt, 1234);
    assert.equal(h.objectSync.getReconciliationCount(), 1);
});

for (const outcome of ['empty', 'null', 'error']) {
    test(`replacement ${outcome} result preserves authoritative success/failure semantics`, async () => {
        const h = await replacementHarness();
        const notifications = [];
        h.objectSync.on('onObjectReplaced', (...args) => notifications.push(args));
        const replacing = h.objectSync.replaceObject(h.parentId, []);
        if (outcome === 'error') {
            h.responseGate.reject(new Error('transport failed'));
            await assert.rejects(replacing, /transport failed/);
        } else {
            h.responseGate.resolve(outcome === 'null' ? null : [[], 2, 3000]);
            assert.deepEqual(await replacing, outcome === 'null' ? null : []);
        }
        assert.equal(!!h.objectSync.getObject(h.parentId), outcome !== 'empty');
        assert.equal(notifications.length, outcome === 'empty' ? 1 : 0);
        if (outcome === 'empty') assert.deepEqual(notifications[0], [h.parentId, [], 3000]);
    });
}

for (const overtaking of ['update', 'delete', 'migration']) {
    test(`create response respects an overtaking ${overtaking}`, async () => {
        const client = makeObjectSyncClient();
        const gate = deferred();
        client.createObject = () => gate.promise;
        const sync = loadObjectSync(client);
        sync.init();
        const creating = sync.createObject({ type: 'counter' });
        if (overtaking === 'update') {
            client.handlers.onObjectsUpdated(
                [{ id: 'child', version: 3, data: { value: 3 } }],
                3000, 'other', 1, 1, 50, 2990);
        } else if (overtaking === 'delete') {
            client.handlers.onObjectDeleted('child', 'other', 1);
        } else {
            sync.handleOwnershipMigration([
                { objectId: 'child', newOwnerId: 'new-owner', newVersion: 2 }
            ]);
        }
        gate.resolve({
            objectInfo: objectInfo('child', 1, { type: 'counter', value: 1, seed: 5 }),
            memberSequence: 1, validAt: 1000
        });
        await creating;
        const child = sync.getObject('child');
        if (overtaking === 'delete') assert.equal(child, undefined);
        else {
            assert.equal(child.data.seed, 5);
            assert.equal(child.version, overtaking === 'update' ? 3 : 2);
            assert.equal(child.ownerMemberId, overtaking === 'update' ? 'owner' : 'new-owner');
            assert.equal(child.validAt, overtaking === 'update' ? 2990 : 1000);
        }
    });
}

function schedulerHarness() {
    const client = makeObjectSyncClient();
    const calls = [];
    client.updateObjects = async (updates, sequence, interval) => {
        calls.push({ updates, sequence, interval });
        return { versions: {}, memberSequence: sequence };
    };
    client.deleteObject = async () => ({ success: true, memberSequence: 1 });
    const sync = loadObjectSync(client);
    sync.init();
    sync.configure({ nominalFrameTime: 0.1, deltaEncoding: false });
    client.join({ objects: [objectInfo('state', 1, { type: 'counter', value: 0 })] });
    return { sync, client, calls };
}

test('elapsed scheduler handles varying frame duration without rounding or catch-up bursts', async () => {
    const { sync, calls } = schedulerHarness();
    sync.updateObject('state', { value: 1 });
    for (const dt of [0.01, 0.04, 0.02, 0.029]) sync.tick(dt);
    assert.equal(calls.length, 0, '99ms is still below the real 100ms interval');
    sync.tick(0.001);
    assert.equal(calls.length, 1);
    await drainMicrotasks();
    sync.updateObject('state', { value: 2 });
    sync.tick(10);
    assert.equal(calls.length, 2, 'a stall grants one opportunity, not 100');
    await drainMicrotasks();
    sync.updateObject('state', { value: 3 });
    sync.tick(0.001);
    assert.equal(calls.length, 2, 'no retained catch-up debt');
    sync.tick(0.099);
    assert.equal(calls.length, 3);
});

test('elapsed scheduler validates time without inventing time for zero or tiny frames', () => {
    const { sync, calls } = schedulerHarness();
    sync.configure({ minFrameTime: 1 });
    sync.updateObject('state', { value: 1 });
    for (const dt of [NaN, Infinity, -Infinity, -1, undefined, '1', 0]) sync.tick(dt);
    for (let i = 0; i < 100; i++) sync.tick(0.0001);
    assert.equal(calls.length, 0);
    sync.tick(0.09);
    assert.equal(calls.length, 1);
    for (const nominalFrameTime of [NaN, Infinity, 0, -1]) {
        assert.throws(() => sync.configure({ nominalFrameTime }), RangeError);
    }
});

test('elapsed scheduler retains due work behind one invoke and only pumps on a tick', async () => {
    const { sync, client, calls } = schedulerHarness();
    const gate = deferred();
    const update = client.updateObjects;
    client.updateObjects = (...args) => { update(...args); return gate.promise; };
    sync.updateObject('state', { value: 1 });
    sync.tick(0.1);
    sync.updateObject('state', { value: 2 });
    sync.tick(5);
    sync.tick(5);
    assert.equal(calls.length, 1);
    client.updateObjects = update;
    sync.configure({ adaptiveSendRate: true });
    sync.updateSendRate(1000);
    gate.resolve({ versions: {}, memberSequence: 1 });
    await drainMicrotasks();
    assert.equal(calls.length, 1, 'no completion-triggered draining');
    sync.tick(0);
    assert.equal(calls.length, 2, 'already-elapsed eligibility is retained');
    assert.equal(calls[1].updates[0].data.value, 2);
    assert.equal(calls[1].interval, 1000, 'slower adaptive cadence cannot revoke existing eligibility');
});

for (const removal of ['delete', 'replace', 'clear']) {
    test(`pending urgency disappears when its object is removed by ${removal}`, async () => {
        const { sync, client, calls } = schedulerHarness();
        const gate = deferred();
        const update = client.updateObjects;
        client.updateObjects = (...args) => { update(...args); return gate.promise; };
        sync.updateObject('state', { value: 1 }, true);
        sync.updateObject('state', { value: 2 }, true);
        if (removal === 'delete') await sync.deleteObject('state');
        else if (removal === 'replace') {
            client.handlers.onObjectReplaced(
                { deletedObjectId: 'state', createdObjects: [] }, 'other', 1, 1000);
        } else sync.clear();
        client.updateObjects = update;
        client.handlers.onObjectCreated(objectInfo('new', 1, { type: 'counter' }), 'other', 2, 1000);
        sync.updateObject('new', { value: 3 });
        gate.resolve({ versions: {}, memberSequence: 1 });
        await drainMicrotasks();
        sync.tick(0.001);
        assert.equal(calls.length, 1, 'ordinary work must not inherit deleted urgency');
        sync.tick(0.099);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].updates.map(obj => obj.objectId), ['new']);
    });
}

test('elapsed scheduler adapts interval changes, ignores invalid RTT, and resets cadence on manual flush', async () => {
    const { sync, calls } = schedulerHarness();
    sync.configure({ adaptiveSendRate: true });
    sync.updateObject('state', { value: 1 });
    sync.tick(0.04);
    sync.updateSendRate(50);
    sync.tick(0.01);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].interval, 50);
    for (const rtt of [NaN, Infinity, -1]) sync.updateSendRate(rtt);
    assert.equal(sync.getSendRate(), 20);
    await drainMicrotasks();
    sync.updateObject('state', { value: 2 });
    sync.tick(0.04);
    await sync.flushUpdates();
    sync.updateObject('state', { value: 3 });
    sync.tick(0.01);
    assert.equal(calls.length, 2);
    sync.tick(0.04);
    assert.equal(calls.length, 3);
});

test('ObjectSync transfers independent type membership snapshots with borrowed records', () => {
    const { sync, client } = schedulerHarness();
    const snapshot = sync.getObjectsByTypeSnapshot('counter');
    assert.equal(snapshot[0], sync.getObject('state'), 'record data is not deep-cloned');
    snapshot.length = 0;
    assert.equal(sync.getObjectsByType('counter').length, 1, 'caller owns the array');
    const retained = sync.getObjectsByTypeSnapshot('counter');
    client.handlers.onObjectDeleted('state', 'other', 1);
    assert.equal(retained.length, 1, 'later registry mutations cannot change membership');
    assert.equal(sync.getObjectsByTypeSnapshot('counter').length, 0);
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

test('create liveness callback cannot apply an old response after resetting the epoch', async () => {
    const client = makeObjectSyncClient();
    client.createObject = async () => ({
        objectInfo: objectInfo('old-object', 1, { type: 'counter' }),
        memberSequence: 1, validAt: 1000
    });
    const sync = loadObjectSync(client);
    sync.init();
    const result = await sync.createObject({ type: 'counter' }, 'Member', null, () => {
        sync.clear();
        return true;
    });
    assert.equal(result, null);
    assert.equal(sync.getObjectCount(), 0);
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
    assert.match(source, /connectToSessionHub\(true, reconnectHubHostname, false\)/);
});
