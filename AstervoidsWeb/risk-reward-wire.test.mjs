import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    CURRENT_GAME_SCHEMAS, SHIP_SCHEMA_FIELDS, ASTEROID_SCHEMA_FIELDS,
    BULLET_SCHEMA_FIELDS, GAME_STATE_SCHEMA_FIELDS, GAME_EFFECT_SCHEMA_FIELDS,
    GAME_CLAIM_SCHEMA_FIELDS, BOOST_STATE_HEX, MODIFIER_ENTRY_HEX, CONTRIBUTOR_ENTRY_HEX,
} from './test-support/game-schema-fixture.mjs';

const require = createRequire(import.meta.url);
const Wire = require('./wwwroot/js/astervoids-wire-codec.js');
const Schema = require('./wwwroot/js/schema-codec.js');
const Schemas = require('./wwwroot/js/game-wire-schemas.js');
const a = '00112233-4455-6677-8899-aabbccddeeff';
const b = '11223344-5566-7788-99aa-bbccddeeff00';
const c = '22334455-6677-8899-aabb-ccddeeff0011';
const d = '33445566-7788-99aa-bbcc-ddeeff001122';
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const schema = id => {
    const definition = CURRENT_GAME_SCHEMAS.find(candidate => candidate.id === id);
    return Schema.normalizeSchema(id, definition.fields);
};
const offsetCopy = value => {
    const backing = new Uint8Array(value.length + 13).fill(0xff);
    backing.set(value, 7);
    return backing.subarray(7, 7 + value.length);
};

test('risk/reward schemas exactly fill Ship slot 31 without raising the 32-field ceiling', () => {
    assert.deepEqual(Schemas.SCHEMAS, CURRENT_GAME_SCHEMAS);
    assert.deepEqual(CURRENT_GAME_SCHEMAS.map(definition =>
        [definition.fields.length, Schema.normalizeSchema(definition.id, definition.fields).bitmaskBytes]),
    [[32, 4], [19, 3], [22, 3], [22, 3], [22, 3], [11, 2]]);
    assert.throws(() => Schema.normalizeSchema(1, [...SHIP_SCHEMA_FIELDS, ['overflow', 'u8']]));
    const predecessorCounts = [29, 18, 20, 21, 20, 10];
    for (let index = 0; index < predecessorCounts.length; index++) {
        const predecessor = Schemas.SCHEMAS.map((definition, position) => position === index
            ? { ...definition, fields: definition.fields.slice(0, predecessorCounts[index]) }
            : definition);
        assert.throws(() => Schemas.requireCurrentSchemas({ schemas: predecessor }),
            /Unsupported Astervoids session schemas/, `schema ${index + 1} cannot silently omit mandatory metadata`);
    }
});

test('Ship high-bit-only choice update has the exact C# five-byte representation', () => {
    const s = schema(1);
    const payload = { modifierRequestKind: 2 };
    assert.equal(hex(Schema.encode(s, payload)), '0000008002');
    assert.deepEqual(Schema.decode(s, bytes('0000008002')), payload);
    const combined = {
        boostState: bytes(BOOST_STATE_HEX), modifierRequestMilestone: 8, modifierRequestKind: 2,
    };
    const golden = '000000e020000000' + BOOST_STATE_HEX + '0800000002';
    assert.equal(hex(Schema.encode(s, combined)), golden);
    assert.deepEqual(Schema.decode(s, bytes(golden)), combined);
    assert.equal(Schema.encode(s, { x: 0.5 }).length, 6, 'new slots do not inflate ordinary motion');
});

test('all appended risk/reward fields have independent C# sparse-mask golden bytes', () => {
    const contributor = bytes(CONTRIBUTOR_ENTRY_HEX);
    for (const [id, fields, payload, golden] of [
        [2, ASTEROID_SCHEMA_FIELDS, { contributors: contributor },
            '00000414000000' + CONTRIBUTOR_ENTRY_HEX],
        [4, GAME_STATE_SCHEMA_FIELDS, { participantModifiers: bytes(MODIFIER_ENTRY_HEX) },
            '00002015000000' + MODIFIER_ENTRY_HEX],
        [5, GAME_EFFECT_SCHEMA_FIELDS, { contributors: contributor, shipLifeId: a },
            '00003014000000' + CONTRIBUTOR_ENTRY_HEX + '01' + '33221100554477668899aabbccddeeff'],
        [6, GAME_CLAIM_SCHEMA_FIELDS, { shipLifeId: a },
            '0004' + '33221100554477668899aabbccddeeff'],
    ]) {
        const s = Schema.normalizeSchema(id, fields);
        assert.equal(hex(Schema.encode(s, payload)), golden, `schema ${id} encoder`);
        assert.deepEqual(Schema.decode(s, bytes(golden)), payload, `schema ${id} snapshot decoder`);
    }
    const nullLife = { contributors: new Uint8Array(), shipLifeId: null };
    const effect = Schema.normalizeSchema(5, GAME_EFFECT_SCHEMA_FIELDS);
    assert.equal(hex(Schema.encode(effect, nullLife)), '0000300000000000');
    assert.deepEqual(Schema.decode(effect, Schema.encode(effect, nullLife)), nullLife);
});

test('full bullet velocity preserves axial FOCUS speed beyond legacy q16s in both axes', () => {
    const s = Schema.normalizeSchema(3, BULLET_SCHEMA_FIELDS);
    for (const [x, y, body] of [
        [1.15, 0, '3333933f00000000'], [0, -1.15, '00000000333393bf'],
    ]) {
        const payload = { velocityXFull: x, velocityYFull: y };
        const encoded = Schema.encode(s, payload);
        assert.equal(hex(encoded), '000030' + body);
        const recovered = Schema.decode(s, encoded);
        assert.ok(Math.abs(recovered.velocityXFull - x) < 1e-6);
        assert.ok(Math.abs(recovered.velocityYFull - y) < 1e-6);
        assert.deepEqual(Schema.encode(s, recovered), encoded);
        const legacy = Schema.decode(s, Schema.encode(s, { velocityX: x, velocityY: y }));
        assert.ok(Math.abs(x) <= 1 || Math.abs(legacy.velocityX) < Math.abs(x),
            'the fixture really exercises the legacy clamp, not a representable diagonal');
        assert.ok(Math.abs(y) <= 1 || Math.abs(legacy.velocityY) < Math.abs(y));
    }
});

test('boost state is an exact little-endian GUID and two f64 deadlines, including offset views', () => {
    const state = Object.freeze({ lifeId: a.toUpperCase(), shieldUntil: 1000, rapidFireUntil: 3000 });
    const encoded = Wire.packBoostState(state);
    assert.equal(encoded.length, 32);
    assert.equal(hex(encoded), BOOST_STATE_HEX);
    assert.deepEqual(Wire.unpackBoostState(offsetCopy(encoded)),
        { lifeId: a, shieldUntil: 1000, rapidFireUntil: 3000 });
    for (const deadline of [0, 0.125, 1_800_000_000_123.5]) {
        const value = { lifeId: b, shieldUntil: deadline, rapidFireUntil: deadline };
        assert.deepEqual(Wire.unpackBoostState(Wire.packBoostState(value)), value);
    }
    const decoded = Wire.unpackBoostState(encoded);
    decoded.shieldUntil = 0;
    assert.equal(hex(encoded), BOOST_STATE_HEX, 'readers never lend a mutable backing state');
});

test('boost packing rejects malformed life IDs, containers and deadlines without success defaults', () => {
    for (const invalid of [null, undefined, [], new Map(), new Set(), new Date(), new Uint8Array(), 1, 'state']) {
        assert.throws(() => Wire.packBoostState(invalid));
    }
    for (const lifeId of [null, undefined, '', 'bad', a.replaceAll('-', ''), `${a} `]) {
        assert.throws(() => Wire.packBoostState({ lifeId, shieldUntil: 0, rapidFireUntil: 0 }));
    }
    for (const deadline of [-1, NaN, Infinity, -Infinity, '1000', undefined, null, 1n]) {
        for (const field of ['shieldUntil', 'rapidFireUntil']) {
            assert.throws(() => Wire.packBoostState({
                lifeId: a, shieldUntil: 0, rapidFireUntil: 0, [field]: deadline,
            }), `${field}: ${String(deadline)}`);
        }
    }
    for (const value of [null, undefined, [], {}, new Uint8Array(), new Uint8Array(31), new Uint8Array(33)]) {
        assert.throws(() => Wire.unpackBoostState(value));
    }
    for (const offset of [16, 24]) for (const deadline of [-1, NaN, Infinity, -Infinity]) {
        const corrupted = bytes(BOOST_STATE_HEX);
        new DataView(corrupted.buffer).setFloat64(offset, deadline, true);
        assert.throws(() => Wire.unpackBoostState(offsetCopy(corrupted)));
    }
});

test('participant choices sort and normalize identities in fixed twenty-one-byte entries', () => {
    const input = Object.freeze({
        [b.toUpperCase()]: Object.freeze({ consumedMilestone: 4, modifierKind: 1 }),
        [a]: Object.freeze({ consumedMilestone: 8, modifierKind: 2 }),
    });
    const encoded = Wire.packParticipantModifiers(input);
    assert.equal(encoded.length, 42);
    assert.equal(hex(encoded.subarray(0, 21)), MODIFIER_ENTRY_HEX);
    assert.deepEqual(Wire.unpackParticipantModifiers(offsetCopy(encoded)), {
        [a]: { consumedMilestone: 8, modifierKind: 2 },
        [b]: { consumedMilestone: 4, modifierKind: 1 },
    });
    assert.deepEqual(Wire.unpackParticipantModifiers(Wire.packParticipantModifiers({})), {});
    assert.deepEqual(Wire.packParticipantModifiers(Object.create(null)), new Uint8Array());
    assert.deepEqual(Wire.unpackParticipantModifiers(Wire.packParticipantModifiers({
        [a]: { consumedMilestone: 0xfffffffc, modifierKind: 1 },
    })), { [a]: { consumedMilestone: 0xfffffffc, modifierKind: 1 } });
});

test('choice packing rejects invalid milestone/kind/identity maps and duplicate normalized identities', () => {
    const valid = { consumedMilestone: 4, modifierKind: 1 };
    for (const invalid of [null, undefined, [], new Map(), new Set(), new Date(), new Uint8Array(), 1]) {
        assert.throws(() => Wire.packParticipantModifiers(invalid));
        assert.throws(() => Wire.packParticipantModifiers({ [a]: invalid }));
    }
    for (const consumedMilestone of [0, -4, 1, 6, 4.5, 0x100000000, NaN, Infinity, '4']) {
        assert.throws(() => Wire.packParticipantModifiers({ [a]: { ...valid, consumedMilestone } }));
    }
    for (const modifierKind of [0, 3, -1, 1.5, NaN, Infinity, '1', null]) {
        assert.throws(() => Wire.packParticipantModifiers({ [a]: { ...valid, modifierKind } }));
    }
    for (const id of ['bad', '', a.replaceAll('-', ''), `${a} `]) {
        assert.throws(() => Wire.packParticipantModifiers({ [id]: valid }));
    }
    assert.throws(() => Wire.packParticipantModifiers({ [a]: valid, [a.toUpperCase()]: valid }));
});

test('choice decoding rejects malformed lengths, duplicate/order corruption and invalid encoded values', () => {
    const valid = Wire.packParticipantModifiers({
        [a]: { consumedMilestone: 4, modifierKind: 1 },
        [b]: { consumedMilestone: 8, modifierKind: 2 },
    });
    for (const value of [null, undefined, [], {}, valid.subarray(0, 41), new Uint8Array(1)]) {
        assert.throws(() => Wire.unpackParticipantModifiers(value));
    }
    const duplicate = new Uint8Array(valid);
    duplicate.set(valid.subarray(0, 16), 21);
    assert.throws(() => Wire.unpackParticipantModifiers(duplicate));
    const reversed = new Uint8Array(valid.length);
    reversed.set(valid.subarray(21), 0);
    reversed.set(valid.subarray(0, 21), 21);
    assert.throws(() => Wire.unpackParticipantModifiers(reversed));
    for (const milestone of [0, 1, 6, 0xffffffff]) {
        const corrupted = new Uint8Array(valid);
        new DataView(corrupted.buffer).setUint32(16, milestone, true);
        assert.throws(() => Wire.unpackParticipantModifiers(corrupted));
    }
    for (const kind of [0, 3, 255]) {
        const corrupted = new Uint8Array(valid);
        corrupted[20] = kind;
        assert.throws(() => Wire.unpackParticipantModifiers(corrupted));
    }
});

test('contributors retain accepted-damage ordinals independently of sorted identity order', () => {
    const contributors = Object.freeze({ [c]: 1, [a.toUpperCase()]: 3, [b]: 2 });
    const packed = Wire.packContributors(contributors);
    assert.equal(packed.length, 60);
    assert.deepEqual(Wire.unpackContributors(offsetCopy(packed)), { [a]: 3, [b]: 2, [c]: 1 });
    assert.equal(hex(Wire.packContributors({ [a]: 1 })), CONTRIBUTOR_ENTRY_HEX);
    assert.deepEqual(Wire.unpackContributors(new Uint8Array()), {});
    assert.deepEqual(Wire.packContributors({}), new Uint8Array());
});

test('contributors reject too many identities, duplicate identities/ordinals and invalid numeric ordinals', () => {
    for (const invalid of [null, undefined, [], new Map(), new Set(), new Date(), new Uint8Array(), 1]) {
        assert.throws(() => Wire.packContributors(invalid));
    }
    for (const ordinal of [0, -1, 4, 1.5, NaN, Infinity, '1', null]) {
        assert.throws(() => Wire.packContributors({ [a]: ordinal }));
    }
    for (const contributors of [
        { [a]: 1, [b]: 1 }, { [a]: 1, [a.toUpperCase()]: 2 },
        { [a]: 1, [b]: 2, [c]: 3, [d]: 1 }, { bad: 1 },
    ]) {
        assert.throws(() => Wire.packContributors(contributors));
    }
    for (const value of [null, undefined, [], {}, new Uint8Array(19), new Uint8Array(21)]) {
        assert.throws(() => Wire.unpackContributors(value));
    }
    const valid = Wire.packContributors({ [a]: 1, [b]: 2 });
    for (const ordinal of [0, 1, 4, 0xffffffff]) {
        const corrupted = new Uint8Array(valid);
        new DataView(corrupted.buffer).setUint32(36, ordinal, true);
        assert.throws(() => Wire.unpackContributors(corrupted));
    }
    const duplicate = new Uint8Array(valid);
    duplicate.set(valid.subarray(0, 16), 20);
    assert.throws(() => Wire.unpackContributors(duplicate));
});
