import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WireCodec = require('./wwwroot/js/astervoids-wire-codec.js');

function angularDistance(left, right) {
    const difference = Math.abs(left - right);
    return Math.min(difference, Math.PI * 2 - difference);
}

test('asteroid vertices pack to four bytes each and round-trip within q16 tolerance', () => {
    const vertices = [
        { angle: -0.25, distance: 0.045 },
        { angle: Math.PI, distance: 0.1 },
        { angle: Math.PI * 2 + 0.5, distance: 0.025 },
    ];

    const packed = WireCodec.packAsteroidVertices(vertices);
    const decoded = WireCodec.unpackAsteroidVertices(packed);

    assert.equal(packed.length, vertices.length * 4);
    assert.equal(decoded.length, vertices.length);
    for (let i = 0; i < vertices.length; i++) {
        assert.ok(angularDistance(decoded[i].angle, vertices[i].angle) <= Math.PI * 2 / 65536);
        assert.ok(Math.abs(decoded[i].distance - vertices[i].distance) <= 1 / 65535);
    }
    assert.equal(
        WireCodec.maxAsteroidVertexDistance(packed),
        Math.max(...decoded.map(vertex => vertex.distance)));
});

test('asteroid vertex helpers retain legacy arrays and reject malformed bytes', () => {
    const vertices = [{ angle: 1, distance: 0.2 }];
    assert.deepEqual(WireCodec.unpackAsteroidVertices(vertices), vertices);
    assert.equal(WireCodec.hasAsteroidVertices(vertices), true);
    assert.equal(WireCodec.hasAsteroidVertices(new Uint8Array()), false);
    assert.equal(WireCodec.hasAsteroidVertices(new Uint8Array(5)), false);
    assert.throws(
        () => WireCodec.unpackAsteroidVertices(new Uint8Array(3)),
        /invalid byte length/);
    assert.throws(
        () => WireCodec.packAsteroidVertices([{ angle: 0, distance: 1.1 }]),
        /within \[0, 1\]/);
});

test('counter maps use stable sorted 20-byte GUID/value entries', () => {
    const firstId = '00112233-4455-6677-8899-aabbccddeeff';
    const secondId = '11112233-4455-6677-8899-aabbccddeeff';
    const left = WireCodec.packCounterMap({
        [secondId]: 9,
        [firstId]: 3,
    });
    const right = WireCodec.packCounterMap({
        [firstId.toUpperCase()]: 3,
        [secondId]: 9,
    });

    assert.equal(left.length, 40);
    assert.equal(WireCodec.bytesEqual(left, right), true);
    assert.deepEqual(WireCodec.unpackCounterMap(left), {
        [firstId]: 3,
        [secondId]: 9,
    });
});

test('counter-map codec rejects invalid ids, values, and byte lengths', () => {
    assert.throws(() => WireCodec.packCounterMap({ nope: 1 }), /invalid counter-map GUID/);
    assert.throws(
        () => WireCodec.packCounterMap({
            '00112233-4455-6677-8899-aabbccddeeff': -1,
        }),
        /must be a uint32/);
    assert.throws(
        () => WireCodec.unpackCounterMap(new Uint8Array(19)),
        /invalid byte length/);
});
