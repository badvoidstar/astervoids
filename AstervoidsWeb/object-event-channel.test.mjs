/**
 * Unit tests for ObjectSync.registerEventKind / emitEvent / dispatch
 * (Phase 2.1 generic per-object event channel).
 *
 * Loads object-sync.js with stubbed SessionClient + signalR globals so we can
 * exercise the registration/dispatch logic without a hub connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');

function loadObjectSync(stubs) {
    // Stubs we feed into the global before evaluating object-sync.js.
    const globals = {
        SessionClient: stubs.SessionClient,
        MsgpackCodec,
        AuthoritativeObject,
        signalR: { HubConnectionState: { Connected: 'Connected', Reconnecting: 'Reconnecting' } },
        window: { ASTERVOIDS_DEBUG: false },
        console
    };
    const src = readFileSync(resolve(__dirname, 'wwwroot/js/object-sync.js'), 'utf8');
    const moduleHost = { exports: {} };
    const fn = new Function(...Object.keys(globals), 'module', src + '\nmodule.exports = ObjectSync;');
    fn(...Object.values(globals), moduleHost);
    return moduleHost.exports;
}

function makeSessionClientStub() {
    const handlers = {};
    const sent = [];
    const replacements = [];
    return {
        sentEvents: sent,
        replacementRequests: replacements,
        handlers,
        on: (event, cb) => { handlers[event] = cb; },
        broadcastObjectEvent: async (objectId, eventKind, payload, validAt) => {
            sent.push({ objectId, eventKind, payload, validAt });
            return true;
        },
        replaceObject: async (
            deleteObjectId,
            replacementData,
            scope,
            ownerMemberId,
            clientValidAt,
            schemaIds
        ) => {
            replacements.push({
                deleteObjectId,
                replacementData,
                scope,
                ownerMemberId,
                clientValidAt,
                schemaIds
            });
            return [];
        },
        getCurrentMember: () => ({ id: 'member-1' }),
        isInSession: () => true
    };
}

test('registerEventKind: maps name ↔ byte both directions', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    ObjectSync.registerEventKind('foo', 7);
    // No throw on identical re-registration (idempotent)
    ObjectSync.registerEventKind('foo', 7);
});

test('registerEventKind: throws on byte conflict', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    ObjectSync.registerEventKind('foo', 7);
    assert.throws(() => ObjectSync.registerEventKind('bar', 7), /already mapped/);
});

test('registerEventKind: throws on name conflict', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    ObjectSync.registerEventKind('foo', 7);
    assert.throws(() => ObjectSync.registerEventKind('foo', 8), /already mapped/);
});

test('registerEventKind: rejects non-string name', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    assert.throws(() => ObjectSync.registerEventKind('', 1), /non-empty string/);
    assert.throws(() => ObjectSync.registerEventKind(123, 1), /non-empty string/);
});

test('registerEventKind: rejects out-of-range byte', () => {
    const ObjectSync = loadObjectSync({ SessionClient: makeSessionClientStub() });
    assert.throws(() => ObjectSync.registerEventKind('foo', -1), /\[0, 255\]/);
    assert.throws(() => ObjectSync.registerEventKind('foo', 256), /\[0, 255\]/);
    assert.throws(() => ObjectSync.registerEventKind('foo', 1.5), /\[0, 255\]/);
});

test('emitEvent: invokes local handler synchronously then sends', async () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    const received = [];
    ObjectSync.registerEventKind('ship-state-changed', 1);
    ObjectSync.on('objectEvent:ship-state-changed', (objectId, payload, ctx) => {
        received.push({ objectId, payload, local: ctx.local });
    });

    await ObjectSync.emitEvent('obj-1', 'ship-state-changed', { score: 100 });

    assert.equal(received.length, 1, 'local handler ran exactly once');
    assert.equal(received[0].objectId, 'obj-1');
    assert.deepEqual(received[0].payload, { score: 100 });
    assert.equal(received[0].local, true);
    assert.equal(stub.sentEvents.length, 1, 'sent over wire');
    assert.equal(stub.sentEvents[0].eventKind, 1);
    assert.ok(stub.sentEvents[0].payload instanceof Uint8Array);
    assert.deepEqual(MsgpackCodec.decode(stub.sentEvents[0].payload), { score: 100 });
});

test('emitEvent: validAt requires an initialized finite clock and is rounded', async () => {
    const uninitializedStub = makeSessionClientStub();
    const uninitialized = loadObjectSync({ SessionClient: uninitializedStub });
    let reads = 0;
    uninitialized.configure({
        clockSource: {
            initialized: () => false,
            nowMs: () => { reads++; return 1234.6; }
        }
    });
    uninitialized.registerEventKind('event', 1);
    await uninitialized.emitEvent('obj-1', 'event', {});
    assert.equal(uninitializedStub.sentEvents[0].validAt, null);
    assert.equal(reads, 0);

    const initializedStub = makeSessionClientStub();
    const initialized = loadObjectSync({ SessionClient: initializedStub });
    initialized.configure({
        clockSource: {
            initialized: () => true,
            nowMs: () => 1234.6
        }
    });
    initialized.registerEventKind('event', 1);
    await initialized.emitEvent('obj-1', 'event', {});
    assert.equal(initializedStub.sentEvents[0].validAt, 1235);
});

test('replaceObject selects each schema once and keeps payload paired with its id', async () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.configure({ fieldMap: { angle: 'a' } });
    let selections = 0;
    ObjectSync.setSchemaIdSelector(() => ++selections === 1 ? 7 : 0);

    await ObjectSync.replaceObject('parent', [{ angle: 1 }, { angle: 2 }]);

    assert.equal(selections, 2);
    assert.equal(stub.replacementRequests.length, 1);
    assert.deepEqual(stub.replacementRequests[0].schemaIds, [7, 0]);
    assert.deepEqual(stub.replacementRequests[0].replacementData, [
        { angle: 1 },
        { a: 2 }
    ]);
});

test('emitEvent: silent no-op when kind unregistered', async () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    const result = await ObjectSync.emitEvent('obj-1', 'never-registered', { x: 1 });
    assert.equal(result, false);
    assert.equal(stub.sentEvents.length, 0);
});

test('dispatch: SessionClient onObjectEvent → registered handler invoked', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();

    const received = [];
    ObjectSync.registerEventKind('ship-state-changed', 1);
    ObjectSync.on('objectEvent:ship-state-changed', (objectId, payload, ctx) => {
        received.push({ objectId, payload, ctx });
    });

    // Simulate hub broadcast arrival.
    const onObjectEvent = stub.handlers['onObjectEvent'];
    assert.ok(onObjectEvent, 'object-sync registered onObjectEvent handler');
    onObjectEvent(
        { objectId: 'obj-1', eventKind: 1, payload: { score: 50 } },
        'sender-123',
        42,
        1700000000000
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].objectId, 'obj-1');
    assert.deepEqual(received[0].payload, { score: 50 });
    assert.equal(received[0].ctx.local, false);
    assert.equal(received[0].ctx.senderMemberId, 'sender-123');
    assert.equal(received[0].ctx.memberSequence, 42);
    assert.equal(received[0].ctx.validAt, 1700000000000);
});

test('dispatch: unknown kind byte → silent (warn only)', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();

    const onObjectEvent = stub.handlers['onObjectEvent'];
    // Should not throw even though kind 99 is unregistered.
    onObjectEvent({ objectId: 'obj-1', eventKind: 99, payload: {} }, 's', 1, null);
});

test('event payload field aliases round-trip through opaque bytes', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();
    ObjectSync.configure({ fieldMap: { score: 'sc', hitCount: 'hc' } });
    ObjectSync.registerEventKind('ship-state-changed', 1);

    let received = null;
    ObjectSync.on('objectEvent:ship-state-changed', (_id, payload) => {
        received = payload;
    });
    stub.handlers.onObjectEvent({
        objectId: 'obj-1',
        eventKind: 1,
        payload: MsgpackCodec.encode({ sc: 100, hc: 2 })
    }, 'sender', 1, null);

    assert.deepEqual(received, { score: 100, hitCount: 2 });
});

test('dispatch: handler throw is caught (does not propagate)', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();

    ObjectSync.registerEventKind('boom', 5);
    ObjectSync.on('objectEvent:boom', () => { throw new Error('handler bug'); });

    const onObjectEvent = stub.handlers['onObjectEvent'];
    // Should not throw upward.
    onObjectEvent({ objectId: 'obj-1', eventKind: 5, payload: {} }, 's', 1, null);
});

test('dispatch: malformed opaque payload is contained', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();
    ObjectSync.registerEventKind('bad-payload', 6);
    let calls = 0;
    ObjectSync.on('objectEvent:bad-payload', () => { calls++; });

    const onObjectEvent = stub.handlers.onObjectEvent;
    assert.doesNotThrow(() => onObjectEvent({
        objectId: 'obj-1',
        eventKind: 6,
        payload: new Uint8Array([0xc1])
    }, 's', 1, null));
    assert.equal(calls, 0);
});

test('on(objectEvent:KIND, null): unregisters handler', () => {
    const stub = makeSessionClientStub();
    const ObjectSync = loadObjectSync({ SessionClient: stub });
    ObjectSync.init();
    ObjectSync.registerEventKind('foo', 1);

    let calls = 0;
    ObjectSync.on('objectEvent:foo', () => { calls++; });
    ObjectSync.on('objectEvent:foo', null);

    const onObjectEvent = stub.handlers['onObjectEvent'];
    onObjectEvent({ objectId: 'obj-1', eventKind: 1, payload: {} }, 's', 1, null);
    assert.equal(calls, 0);
});
