import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadClassicModule } from './classic-module.mjs';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('../wwwroot/js/authoritative-object.js');
const MsgpackCodec = require('../wwwroot/js/msgpack-codec.js');
const SchemaCodec = require('../wwwroot/js/schema-codec.js');
const WireSchemas = require('../wwwroot/js/game-wire-schemas.js');

// The actual ObjectSync owns optimistic writes, byte snapshots, queues and
// acknowledgements. Only the hub boundary is controlled by this fixture.
export function attachGameplaySync(harness, memberId) {
    const callbacks = new Map();
    const calls = [];
    const transport = { acknowledge: true, replacementGate: null, sequence: 0 };
    const server = new Map();
    const roundTrip = (schemaId, data) => schemaId === 0
        ? MsgpackCodec.decode(MsgpackCodec.encode(data))
        : SchemaCodec.decode(SchemaCodec.get(schemaId), SchemaCodec.encode(SchemaCodec.get(schemaId), data));
    const info = (data, scope, owner, schemaId) => ({
        id: randomUUID(), creatorMemberId: memberId, ownerMemberId: owner || memberId,
        scope, schemaId, version: 1, data: roundTrip(schemaId, data),
    });
    const client = {
        ...harness.sessionClient,
        on: (name, callback) => callbacks.set(name, callback),
        isInSession: () => true,
        async createObject(data, scope, owner, validAt, schemaId) {
            const objectInfo = info(data, scope, owner, schemaId);
            server.set(objectInfo.id, structuredClone(objectInfo));
            calls.push({ method: 'create', data, scope, owner, schemaId });
            return { objectInfo, validAt: validAt ?? harness.clock.server, memberSequence: ++transport.sequence };
        },
        async updateObjects(updates) {
            calls.push({ method: 'update', updates: structuredClone(updates) });
            const versions = {};
            if (transport.acknowledge) {
                for (const update of updates) {
                    const object = server.get(update.objectId);
                    if (!object) continue;
                    Object.assign(object.data, roundTrip(update.schemaId, update.data));
                    versions[object.id] = ++object.version;
                }
            }
            return { versions, memberSequence: ++transport.sequence };
        },
        async replaceObject(parentId, replacements, scope, owner, validAt, schemaIds, accepted) {
            calls.push({ method: 'replace', parentId, replacements: structuredClone(replacements), scope, owner, schemaIds });
            if (transport.replacementGate) await transport.replacementGate;
            if (!server.has(parentId)) return null;
            server.delete(parentId);
            const createdObjects = replacements.map((data, index) => info(data, scope, owner, schemaIds[index]));
            for (const object of createdObjects) server.set(object.id, structuredClone(object));
            accepted({ deletedObjectId: parentId, createdObjects }, memberId,
                ++transport.sequence, validAt ?? harness.clock.server);
            return createdObjects;
        },
        async deleteObject(objectId) {
            server.delete(objectId);
            return { success: true, memberSequence: ++transport.sequence };
        },
        async getSessionState() {
            const objects = [...server.values()].map(object => structuredClone(object));
            return {
                objects, memberSequences: {},
                validAts: Object.fromEntries(objects.map(object => [object.id, harness.clock.server])),
            };
        },
    };
    const sync = loadClassicModule('object-sync.js', 'ObjectSync', {
        SessionClient: client, AuthoritativeObject, MsgpackCodec,
        window: { ASTERVOIDS_DEBUG: false, SchemaCodec },
    });
    sync.init();
    sync.configure({
        deltaEncoding: true,
        clockSource: { initialized: () => true, nowMs: () => harness.clock.server },
    });
    sync.setSchemaIdSelector(WireSchemas.selectSchemaId);
    Object.assign(harness.objectSync, sync);
    return {
        sync, calls, transport, server, client,
        seed(objects) {
            for (const object of objects) server.set(object.id, structuredClone(object));
            callbacks.get('onSessionJoined')({
                objects, metadata: { schemas: WireSchemas.SCHEMAS },
                validAts: Object.fromEntries(objects.map(object => [object.id, object.validAt ?? harness.clock.server])),
            });
        },
    };
}
