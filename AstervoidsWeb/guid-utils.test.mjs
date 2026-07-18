/**
 * Tests for the JS-side binary-GUID transform (guid-utils.js).
 *
 * Regression coverage for the "16-byte SyncPayload data misread as a GUID" bug:
 * a per-object SyncPayload envelope is [schemaId:number, data:byte[]]. When the
 * opaque `data` byte[] happens to encode to exactly 16 bytes (e.g. a delta of
 * { y, lifetime } for a bullet fired perfectly straight, where x is unchanged),
 * the generic binary-GUID transform at the receive boundary used to convert it
 * into a GUID string, corrupting the payload before SyncPayload.unwrap could
 * decode it. Downstream that froze the object's authoritative base, producing a
 * sawtooth on remotes. transformBinaryGuids must leave SyncPayload envelopes
 * untouched.
 *
 * Run with: node --test AstervoidsWeb/guid-utils.test.mjs
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
globalThis.MsgpackCodec = MsgpackCodec;
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
globalThis.SchemaCodec = SchemaCodec;
const SyncPayload = require('./wwwroot/js/sync-payload.js');

test('bytesToGuid converts a 16-byte .NET binary guid to a string', () => {
    const bytes = new Uint8Array([
        0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const guid = GuidUtils.bytesToGuid(bytes);
    // .NET mixed-endian: first three groups are little-endian.
    assert.equal(guid, '76543210-ba98-fedc-0123-456789abcdef');
});

test('guidToBytes and bytesToGuid share the .NET mixed-endian layout', () => {
    const guid = '76543210-ba98-fedc-0123-456789abcdef';
    const bytes = GuidUtils.guidToBytes(guid);

    assert.deepEqual(Array.from(bytes), [
        0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef
    ]);
    assert.equal(GuidUtils.bytesToGuid(bytes), guid);
});

test('bytesToGuid supports an offset within a larger payload', () => {
    const guid = '00112233-4455-6677-8899-aabbccddeeff';
    const bytes = new Uint8Array(20);
    bytes.set(GuidUtils.guidToBytes(guid), 2);

    assert.equal(GuidUtils.bytesToGuid(bytes, 2), guid);
    assert.equal(GuidUtils.bytesToGuid(bytes, 5), null);
});

test('guidToBytes rejects non-canonical GUID strings', () => {
    assert.throws(() => GuidUtils.guidToBytes('00112233445566778899aabbccddeeff'), /Invalid GUID/);
    assert.throws(() => GuidUtils.guidToBytes('not-a-guid'), /Invalid GUID/);
});

test('a delta of { y, lifetime } encodes to exactly 16 bytes (collision shape)', () => {
    // This is the exact shape that triggered the original bug: a straight-up
    // bullet's per-frame delta omits x (unchanged) and carries only y + lifetime.
    const delta = { y: 0.39166666666666666, lt: 55 };
    const bytes = MsgpackCodec.encode(delta);
    assert.equal(bytes.length, 16, 'collision precondition: delta must be 16 bytes');
});

test('transformBinaryGuids does NOT corrupt a 16-byte SyncPayload envelope', () => {
    const delta = { y: 0.39166666666666666, lt: 55 };
    const envelope = SyncPayload.wrap(delta, 0); // [0, Uint8Array(16)]
    assert.equal(envelope[1].length, 16);

    // Receive boundary applies the generic guid transform to whole arg trees.
    const transformed = GuidUtils.transformBinaryGuids(envelope);

    // The data slot must survive as raw bytes (not be turned into a GUID string).
    assert.ok(transformed[1] instanceof Uint8Array, 'data slot must remain Uint8Array');
    assert.deepEqual(SyncPayload.unwrap(transformed), delta);
});

test('full receive path: array of update infos with 16-byte deltas round-trips', () => {
    // Mirrors session-client.js OnObjectsUpdated: an array of { id, data, version }
    // where each data is a SyncPayload envelope. The guard wrapper runs
    // transformBinaryGuids over the whole array before unwrapping each data.
    const updates = [
        { id: 'bullet-1', data: SyncPayload.wrap({ y: 0.39166666666666666, lt: 55 }, 0), version: 3 },
        { id: 'bullet-2', data: SyncPayload.wrap({ y: 0.10833333333333334, lt: 38 }, 0), version: 9 },
    ];
    GuidUtils.transformBinaryGuids(updates);
    for (const u of updates) {
        const dict = SyncPayload.unwrap(u.data);
        assert.equal(typeof dict, 'object');
        assert.equal(typeof dict.y, 'number', 'y must survive the receive boundary');
        assert.equal(typeof dict.lt, 'number', 'lifetime must survive the receive boundary');
    }
});

test('real binary guids inside other wire shapes are still converted', () => {
    // Member-sequence pairs arrive as [guidBytes, long] = [Uint8Array(16), number].
    // The fix only exempts the [number, Uint8Array] envelope shape, so the guid in
    // this [Uint8Array, number] pair must still be transformed to a string.
    const guidBytes = new Uint8Array([
        0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const pair = [guidBytes, 42];
    GuidUtils.transformBinaryGuids(pair);
    assert.equal(pair[0], '76543210-ba98-fedc-0123-456789abcdef');
    assert.equal(pair[1], 42);
});

test('a standalone 16-byte guid (not in an envelope) is still converted', () => {
    const guidBytes = new Uint8Array([
        0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const obj = { memberId: guidBytes, score: 7 };
    GuidUtils.transformBinaryGuids(obj);
    assert.equal(obj.memberId, '76543210-ba98-fedc-0123-456789abcdef');
    assert.equal(obj.score, 7);
});

test('a 3-element array starting with a number is not mistaken for an envelope', () => {
    // Only length-2 [number, Uint8Array] is the SyncPayload envelope. A longer
    // array that merely starts with a number must still have its guids converted.
    const guidBytes = new Uint8Array([
        0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const arr = [5, guidBytes, 'tail'];
    GuidUtils.transformBinaryGuids(arr);
    assert.equal(arr[0], 5);
    assert.equal(arr[1], '76543210-ba98-fedc-0123-456789abcdef');
    assert.equal(arr[2], 'tail');
});
