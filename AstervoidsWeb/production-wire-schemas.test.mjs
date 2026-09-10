import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'index.html'), 'utf8');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const WireCodec = require('./wwwroot/js/astervoids-wire-codec.js');
const WireSchemas = require('./wwwroot/js/game-wire-schemas.js');
const { SESSION_CONFIG_KEYS } = require('./wwwroot/js/game-config.js');

function registerProductionSchemas() {
    SchemaCodec.clear();
    SchemaCodec.replaceAll(WireSchemas.SCHEMAS);
}

test('production bullet timing and claim fields match the C# cross-wire fixture', () => {
    registerProductionSchemas();
    const schema = SchemaCodec.get(3);
    const data = {
        sampleAt: 1000.5, sampleTick: 24, bornAt: 980, shot: Uint8Array.of(0x90),
        hitClaimId: '11223344-5566-7788-99aa-bbccddeeff00',
        hitClaimAt: 1040.25, hitX: 0.5, hitY: 0.75, hitAngle: 1.5,
        hitTargetVersion: 42, hitTargetOwnerId: '11223344-5566-7788-99aa-bbccddeeff00',
    };
    const expected = '0000ff070000000000448f40180000000000000000a08e400100000090'
        + '443322116655887799aabbccddeeff000000000000419040000000000000e03f'
        + '000000000000e83f000000000000f83f2a000000443322116655887799aabbccddeeff00';
    assert.equal(Buffer.from(SchemaCodec.encode(schema, data)).toString('hex'), expected);
    const decoded = SchemaCodec.decode(schema, new Uint8Array(Buffer.from(expected, 'hex')));
    assert.deepEqual(decoded, data);
});

test('full gameplay schemas retain their IDs alongside compact update schemas', () => {
    const schemas = WireSchemas.SCHEMAS;
    assert.deepEqual(schemas.map(schema => schema.id), [1, 2, 3, 4, 5, 6, 7]);
    for (const schema of schemas) {
        assert.ok(schema.fields.length <= 32);
        assert.equal(
            new Set(schema.fields.map(field => field[0])).size,
            schema.fields.length,
            `schema ${schema.id} field names must be unique`);
    }
    assert.deepEqual(WireSchemas.SCHEMA_BY_OBJECT_TYPE, {
        ship: 1,
        asteroid: 2,
        bullet: 3,
        gameState: 4,
    });
});

test('regular update bytes match the pre-lifecycle layouts exactly', () => {
    registerProductionSchemas();
    const poses = [
        { type: 'ship', id: 5, fields: 24, bytes: 22, saved: 13, data: {
            x: 0.5, y: 0.25, angle: 1, velocityX: 0.1, velocityY: 0,
            rotationSpeed: 0.01, thrusting: true, invulnerable: 0 } },
        { type: 'asteroid', id: 6, fields: 14, bytes: 20, saved: 13, data: {
            x: 0.5, y: 0.25, angle: 1, velocityX: 0.1, velocityY: 0, rotationSpeed: 0.01 } },
        { type: 'bullet', id: 7, fields: 16, bytes: 8, saved: 14, data: {
            x: 0.5, y: 0.25, lifetime: 42 } },
    ];
    for (const { type, id, fields, bytes, saved, data } of poses) {
        assert.equal(WireSchemas.selectSchemaId(data, 'update', { object: { data: { type } } }), id);
        const compact = SchemaCodec.get(id);
        const full = SchemaCodec.get(WireSchemas.SCHEMA_BY_OBJECT_TYPE[type]);
        assert.equal(compact.fields.length, fields);
        assert.deepEqual(compact.fields, full.fields.slice(0, fields));
        const encoded = SchemaCodec.encode(compact, data);
        assert.equal(encoded.length, bytes);
        assert.deepEqual(SchemaCodec.decode(compact, encoded),
            SchemaCodec.decode(full, SchemaCodec.encode(full, data)));
        assert.equal(SchemaCodec.encode(full,
            { ...data, sampleAt: 1_700_000_000_000, sampleTick: 60 }).length - encoded.length, saved);
    }
});

test('compact update masks and quantization match the C# fixtures', () => {
    registerProductionSchemas();
    for (const [id, hex] of [[5, '06000000800060'], [6, '060000800060'], [7, '060000800060']]) {
        const schema = SchemaCodec.get(id);
        assert.equal(Buffer.from(SchemaCodec.encode(schema, { x: 0.5, y: 0.25 })).toString('hex'), hex);
        const data = SchemaCodec.decode(schema, new Uint8Array(Buffer.from(hex, 'hex')));
        assert.equal(Buffer.from(SchemaCodec.encode(schema, data)).toString('hex'), hex);
    }
});

test('rare fields and sessions without compact schemas never silently lose data', () => {
    for (const [type, extra] of [
        ['ship', { respawnEpoch: 2 }],
        ['asteroid', { parentX: 0.5 }],
        ['bullet', { hitClaimAt: 1200 }],
    ]) {
        const full = WireSchemas.SCHEMA_BY_OBJECT_TYPE[type];
        const context = { object: { data: { type } } };
        assert.equal(WireSchemas.selectSchemaId({ x: 0.5, ...extra }, 'update', context), full);
        assert.equal(WireSchemas.selectSchemaId({ type, ...extra }, 'create'), full);
        assert.equal(WireSchemas.selectSchemaId({ type, ...extra }, 'replace'), full);
        context.schemas = WireSchemas.SCHEMAS.slice(0, 4);
        assert.equal(WireSchemas.selectSchemaId({ x: 0.5 }, 'update', context), full);
        context.schemas = [];
        assert.equal(WireSchemas.selectSchemaId({ x: 0.5 }, 'update', context), 0);
        context.schemas = WireSchemas.SCHEMAS.slice(4).map(schema =>
            ({ id: schema.id - 4, fields: schema.fields }));
        assert.equal(WireSchemas.selectSchemaId(extra, 'update', context), 0);
    }
});

test('unified ship schema carries adaptive, replay, identity, and terminal subsets', () => {
    registerProductionSchemas();
    const schema = SchemaCodec.get(1);
    const names = new Set(schema.fields.map(field => field.name));
    for (const name of [
        'type', 'x', 'y', 'angle', 'velocityX', 'velocityY',
        'rotationSpeed', 'thrusting', 'invulnerable', 'memberId',
        'thrustInput', 'brakeInput', 'turnControlMode', 'turnTarget',
        'turnTargetAngle', 'turnMagnitude', 'turnBias',
        'terminalEpoch', 'terminalX', 'terminalY', 'terminalAngle',
    ]) {
        assert.ok(names.has(name), `ship schema missing ${name}`);
    }
    const terminal = {
        terminalEpoch: 1000,
        terminalX: 0.25,
        terminalY: 0.75,
        terminalAngle: Math.PI,
    };
    assert.deepEqual(
        SchemaCodec.decode(schema, SchemaCodec.encode(schema, terminal)),
        terminal);
});

test('ship schema preserves analog thrust above the unit interval', () => {
    registerProductionSchemas();
    const schema = SchemaCodec.get(1);
    const thrustField = schema.fields.find(field => field.name === 'thrustInput');
    assert.equal(thrustField?.type, 'f32');

    const decoded = SchemaCodec.decode(
        schema,
        SchemaCodec.encode(schema, { thrustInput: 1.5 }));
    assert.equal(decoded.thrustInput, 1.5);
});

test('kinematic schemas preserve supported motion beyond the unit interval', () => {
    registerProductionSchemas();
    const shipSchema = SchemaCodec.get(1);
    const asteroidSchema = SchemaCodec.get(2);

    for (const field of ['velocityX', 'velocityY']) {
        assert.equal(
            shipSchema.fields.find(candidate => candidate.name === field)?.type,
            'f32');
        assert.equal(
            asteroidSchema.fields.find(candidate => candidate.name === field)?.type,
            'f32');
    }
    assert.equal(
        asteroidSchema.fields.find(field => field.name === 'rotationSpeed')?.type,
        'f32');

    const ship = SchemaCodec.decode(
        shipSchema,
        SchemaCodec.encode(shipSchema, { velocityX: 4.5, velocityY: -3.25 }));
    assert.ok(Math.abs(ship.velocityX - 4.5) < 1e-6);
    assert.ok(Math.abs(ship.velocityY + 3.25) < 1e-6);

    const asteroid = SchemaCodec.decode(
        asteroidSchema,
        SchemaCodec.encode(asteroidSchema, {
            velocityX: 1.5,
            velocityY: -1.25,
            rotationSpeed: 1.2,
        }));
    assert.ok(Math.abs(asteroid.velocityX - 1.5) < 1e-6);
    assert.ok(Math.abs(asteroid.velocityY + 1.25) < 1e-6);
    assert.ok(Math.abs(asteroid.rotationSpeed - 1.2) < 1e-6);
});

test('asteroid schema omits reproducible vertices and packs fracture vertices', () => {
    registerProductionSchemas();
    const schema = SchemaCodec.get(2);
    const seeded = {
        type: 'asteroid',
        x: 0.5,
        y: 0.25,
        angle: 1,
        radius: 0.083,
        velocityX: 0.1,
        velocityY: -0.05,
        rotationSpeed: 0.01,
        seed: 0.123456789,
    };
    const seededBytes = SchemaCodec.encode(schema, seeded);
    const decodedSeeded = SchemaCodec.decode(schema, seededBytes);
    assert.equal('vertices' in decodedSeeded, false);

    const vertices = WireCodec.packAsteroidVertices([
        { angle: 0, distance: 0.08 },
        { angle: 2, distance: 0.07 },
        { angle: 4, distance: 0.09 },
    ]);
    const fractureBytes = SchemaCodec.encode(schema, { ...seeded, vertices });
    const decodedFracture = SchemaCodec.decode(schema, fractureBytes);
    assert.equal(WireCodec.bytesEqual(decodedFracture.vertices, vertices), true);
    assert.ok(fractureBytes.length > seededBytes.length);
    assert.ok(SESSION_CONFIG_KEYS.includes('ASTEROID_VERTICES'));
    assert.ok(SESSION_CONFIG_KEYS.includes('ASTEROID_JAGGEDNESS'));
});

test('bullet schema keeps ballistic and hit deltas sparse', () => {
    registerProductionSchemas();
    const schema = SchemaCodec.get(3);
    const ballistic = SchemaCodec.encode(schema, {
        x: 0.5,
        y: 0.25,
        lifetime: 42,
    });
    const hit = SchemaCodec.encode(schema, {
        pendingHit: true,
        hitTargetId: '00112233-4455-6677-8899-aabbccddeeff',
        hitImpactTorque: 0.05,
        hitBulletAngle: 1.5,
        hitOffsetN: -0.25,
    });

    const maskBytes = Math.ceil(schema.fields.length / 8);
    assert.equal(ballistic.length, maskBytes + 6);
    assert.equal(hit.length, maskBytes + 24);
    assert.equal(SchemaCodec.decode(schema, ballistic).lifetime, 42);
    assert.equal(
        SchemaCodec.decode(schema, hit).hitTargetId,
        '00112233-4455-6677-8899-aabbccddeeff');
});

test('GameState schema stores compact counter-map bytes', () => {
    registerProductionSchemas();
    const schema = SchemaCodec.get(4);
    const id = '00112233-4455-6677-8899-aabbccddeeff';
    const processedHits = WireCodec.packCounterMap({ [id]: 2 });
    const bytes = SchemaCodec.encode(schema, {
        groupScore: 100,
        processedHits,
        scoreLifeAwardCount: 1,
    });
    const decoded = SchemaCodec.decode(schema, bytes);

    assert.equal(decoded.groupScore, 100);
    assert.equal(decoded.scoreLifeAwardCount, 1);
    assert.deepEqual(WireCodec.unpackCounterMap(decoded.processedHits), { [id]: 2 });
});

test('known terminal updates do not fall back to schema zero', () => {
    for (const type of Object.keys(WireSchemas.SCHEMA_BY_OBJECT_TYPE)) {
        assert.notEqual(
            WireSchemas.selectSchemaId(
                type === 'gameState' ? { terminalAt: 1 } : { terminalEpoch: 1 },
                'update',
                { object: { data: { type } } }),
            0,
            type);
    }
});

test('production serializers keep optional high-cost data sparse', () => {
    assert.match(
        source,
        /if \(isDeterministicMode\(\)\) \{[\s\S]*thrustInput: this\.thrustInput/);
    assert.match(
        source,
        /if \(this\.hasExplicitVertices\) \{[\s\S]*packAsteroidVertices\(this\.vertices\)/);
    assert.match(
        source,
        /if \(this\.pendingHit\) Object\.assign\(data, this\.toHitData\(\)\)/);
    assert.match(
        source,
        /processedHits: AstervoidsWireCodec\.packCounterMap\(processedHits\)/);
    assert.match(
        source,
        /processedScores: AstervoidsWireCodec\.packCounterMap\(processedScores\)/);
    assert.match(
        source,
        /try \{[\s\S]*unpackCounterMap\([\s\S]*Refusing malformed GameState ledgers/);
});
