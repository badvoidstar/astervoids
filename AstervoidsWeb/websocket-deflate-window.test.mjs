// Offline benchmark for the permessage-deflate settings in
// `Hubs/WebSocketCompressionMiddleware.cs` (`ServerMaxWindowBits` and
// `DisableServerContextTakeover`). It replays a synthetic-but-production-encoded
// stream of `OnObjectsUpdated` broadcasts through `node:zlib` under RFC 7692
// semantics and asserts the two properties those settings rest on:
//
//   1. a 4 KiB window compresses this traffic as well as the 32 KiB default, and
//   2. context takeover is what actually buys the compression.
//
// Nothing here runs in production and no real players are involved; it exists
// because the middleware's tuning comment has twice recorded figures that later
// turned out to be wrong, and a claim nobody can re-run is a claim that rots.
//
// Fidelity matters more than volume here. Frames are built from the *production*
// encoders — the vendored SignalR MessagePack hub protocol for the envelope and
// `SchemaCodec` + `game-wire-schemas` for the payload — so a wire change moves
// the corpus with it rather than leaving it frozen at a shape we no longer send.
// A hand-rolled corpus is actively misleading: an earlier attempt with a
// realistic envelope that was byte-identical every frame compressed to ~0.04 and
// showed no window effect at all, for reasons that had nothing to do with the
// traffic. `corpus tracks the C# steady-state size bands` pins the generator to
// the same numbers `WireSizeBenchTests` asserts, so drift fails loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const MsgpackCodec = require('./wwwroot/js/msgpack-codec.js');
const { SCHEMAS } = require('./wwwroot/js/game-wire-schemas.js');

// The vendored SignalR bundles are browser globals scripts, not CommonJS: they
// publish onto `self`, and the msgpack protocol extends the object the base
// bundle installed, so both must be evaluated into the same context in order.
function loadHubProtocol() {
    const sandbox = {
        self: {}, window: {}, console,
        TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout
    };
    createContext(sandbox);
    for (const file of ['signalr.min.js', 'signalr-protocol-msgpack.min.js']) {
        const path = fileURLToPath(new URL(`./wwwroot/js/${file}`, import.meta.url));
        runInContext(readFileSync(path, 'utf8'), sandbox, { filename: path });
    }
    return new sandbox.self.signalR.protocols.msgpack.MessagePackHubProtocol();
}

const hubProtocol = loadHubProtocol();

function registerSchemas() {
    SchemaCodec.clear();
    const byId = new Map();
    for (const schema of SCHEMAS) byId.set(schema.id, SchemaCodec.register(schema.id, schema.fields));
    return byId;
}

// mulberry32: seeded so a failure is reproducible from the test name alone.
function seededRandom(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const wrapUnit = v => (v < 0 ? v + 1 : v >= 1 ? v - 1 : v);

// The field sets mirror `WireSizeBenchTests.Sample*UpdateQuantized` — i.e. what a
// steady-state frame actually carries, which is a position delta for most objects
// and the full replay-capable field set for the ship.
function encodeUpdate(schemas, object) {
    if (object.kind === 'asteroid') {
        return [2, SchemaCodec.encode(schemas.get(2), { x: object.x, y: object.y, angle: object.angle })];
    }
    if (object.kind === 'bullet') {
        return [3, SchemaCodec.encode(schemas.get(3), { x: object.x, y: object.y, lifetime: object.lifetime & 0xffff })];
    }
    return [1, SchemaCodec.encode(schemas.get(1), {
        x: object.x, y: object.y, angle: object.angle,
        velocityX: object.velocityX, velocityY: object.velocityY,
        rotationSpeed: object.rotationSpeed,
        thrusting: true, invulnerable: 120,
        invulnerabilityRevision: 1, invulnerableAt: 1.8e12,
        thrustInput: 1, brakeInput: 0,
        turnControlMode: 1, turnTarget: 0.5, turnTargetAngle: 1.5,
        turnMagnitude: 1, turnBias: 0
    })];
}

/**
 * Builds `frameCount` `OnObjectsUpdated` broadcasts for a session of
 * `asteroids` + one ship + `bullets`, advancing every object by one tick per
 * frame. Handles, versions, sequence numbers and timestamps all vary the way
 * they do on a live connection — that per-frame variation in the envelope is
 * precisely what a compression window has to work against.
 */
function buildCorpus({ asteroids = 4, bullets = 2, frameCount = 300, seed = 1234 } = {}) {
    const schemas = registerSchemas();
    const random = seededRandom(seed);
    let nextHandle = 1000;
    const spawn = kind => ({
        kind,
        x: random(), y: random(), angle: random() * Math.PI * 2,
        velocityX: (random() - 0.5) * 0.06, velocityY: (random() - 0.5) * 0.06,
        rotationSpeed: (random() - 0.5) * 0.02,
        handle: nextHandle++, version: 1, lifetime: 120
    });
    const world = [
        ...Array.from({ length: asteroids }, () => spawn('asteroid')),
        spawn('ship'),
        ...Array.from({ length: bullets }, () => spawn('bullet'))
    ];

    const memberId = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
    const frames = [];
    let senderSequence = 1;
    let memberSequence = 1;
    let timestamp = 1.8e12;

    for (let frame = 0; frame < frameCount; frame++) {
        const batch = [];
        for (const object of world) {
            object.x = wrapUnit(object.x + object.velocityX);
            object.y = wrapUnit(object.y + object.velocityY);
            object.angle = (object.angle + object.rotationSpeed) % (Math.PI * 2);
            object.version++;
            if (object.kind === 'bullet') object.lifetime--;
            batch.push([object.handle, encodeUpdate(schemas, object), object.version]);
        }
        timestamp += 50;
        // Argument order is the broadcast in SessionHub.OnObjectsUpdated:
        // updateInfos, memberId, senderSequence, memberSequence, serverTimestamp,
        // senderSendIntervalMs, batchValidAt.
        frames.push(Buffer.from(new Uint8Array(hubProtocol.writeMessage({
            type: 1,
            target: 'OnObjectsUpdated',
            arguments: [batch, memberId, senderSequence++, memberSequence++, timestamp, 50, timestamp - 12],
            streamIds: []
        }))));
    }
    return frames;
}

/**
 * Compresses `frames` the way RFC 7692 does: one raw-deflate stream for the
 * connection, `Z_SYNC_FLUSH` after every message, and the trailing `00 00 FF FF`
 * stripped from each flush. Returns compressed/raw over the whole stream.
 *
 * Node's zlib streams are asynchronous: both the write and the flush have to be
 * awaited or output is silently dropped and the ratio reads as zero.
 */
function deflateRatio(frames, { windowBits, contextTakeover = true }) {
    const createStream = () => zlib.createDeflateRaw({ windowBits });
    const chunks = [];
    let stream = createStream();
    stream.on('data', chunk => chunks.push(chunk));

    let rawBytes = 0;
    let compressedBytes = 0;

    return new Promise((resolve, reject) => {
        let index = 0;
        const pump = () => {
            if (index >= frames.length) return resolve(compressedBytes / rawBytes);
            const frame = frames[index++];
            rawBytes += frame.length;
            chunks.length = 0;
            stream.write(frame, () => stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
                let out = Buffer.concat(chunks);
                if (out.length >= 4 && out.subarray(out.length - 4).equals(TAIL)) {
                    out = out.subarray(0, out.length - 4);
                }
                compressedBytes += out.length;
                if (!contextTakeover) {
                    stream.removeAllListeners('data');
                    stream = createStream();
                    stream.on('data', chunk => chunks.push(chunk));
                }
                pump();
            }));
        };
        stream.on('error', reject);
        pump();
    });
}

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

// Production settings, mirrored from WebSocketCompressionMiddleware.
const SERVER_MAX_WINDOW_BITS = 12;
const DEFAULT_MAX_WINDOW_BITS = 15;

test('corpus tracks the C# steady-state size bands', () => {
    // WireSizeBenchTests asserts these bands against the same field sets through
    // the C# codec. Matching them here is what makes this corpus a model of real
    // traffic rather than a plausible-looking invention.
    const schemas = registerSchemas();
    const asteroid = () => [4242, encodeUpdate(schemas, { kind: 'asteroid', x: 0.523, y: 0.412, angle: 1.234 }), 42];
    const bullet = () => [4242, encodeUpdate(schemas, { kind: 'bullet', x: 0.523, y: 0.412, lifetime: 42 }), 42];
    const ship = () => [4242, encodeUpdate(schemas, {
        kind: 'ship', x: 0.523, y: 0.412, angle: 1.234,
        velocityX: 0.05, velocityY: -0.03, rotationSpeed: 0.01
    }), 42];

    const threeAsteroids = MsgpackCodec.encode([asteroid(), asteroid(), asteroid()]).length;
    assert.ok(threeAsteroids >= 45 && threeAsteroids <= 60,
        `three asteroid deltas should be 45-60 B (WireSizeBenchTests), got ${threeAsteroids}`);

    const mixed = MsgpackCodec.encode([
        asteroid(), asteroid(), asteroid(), asteroid(), ship(), bullet(), bullet()
    ]).length;
    assert.ok(mixed >= 150 && mixed <= 175,
        `mixed steady-state batch should be 150-175 B (WireSizeBenchTests), got ${mixed}`);
});

test('harness detects a window-size effect when one is present', async () => {
    // The tuning assertion below is a *null* result, and a broken measurement
    // produces a null result for free. This control forces the harness to prove
    // it can see the effect it is about to report as absent: 200 incompressible
    // frames replayed once, so the only available match sits ~32 KiB back and
    // only the largest window can reach it.
    const random = seededRandom(7);
    const unique = Array.from({ length: 200 }, () =>
        Buffer.from(Uint8Array.from({ length: 160 }, () => (random() * 256) | 0)));
    const frames = [...unique, ...unique];

    const wide = await deflateRatio(frames, { windowBits: DEFAULT_MAX_WINDOW_BITS });
    const narrow = await deflateRatio(frames, { windowBits: SERVER_MAX_WINDOW_BITS });

    assert.ok(wide < 0.6, `32 KiB window should reach the replay, got ${wide.toFixed(3)}`);
    assert.ok(narrow > 0.9, `4 KiB window should miss the replay, got ${narrow.toFixed(3)}`);
});

test('a 4 KiB window matches the 32 KiB default on hub traffic', async () => {
    // Why `ServerMaxWindowBits = 12` is free rather than a trade: gameplay state
    // drifts continuously, so nothing repeats at long range. The dominant match
    // is against the previous frame a few hundred bytes back, which fits in even
    // a 4 KiB window. If this ever fails, the traffic has gained long-range
    // redundancy and the window is worth re-tuning.
    const frames = buildCorpus();
    const ratios = {};
    for (const windowBits of [15, 14, 13, 12, 11]) {
        ratios[windowBits] = await deflateRatio(frames, { windowBits });
    }
    const meanFrame = frames.reduce((sum, f) => sum + f.length, 0) / frames.length;
    console.log(`  deflate sweep (mean frame ${meanFrame.toFixed(0)} B): ` +
        Object.entries(ratios).map(([w, r]) => `wb${w}=${r.toFixed(3)}`).join(' '));

    const tuned = ratios[SERVER_MAX_WINDOW_BITS];
    const widest = ratios[DEFAULT_MAX_WINDOW_BITS];
    assert.ok(tuned < 0.6, `hub traffic should compress well below 0.6, got ${tuned.toFixed(3)}`);
    assert.ok(tuned - widest < 0.02,
        `a ${SERVER_MAX_WINDOW_BITS}-bit window should not cost more than 0.02 ratio against ` +
        `${DEFAULT_MAX_WINDOW_BITS}-bit, got ${tuned.toFixed(3)} vs ${widest.toFixed(3)}`);
});

test('context takeover is what buys the compression', async () => {
    // Guards `DisableServerContextTakeover = false`. Unlike the window, this one
    // is load-bearing: without a persistent window each frame is compressed cold
    // and there is almost nothing to gain.
    const frames = buildCorpus();
    const withTakeover = await deflateRatio(frames, { windowBits: SERVER_MAX_WINDOW_BITS });
    const without = await deflateRatio(frames, { windowBits: SERVER_MAX_WINDOW_BITS, contextTakeover: false });
    console.log(`  context takeover: on=${withTakeover.toFixed(3)} off=${without.toFixed(3)}`);

    assert.ok(without - withTakeover > 0.3,
        `disabling takeover should cost far more than window size does, ` +
        `got ${without.toFixed(3)} vs ${withTakeover.toFixed(3)}`);
});
