// Phase 4 cross-wire fixtures (JS side). Decode hex strings produced by C#
// PositionalSchemaCodec and assert the JS SchemaCodec returns the same dicts.
// If either codec changes, both sides fail loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    SHIP_SCHEMA_FIELDS, ASTEROID_SCHEMA_FIELDS, BULLET_SCHEMA_FIELDS,
    GAME_STATE_SCHEMA_FIELDS, GAME_EFFECT_SCHEMA_FIELDS, GAME_CLAIM_SCHEMA_FIELDS,
    LARGE_XP_ENTRY_HEX, LARGE_XP_STATE_HEX,
} from './test-support/game-schema-fixture.mjs';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const { SCHEMAS } = require('./wwwroot/js/game-wire-schemas.js');

function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error(`odd hex length: ${hex.length}`);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function freshRegistry() {
    SchemaCodec.clear();
}

test('cross-wire: durable participant identity and tags retain sparse positional masks', () => {
    const ship = SchemaCodec.normalizeSchema(1, SHIP_SCHEMA_FIELDS);
    const gameState = SchemaCodec.normalizeSchema(4, GAME_STATE_SCHEMA_FIELDS);
    const identity = { participantId: '00112233-4455-6677-8899-aabbccddeeff', participantTag: 'Pilot_1' };
    const shipBytes = hexToBytes('0000000c33221100554477668899aabbccddeeff070050696c6f745f31');
    assert.deepEqual(SchemaCodec.decode(ship, shipBytes), identity);
    assert.deepEqual(SchemaCodec.encode(ship, identity), shipBytes);
    const tags = hexToBytes('33221100554477668899aabbccddeeff0750696c6f745f31');
    const stateBytes = hexToBytes('0000041800000033221100554477668899aabbccddeeff0750696c6f745f31');
    assert.deepEqual(SchemaCodec.decode(gameState, stateBytes), { participantTags: tags });
    assert.deepEqual(SchemaCodec.encode(gameState, { participantTags: tags }), stateBytes);
});

test('cross-wire fixtures match every production positional field', () => {
    for (const [id, fields] of [
        [1, SHIP_SCHEMA_FIELDS], [2, ASTEROID_SCHEMA_FIELDS], [3, BULLET_SCHEMA_FIELDS],
        [4, GAME_STATE_SCHEMA_FIELDS], [5, GAME_EFFECT_SCHEMA_FIELDS], [6, GAME_CLAIM_SCHEMA_FIELDS],
    ]) {
        assert.deepEqual(fields, SCHEMAS.find(schema => schema.id === id).fields);
    }
});

test('cross-wire: asteroid update — all fields', () => {
    freshRegistry();
    const schema = SchemaCodec.register(2, ASTEROID_SCHEMA_FIELDS);
    const bytes = hexToBytes('0e0000' + '0080' + '0060' + '0040');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.ok(Math.abs(decoded.x - 0.5) < 0.00002);
    assert.ok(Math.abs(decoded.y - 0.25) < 0.00002);
    assert.equal(decoded.angle, Math.PI / 2);
});

test('cross-wire: asteroid update — only angle bit set', () => {
    freshRegistry();
    const schema = SchemaCodec.register(2, ASTEROID_SCHEMA_FIELDS);
    const bytes = hexToBytes('080000' + '0000');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal('x' in decoded, false);
    assert.equal('y' in decoded, false);
    assert.equal(decoded.angle, 0.0);
});

test('cross-wire: ship update — mixed types', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, SHIP_SCHEMA_FIELDS);
    const bytes = hexToBytes(
        'fe010000' +
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
    const bytes = hexToBytes('10200000' + '0000c03f' + '0000c03f');
    const decoded = SchemaCodec.decode(schema, bytes);
    assert.equal(decoded.velocityX, 1.5);
    assert.equal(decoded.thrustInput, 1.5);
});

test('cross-wire: bullet update — guid field', () => {
    freshRegistry();
    const schema = SchemaCodec.register(3, BULLET_SCHEMA_FIELDS);
    const bytes = hexToBytes(
        '860000' +
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
        '0e0000' +
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
    assert.equal(hex, '0E0000008000600080');
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
    assert.equal(bytes.length, 4 + 2 + 4 + 2 + 2);
    assert.equal(bytes[0], 0x07);
    assert.equal(bytes[1], 0x00);
    assert.equal(bytes[2], 0x00);
    assert.equal(bytes[3], 0x00);
    assert.equal(bytes[4], 0x04);
    assert.equal(bytes[5], 0x00);
    assert.equal(String.fromCharCode(bytes[6], bytes[7], bytes[8], bytes[9]), 'ship');
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
        '0000f000'
        + '0000000000408f40'
        + '000000000000d03f'
        + '000000000000e83f'
        + '182d4454fb210940');
});

test('cross-wire: invulnerability transition and capture time have canonical bytes', () => {
    freshRegistry();
    const schema = SchemaCodec.register(1, SHIP_SCHEMA_FIELDS);
    const data = { invulnerable: 180, invulnerabilityRevision: 7, invulnerableAt: 1000 };
    const hex = '00010003' + 'b400' + '07000000' + '0000000000408f40';
    assert.deepEqual(SchemaCodec.decode(schema, hexToBytes(hex)), data);
    assert.equal(Buffer.from(SchemaCodec.encode(schema, data)).toString('hex'), hex);
});

test('cross-wire: current GameState preserves terminal slots with a three-byte mask', () => {
    freshRegistry();
    const schema = SchemaCodec.register(4, GAME_STATE_SCHEMA_FIELDS);
    const data = {
        lives: 0, gameOverAt: 1000, terminalAt: 1750,
        terminalShipId: '00112233-4455-6677-8899-aabbccddeeff',
    };
    const hex = '109800' + '0000' + '0000000000408f40' + '0000000000589b40'
        + '33221100554477668899aabbccddeeff';
    assert.deepEqual(SchemaCodec.decode(schema, hexToBytes(hex)), data);
    assert.equal(Buffer.from(SchemaCodec.encode(schema, data)).toString('hex'), hex);
});

test('cross-wire: personal score and number maps use optional slots sixteen and seventeen', () => {
    freshRegistry();
    const schema = SchemaCodec.register(4, GAME_STATE_SCHEMA_FIELDS);
    const score = hexToBytes('33221100554477668899aabbccddeeff' + '00000000');
    const number = hexToBytes('33221100554477668899aabbccddeeff' + '01000000');
    const hex = '000003' + '14000000' + Buffer.from(score).toString('hex')
        + '14000000' + Buffer.from(number).toString('hex');
    const data = { participantScores: score, participantNumbers: number };
    assert.deepEqual(SchemaCodec.decode(schema, hexToBytes(hex)), data);
    assert.equal(Buffer.from(SchemaCodec.encode(schema, data)).toString('hex'), hex);
    assert.equal(SchemaCodec.encode(schema, { lives: 3 }).length, 5);
});

test('cross-wire: independent custom registries keep their own positional layouts', () => {
    freshRegistry();
    const counter = SchemaCodec.normalizeSchema(29, [['value', 'u32']]);
    const label = SchemaCodec.normalizeSchema(29, [['label', 'str']]);
    assert.deepEqual(SchemaCodec.decode(counter, hexToBytes('011e000000')), { value: 30 });
    assert.deepEqual(SchemaCodec.decode(label, hexToBytes('010600776964676574')), { label: 'widget' });
    assert.equal(Buffer.from(SchemaCodec.encode(counter, { value: 30 })).toString('hex'), '011e000000');
    assert.equal(Buffer.from(SchemaCodec.encode(label, { label: 'widget' })).toString('hex'), '010600776964676574');
});

test('cross-wire: progression and hazard slots retain exact sparse masks', () => {
    for (const [id, fields, data, hex] of [
        [1, SHIP_SCHEMA_FIELDS, { handledHazards: new Uint8Array() }, '0000001000000000'],
        [2, ASTEROID_SCHEMA_FIELDS,
            { maxHits: 3, hitsRemaining: 2, payloadKind: 6, processedDamage: new Uint8Array() },
            '00c00303020600000000'],
        [3, BULLET_SCHEMA_FIELDS, {
            damageId: '00112233-4455-6677-8899-aabbccddeeff',
            participantId: '11223344-5566-7788-99aa-bbccddeeff00',
            shipId: null, participantTag: 'Pilot_1',
        }, '00000f' + '33221100554477668899aabbccddeeff'
            + '443322116655887799aabbccddeeff00' + '00' + '070050696c6f745f31'],
        [4, GAME_STATE_SCHEMA_FIELDS, { participantXp: hexToBytes(LARGE_XP_ENTRY_HEX) }, LARGE_XP_STATE_HEX],
        [4, GAME_STATE_SCHEMA_FIELDS, { processedEffects: new Uint8Array() }, '00001000000000'],
    ]) {
        const schema = SchemaCodec.normalizeSchema(id, fields);
        const expected = hexToBytes(hex);
        assert.deepEqual(SchemaCodec.encode(schema, data), expected, `schema ${id} appended slots`);
        assert.deepEqual(SchemaCodec.decode(schema, expected), data, `schema ${id} snapshot`);
    }
});

test('cross-wire: effect capture deadlines and fixed target lists are snapshot-safe', () => {
    const schema = SchemaCodec.normalizeSchema(5, GAME_EFFECT_SCHEMA_FIELDS);
    const data = {
        claimId: null, participantId: null, shipId: null,
        velocityX: 0.75, velocityY: -0.5, startedAt: 1000, armedAt: 1800, expiresAt: 3000,
        damageReceipts: new Uint8Array(), asteroidTargets: new Uint8Array([1, 2]),
        hazardTargets: new Uint8Array([3]),
    };
    const hex = 'b0ec0e' + '000000' + '0000403f000000bf'
        + '0000000000408f40' + '0000000000209c40' + '000000000070a740'
        + '00000000' + '020000000102' + '0100000003';
    const expected = hexToBytes(hex);
    assert.deepEqual(SchemaCodec.encode(schema, data), expected);
    assert.deepEqual(SchemaCodec.decode(schema, expected), data);
});

test('cross-wire: claim time and ship revision remain exact and independently optional', () => {
    const schema = SchemaCodec.normalizeSchema(6, GAME_CLAIM_SCHEMA_FIELDS);
    const data = { claimedAt: 1000, invulnerabilityRevision: 0xffffffff };
    const hex = '0003' + '0000000000408f40' + 'ffffffff';
    assert.deepEqual(SchemaCodec.encode(schema, data), hexToBytes(hex));
    assert.deepEqual(SchemaCodec.decode(schema, hexToBytes(hex)), data);
});
