import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './classic-module.mjs';

const require = createRequire(import.meta.url);
export const GuidUtils = require('../wwwroot/js/guid-utils.js');
export const MsgpackCodec = require('../wwwroot/js/msgpack-codec.js');
export const SchemaCodec = require('../wwwroot/js/schema-codec.js');
export const WireEnum = require('../wwwroot/js/wire-enum.js');

/**
 * Boot the real SessionClient against a stub hub connection.
 *
 * `reply(method, ...args)` produces the hub response for each invoke, so a test
 * only supplies the behavior it is actually about. Everything else here is the
 * minimal signalR surface the module touches, which is identical for every
 * caller and so is not worth restating per test file.
 *
 * @param {object} options
 * @param {(method: string, ...args: any[]) => any} options.reply Hub responder.
 * @param {object} [options.guidUtils] Override to probe the GUID boundary.
 * @param {object} [options.sessionStorage] Bound only while the module loads,
 *   which is when SessionClient reads its persisted participant identities.
 */
export async function loadSessionClient({ reply, guidUtils = GuidUtils, sessionStorage } = {}) {
    const window = { ASTERVOIDS_DEBUG: false, SchemaCodec };
    const SyncPayload = loadClassicModule('sync-payload.js', 'SyncPayload', {
        window, MsgpackCodec
    });
    const calls = [];
    const handlers = new Map();
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
            return reply(method, ...args);
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
    const client = await withSessionStorage(sessionStorage, async () =>
        loadClassicModule('session-client.js', 'SessionClient', {
            window, signalR, GuidUtils: guidUtils, WireEnum, SyncPayload
        }));
    assert.equal(await client.connect(), true);
    return { client, calls, handlers, connection, SyncPayload };
}

/** SessionClient reads storage lazily, so rebind it for the duration of a call. */
export async function withSessionStorage(storage, action) {
    const previous = globalThis.sessionStorage;
    globalThis.sessionStorage = storage;
    try {
        return await action();
    } finally {
        globalThis.sessionStorage = previous;
    }
}

/** An in-memory `sessionStorage` that survives a simulated page reload. */
export function memoryStorage(entries = new Map()) {
    return {
        entries,
        getItem: key => entries.get(key) ?? null,
        setItem: (key, value) => entries.set(key, String(value))
    };
}
