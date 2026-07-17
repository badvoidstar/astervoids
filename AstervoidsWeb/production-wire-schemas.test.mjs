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

function productionSchemas() {
    const marker = 'const WIREOPT_SCHEMAS = ';
    const start = source.indexOf(marker);
    const end = source.indexOf('\n    const WIREOPT_SCHEMA_BY_TYPE', start);
    assert.ok(start >= 0 && end > start, 'production schema literal not found');
    return Function(`"use strict"; return (${
        source.slice(start + marker.length, end).trim().replace(/;$/, '')
    });`)();
}

function registerProductionSchemas() {
    SchemaCodec.clear();
    SchemaCodec.replaceAll(productionSchemas());
}

test('known gameplay objects each have one positional schema', () => {
    const schemas = productionSchemas();
    assert.deepEqual(schemas.map(schema => schema.id), [1, 2, 3, 4]);
    for (const schema of schemas) {
        assert.ok(schema.fields.length <= 32);
        assert.equal(
            new Set(schema.fields.map(field => field[0])).size,
            schema.fields.length,
            `schema ${schema.id} field names must be unique`);
    }
    for (const mapping of [
        '[OBJECT_TYPES.SHIP]: 1',
        '[OBJECT_TYPES.ASTEROID]: 2',
        '[OBJECT_TYPES.BULLET]: 3',
        '[OBJECT_TYPES.GAME_STATE]: 4',
    ]) {
        assert.ok(source.includes(mapping), `missing production mapping ${mapping}`);
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
    const sessionConfig = source.slice(
        source.indexOf('const SESSION_CONFIG_KEYS = ['),
        source.indexOf('];', source.indexOf('const SESSION_CONFIG_KEYS = [')));
    assert.match(sessionConfig, /'ASTEROID_VERTICES'/);
    assert.match(sessionConfig, /'ASTEROID_JAGGEDNESS'/);
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

    assert.equal(ballistic.length, 8);
    assert.equal(hit.length, 26);
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
    });
    const decoded = SchemaCodec.decode(schema, bytes);

    assert.equal(decoded.groupScore, 100);
    assert.deepEqual(WireCodec.unpackCounterMap(decoded.processedHits), { [id]: 2 });
});

test('known terminal updates do not fall back to schema zero', () => {
    assert.doesNotMatch(source, /terminalEpoch !== undefined\) return 0/);
    assert.match(source, /return WIREOPT_SCHEMA_BY_TYPE\[type\] \|\| 0;/);
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
