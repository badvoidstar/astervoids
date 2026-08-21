// Phase 4 cross-wire fixtures (JS side). Decode hex strings produced by C#
// PositionalSchemaCodec and assert the JS SchemaCodec returns the same dicts.
// If either codec changes, both sides fail loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');

function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error(`odd hex length: ${hex.length}`);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function freshRegistry() {
    SchemaCodec.clear();
}

const SHIP_SCHEMA_FIELDS = [
    ['type', 'str'],
    ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
    ['velocityX', 'f32'], ['velocityY', 'f32'], ['rotationSpeed', 'q16s'],
    ['thrusting', 'bool'], ['invulnerable', 'u16'],
    ['colorIndex', 'u8'], ['memberId', 'guid'],
    ['score', 'u32'], ['hitCount', 'u16'],
    ['thrustInput', 'f32'], ['brakeInput', 'q8'],
    ['turnControlMode', 'u8'], ['turnTarget', 'q16s'],
    ['turnTargetAngle', 'q16_2pi'], ['turnMagnitude', 'q8'], ['turnBias', 'q16s'],
    ['terminalEpoch', 'f64'], ['terminalX', 'f64'],
    ['terminalY', 'f64'], ['terminalAngle', 'f64'],
];
const ASTEROID_SCHEMA_FIELDS = [
    ['type', 'str'],
    ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'], ['radius', 'q16'],
    ['velocityX', 'f32'], ['velocityY', 'f32'], ['rotationSpeed', 'f32'],
    ['seed', 'f64'], ['vertices', 'bytes'],
    ['terminalEpoch', 'f64'], ['terminalX', 'f64'],
    ['terminalY', 'f64'], ['terminalAngle', 'f64'],
];
const BULLET_SCHEMA_FIELDS = [
    ['type', 'str'],
    ['x', 'q16w'], ['y', 'q16w'],
    ['velocityX', 'q16s'], ['velocityY', 'q16s'],
    ['lifetime', 'u16'], ['colorIndex', 'u8'], ['ownerMemberId', 'guid'],
    ['pendingHit', 'bool'], ['hitTargetId', 'nullable-guid'],
    ['hitImpactTorque', 'q16s'], ['hitBulletAngle', 'q16_2pi'],
    ['hitOffsetN', 'q16s'], ['terminalEpoch', 'f64'],
    ['terminalX', 'f64'], ['terminalY', 'f64'],
];

test('cross-wire: asteroid update — all fields', () => {
    freshRegistry();
    const schema = SchemaCodec.register(2, ASTEROID_SCHEMA_FIELDS);
    const bytes = hexToBytes('0e00' + '0080' + '0060' + '0040');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.ok(Math.abs(decoded.x - 0.5) < 0.00002);
    assert.ok(Math.abs(decoded.y - 0.25) < 0.00002);
    assert.equal(decoded.angle, Math.PI / 2);
});

test('cross-wire: asteroid update — only angle bit set', () => {
    freshRegistry();
    const schema = SchemaCodec.register(2, ASTEROID_SCHEMA_FIELDS);
    const bytes = hexToBytes('0800' + '0000');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal('x' in decoded, false);
    assert.equal('y' in decoded, false);
    assert.equal(decoded.angle, 0.0);
});

test('cross-wire: ship update — mixed types', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, SHIP_SCHEMA_FIELDS);
    const bytes = hexToBytes(
        'fe0100' +
        '0080' +
        '0080' +
        '00000000' +
        '00000000' +
        '0000' +
        '0000' +
        '00' +
        '7800'
    );
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.ok(Math.abs(decoded.x - 0.5) < 0.00002);
    assert.ok(Math.abs(decoded.y - 0.5) < 0.00002);
    assert.equal(decoded.angle, 0);
    assert.equal(decoded.velocityX, 0);
    assert.equal(decoded.velocityY, 0);
    assert.equal(decoded.rotationSpeed, 0);
    assert.equal(decoded.thrusting, false);
    assert.equal(decoded.invulnerable, 120);
});

test('cross-wire: ship update — values beyond the unit interval', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, SHIP_SCHEMA_FIELDS);
    const bytes = hexToBytes('102000' + '0000c03f' + '0000c03f');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.velocityX, 1.5);
    assert.equal(decoded.thrustInput, 1.5);
});

test('cross-wire: bullet update — guid field', () => {
    freshRegistry();
    const schema = SchemaCodec.register(3, BULLET_SCHEMA_FIELDS);
    const bytes = hexToBytes(
        '8600' +
        '0080' +
        '0080' +
        '443322116655887799aabbccddeeff00'
    );
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.ok(Math.abs(decoded.x - 0.5) < 0.00002);
    assert.ok(Math.abs(decoded.y - 0.5) < 0.00002);
    assert.equal(decoded.ownerMemberId.toLowerCase(), '11223344-5566-7788-99aa-bbccddeeff00');
});

test('cross-wire: string field with utf8 length prefix', () => {
    freshRegistry();
    const schema = SchemaCodec.register(7, [['name', 'str']]);
    const bytes = hexToBytes('01' + '0400' + '73686970');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.name, 'ship');
});

test('cross-wire: nullable-guid null case is single zero byte', () => {
    freshRegistry();
    const schema = SchemaCodec.register(8, [['hitTargetId', 'nullable-guid']]);
    const bytes = hexToBytes('01' + '00');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.hitTargetId, null);
});

test('cross-wire: bytes field length is u32 little-endian', () => {
    freshRegistry();
    const schema = SchemaCodec.register(9, [['vertices', 'bytes']]);
    const bytes = hexToBytes('01' + '04000000' + 'deadbeef');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.vertices.length, 4);
    assert.equal(decoded.vertices[0], 0xde);
    assert.equal(decoded.vertices[1], 0xad);
    assert.equal(decoded.vertices[2], 0xbe);
    assert.equal(decoded.vertices[3], 0xef);
});

test('cross-wire: JS encode → C# hex round-trip (asteroid update)', () => {
    freshRegistry();
    const schema = SchemaCodec.register(2, ASTEROID_SCHEMA_FIELDS);
    const bytes = SchemaCodec.encode(schema, { x: 0.5, y: 0.25, angle: Math.PI / 2 });
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(hex,
        '0e00' +
        '0080' +
        '0060' +
        '0040'
    );
});

test('cross-wire (Phase 5): quantized asteroid update produces canonical hex', () => {
    freshRegistry();
    const schema = SchemaCodec.register(2, ASTEROID_SCHEMA_FIELDS);
    const bytes = SchemaCodec.encode(schema, { x: 0.5, y: 0.25, angle: Math.PI });
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    assert.equal(hex, '0E00008000600080');
});

// PR #96 review fix #4 cross-wire parity.
// PositionalSchemaCodecTests.Encode_NullValueOnNonNullableSlot_TreatedAsAbsent
// asserts the C# encoder produces the same bytes for the same dict. This
// test pins the JS encoder to the same canonical hex so the two codecs
// stay byte-identical on the `null` boundary.
test('cross-wire: null on non-nullable f64 slot is absent (matches C# bytes)', () => {
    freshRegistry();
    const schema = SchemaCodec.register(11, [['x', 'f64'], ['y', 'f64']]);
    const bytes = SchemaCodec.encode(schema, { x: 1.0, y: null });
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    // bitmask=0x01 (only x) + x=1.0 (IEEE-754 LE: 0x000000000000F03F)
    assert.equal(hex, '01' + '000000000000f03f');
});

// Cross-wire parity for the unified production ship schema. The matching C#
// test is SyncPayloadCodecRegistryTests.EncodeDict_RegisteredPositionalSchema_
// EmitsPositionalBytes (which compares to a direct PositionalSchemaCodec.Encode
// call). Pinning the JS-side byte length here ensures the two implementations
// stay aligned at every byte even when a future field-set tweak lands. If
// either side drifts, both this test and its C# counterpart fire.
test('cross-wire: unified ship create encoding length is byte-stable', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, SHIP_SCHEMA_FIELDS);
    const bytes = SchemaCodec.encode(schema, { type: 'ship', x: 0.5, y: 0.25 });
    assert.equal(bytes.length, 3 + 2 + 4 + 2 + 2);
    assert.equal(bytes[0], 0x07);
    assert.equal(bytes[1], 0x00);
    assert.equal(bytes[2], 0x00);
    assert.equal(bytes[3], 0x04);
    assert.equal(bytes[4], 0x00);
    assert.equal(String.fromCharCode(bytes[5], bytes[6], bytes[7], bytes[8]), 'ship');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.type, 'ship');
    assert.ok(Math.abs(decoded.x - 0.5) < 0.00002);
    assert.ok(Math.abs(decoded.y - 0.25) < 0.00002);
});

test('cross-wire: persisted ship terminal target uses exact f64 fields', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, SHIP_SCHEMA_FIELDS);
    const bytes = SchemaCodec.encode(schema, {
        terminalEpoch: 1000,
        terminalX: 0.25,
        terminalY: 0.75,
        terminalAngle: Math.PI,
    });
    const hex = Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0')).join('');
    assert.equal(
        hex,
        '0000f0'
        + '0000000000408f40'
        + '000000000000d03f'
        + '000000000000e83f'
        + '182d4454fb210940');
});
