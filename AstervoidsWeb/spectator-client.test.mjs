/**
 * SpectatorClient tests.
 *
 * SpectatorClient.js is a browser IIFE that depends on the SignalR JS SDK
 * (`window.signalR.HubConnectionBuilder` + `signalR.HubConnectionState`).
 * Under Node we stub both: a minimal HubConnectionBuilder that returns a
 * fake connection with .start/.stop/.on/.onreconnecting hooks lets us
 * exercise SpectatorClient's open/close/dispatch/state-tracking logic
 * without touching real WebSockets.
 *
 * The tests focus on the contract picker code depends on:
 *   - openAll opens one connection per region (skipping excluded hostname)
 *   - the sessionsChanged event fires per region when the server pushes
 *   - closeAllExcept keeps exactly one connection alive
 *   - connectionStateChanged surfaces reconnect/close transitions
 *     (the picker uses these to drive its ↻ stale-region badge)
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// ── SignalR stub ────────────────────────────────────────────────────────────
// Each `start()` call resolves immediately; `stop()` resolves immediately.
// `.on(method, handler)` stores handlers per connection so the test can
// invoke `triggerPush('OnSessionsChanged')` to simulate a server broadcast.
// onreconnecting / onreconnected / onclose are simple callback registers.
function makeSignalRStub() {
    const connections = [];
    class HubConnectionBuilder {
        constructor() { this._cfg = { url: null, protocol: null, retry: null }; }
        withUrl(url) { this._cfg.url = url; return this; }
        withHubProtocol(p) { this._cfg.protocol = p; return this; }
        withAutomaticReconnect(cfg) { this._cfg.retry = cfg; return this; }
        configureLogging(_) { return this; }
        build() {
            const handlers = new Map();
            const reconnectingHandlers = [];
            const reconnectedHandlers = [];
            const closeHandlers = [];
            const conn = {
                state: 0,  // Disconnected (matches HubConnectionState.Disconnected = 0)
                url: this._cfg.url,
                start: async () => { conn.state = 1; /* Connected */ },
                stop: async () => { conn.state = 4; /* Disconnected */ closeHandlers.forEach(h => h()); },
                on: (method, h) => handlers.set(method, h),
                onreconnecting: h => reconnectingHandlers.push(h),
                onreconnected: h => reconnectedHandlers.push(h),
                onclose: h => closeHandlers.push(h),
                // Test hooks
                _triggerPush: (method, ...args) => {
                    const h = handlers.get(method);
                    if (h) h(...args);
                },
                _triggerReconnecting: () => reconnectingHandlers.forEach(h => h()),
                _triggerReconnected: () => reconnectedHandlers.forEach(h => h()),
                _triggerClose: () => closeHandlers.forEach(h => h()),
            };
            connections.push(conn);
            return conn;
        }
    }
    return {
        signalR: {
            HubConnectionBuilder,
            HubConnectionState: { Disconnected: 0, Connected: 1, Connecting: 2, Reconnecting: 3 },
            LogLevel: { Trace: 0, Debug: 1, Information: 2, Warning: 3, Error: 4, Critical: 5, None: 6 },
            protocols: { msgpack: { MessagePackHubProtocol: function () { } } },
        },
        connections,
    };
}

function loadSpectatorClient(globalStub) {
    // Inject the stub into globalThis BEFORE requiring the module — the IIFE
    // captures `signalR` from the global scope at execution time.
    for (const [k, v] of Object.entries(globalStub)) {
        globalThis[k] = v;
    }
    globalThis.window = globalThis.window || {};
    globalThis.window.ASTERVOIDS_DEBUG = false;
    // Bust any prior require cache so each test gets a fresh module instance.
    const path = resolve(here, 'wwwroot/js/spectator-client.js');
    delete require.cache[require.resolve(path)];
    return require(path);
}

describe('SpectatorClient.openAll', () => {
    let stub, SpectatorClient;
    beforeEach(() => {
        stub = makeSignalRStub();
        SpectatorClient = loadSpectatorClient(stub);
    });

    test('opens one connection per region', async () => {
        await SpectatorClient.openAll([
            { id: 'westus2', displayName: 'US West', hostname: 'https://a.example.com' },
            { id: 'eastus', displayName: 'US East', hostname: 'https://b.example.com' },
            { id: 'westeurope', displayName: 'EU West', hostname: 'https://c.example.com' },
        ]);
        assert.equal(stub.connections.length, 3, 'one connection per region');
        const urls = stub.connections.map(c => c.url).sort();
        assert.deepEqual(urls, [
            'https://a.example.com/sessionHub',
            'https://b.example.com/sessionHub',
            'https://c.example.com/sessionHub',
        ]);
        assert.deepEqual(SpectatorClient.getOpenRegionIds().sort(), ['eastus', 'westeurope', 'westus2']);
    });

    test('skips region whose hostname matches excludeHostname', async () => {
        // The picker uses this to avoid duplicate connections to the region
        // SessionClient is already joined to.
        await SpectatorClient.openAll([
            { id: 'westus2', displayName: 'US West', hostname: 'https://a.example.com' },
            { id: 'eastus', displayName: 'US East', hostname: 'https://b.example.com' },
        ], 'https://a.example.com');
        assert.equal(stub.connections.length, 1, 'eastus only — westus2 excluded');
        assert.equal(stub.connections[0].url, 'https://b.example.com/sessionHub');
        assert.deepEqual(SpectatorClient.getOpenRegionIds(), ['eastus']);
    });

    test('exclude matches even when configured hostname has a trailing slash', async () => {
        // RegionService normalises trailing slashes off; the picker passes
        // raw current-hub hostnames which may or may not have a slash.
        await SpectatorClient.openAll([
            { id: 'a', displayName: 'A', hostname: 'https://a.example.com/' },
        ], 'https://a.example.com');
        assert.equal(stub.connections.length, 0,
            'trailing-slash variants of the same host must match — no duplicate spectator on the joined region');
    });
});

describe('SpectatorClient sessionsChanged dispatch', () => {
    let stub, SpectatorClient;
    beforeEach(() => {
        stub = makeSignalRStub();
        SpectatorClient = loadSpectatorClient(stub);
    });

    test('emits sessionsChanged(regionId) when its region broadcasts OnSessionsChanged', async () => {
        const received = [];
        SpectatorClient.on('sessionsChanged', id => received.push(id));
        await SpectatorClient.openAll([
            { id: 'westus2', displayName: 'US West', hostname: 'https://a.example.com' },
            { id: 'eastus', displayName: 'US East', hostname: 'https://b.example.com' },
        ]);
        stub.connections[0]._triggerPush('OnSessionsChanged');
        stub.connections[1]._triggerPush('OnSessionsChanged');
        stub.connections[0]._triggerPush('OnSessionsChanged');
        assert.deepEqual(received, ['westus2', 'eastus', 'westus2'],
            'each region pushes independently — the picker depends on this to know which /api/sessions to refetch');
    });

    test('connectionStateChanged surfaces reconnect/close transitions', async () => {
        const events = [];
        SpectatorClient.on('connectionStateChanged', (id, s) => events.push(`${id}:${s}`));
        await SpectatorClient.openAll([
            { id: 'r1', displayName: 'R1', hostname: 'https://r1.example.com' },
        ]);
        // Initial open emits one event: connecting → open
        assert.ok(events.includes('r1:open'),
            `expected r1:open in events, got: ${events.join(', ')}`);

        stub.connections[0]._triggerReconnecting();
        stub.connections[0]._triggerReconnected();
        await SpectatorClient.closeOne('r1');

        const tail = events.slice(events.indexOf('r1:open') + 1);
        assert.deepEqual(tail, ['r1:reconnecting', 'r1:open'],
            'reconnect cycle surfaces the picker-visible state transitions used by the ↻ stale-region badge');
    });
});

describe('SpectatorClient.closeAllExcept', () => {
    let stub, SpectatorClient;
    beforeEach(() => {
        stub = makeSignalRStub();
        SpectatorClient = loadSpectatorClient(stub);
    });

    test('closes every connection except the one named', async () => {
        await SpectatorClient.openAll([
            { id: 'r1', displayName: 'R1', hostname: 'https://r1.example.com' },
            { id: 'r2', displayName: 'R2', hostname: 'https://r2.example.com' },
            { id: 'r3', displayName: 'R3', hostname: 'https://r3.example.com' },
        ]);
        assert.equal(SpectatorClient.getOpenRegionIds().length, 3);
        await SpectatorClient.closeAllExcept('r2');
        assert.deepEqual(SpectatorClient.getOpenRegionIds(), ['r2'],
            'used on Create/Join handoff: keep the target region open, drop the rest to honor scale-to-zero');
    });

    test('closeAll closes everything', async () => {
        await SpectatorClient.openAll([
            { id: 'r1', displayName: 'R1', hostname: 'https://r1.example.com' },
            { id: 'r2', displayName: 'R2', hostname: 'https://r2.example.com' },
        ]);
        await SpectatorClient.closeAll();
        assert.deepEqual(SpectatorClient.getOpenRegionIds(), [],
            'closeAll fires on Solo / document.hidden so no spectator outlives the picker');
    });
});

describe('SpectatorClient error tolerance', () => {
    test('failed connection start surfaces as closed state without throwing', async () => {
        // Simulate a region whose WebSocket negotiation fails: start() rejects.
        const stub = makeSignalRStub();
        const origBuilder = stub.signalR.HubConnectionBuilder;
        stub.signalR.HubConnectionBuilder = class extends origBuilder {
            build() {
                const conn = super.build();
                conn.start = async () => { throw new Error('connect refused'); };
                return conn;
            }
        };
        const SpectatorClient = loadSpectatorClient(stub);

        await SpectatorClient.openAll([
            { id: 'down', displayName: 'Down', hostname: 'https://down.example.com' },
        ]);
        assert.equal(SpectatorClient.getState('down'), 'closed',
            'a region whose connection fails reports closed — picker can drop its rows / show ⚠');
    });
});
