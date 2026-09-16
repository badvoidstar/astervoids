/**
 * `senderSendIntervalMs` is a capability claim: receivers size their buffering
 * from it and reject packet intervals wider than twice its value, so a sender
 * that advertises a cadence it cannot keep gets its own updates filtered out of
 * every peer's interval statistics. These tests drive the production ObjectSync
 * flush accumulator at a range of display cadences and pin the advertised value
 * to the spacing actually achieved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './test-support/classic-module.mjs';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');

/**
 * An always-dirty producer on a fixed-cadence display. Flush requests are
 * answered immediately, so the only thing limiting send spacing is the
 * accumulator's tick quantization.
 */
function harness(nominalFrameTime) {
    const handlers = {};
    const advertised = [];
    const SessionClient = {
        on: (event, callback) => { handlers[event] = callback; },
        isInSession: () => true,
        getCurrentMember: () => ({ id: 'owner' }),
        updateObjects: async (updates, sequence, senderSendIntervalMs) => {
            advertised.push(senderSendIntervalMs);
            return { versions: [advertised.length + 1], memberSequence: sequence };
        },
    };
    const ObjectSync = loadClassicModule('object-sync.js', 'ObjectSync',
        { SessionClient, AuthoritativeObject, window: {} });
    ObjectSync.init();
    ObjectSync.configure({ nominalFrameTime, deltaEncoding: false });
    handlers.onSessionJoined({
        objects: [{
            id: 'obj', data: { x: 0 }, version: 1,
            ownerMemberId: 'owner', creatorMemberId: 'owner', scope: 'Member',
        }],
    });

    let frames = 0;
    /** Runs `count` frames at `frameMs`, returning the frame index of each send. */
    async function run(frameMs, count) {
        const sendFrames = [];
        for (let i = 0; i < count; i++) {
            const before = advertised.length;
            ObjectSync.updateObject('obj', { x: frames });
            ObjectSync.tick(frameMs / 1000);
            // Two drains: the first settles the in-flight invoke, the second
            // lets the continuation clear backpressure before the next frame.
            await Promise.resolve();
            await Promise.resolve();
            if (advertised.length > before) sendFrames.push(frames);
            frames++;
        }
        return sendFrames;
    }
    return { ObjectSync, advertised, run };
}

/** Mean spacing between consecutive sends, in milliseconds. */
function meanSpacingMs(sendFrames, frameMs) {
    assert.ok(sendFrames.length > 2, 'need several sends to measure spacing');
    const span = sendFrames[sendFrames.length - 1] - sendFrames[0];
    return (span * frameMs) / (sendFrames.length - 1);
}

// Display cadence x requested TX. Error is bounded by frameMs/TX and vanishes
// when TX is a harmonic of the refresh rate, which is exactly why understated
// cadence stayed invisible at 60Hz.
const DISPLAY_HZ = [144, 120, 60, 30, 24, 10];
const NOMINAL_TX_MS = [50, 67, 100];

for (const hz of DISPLAY_HZ) {
    for (const txMs of NOMINAL_TX_MS) {
        test(`advertises achieved cadence at ${hz}Hz for a ${txMs}ms request`, async () => {
            const frameMs = 1000 / hz;
            const h = harness(txMs / 1000);
            // Warm the estimate past the EMA's transient before measuring.
            await h.run(frameMs, Math.ceil(4000 / frameMs));
            const baseline = h.advertised.length;
            const sendFrames = await h.run(frameMs, Math.ceil(4000 / frameMs));

            const measured = meanSpacingMs(sendFrames, frameMs);
            const claimed = h.advertised.slice(baseline);
            for (const value of claimed) {
                assert.ok(Math.abs(value - measured) <= 1,
                    `advertised ${value}ms but sent every ${measured.toFixed(1)}ms`);
            }
            // Quantization only ever rounds up, so the claim is never faster
            // than the request: this can add buffering but never remove it.
            assert.ok(claimed[0] >= txMs - 1, `${claimed[0]}ms under-states the ${txMs}ms request`);
        });
    }
}

test('a harmonic request is advertised unquantized', async () => {
    const h = harness(100 / 1000);
    await h.run(1000 / 60, 300);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 100);
    assert.equal(h.ObjectSync.getSendRate(), 10, 'the request is unchanged');
});

test('a non-harmonic request is advertised rounded up to the next frame', async () => {
    const h = harness(67 / 1000);
    await h.run(1000 / 60, 300);
    // 60Hz can only release on 16.7ms boundaries, so a 67ms request sends at 83.3ms.
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 83);
    assert.equal(h.ObjectSync.getSendRate(), 15, 'the request is unchanged');
});

test('a backgrounded tab advertises its throttled cadence, not its request', async () => {
    const h = harness(50 / 1000);
    await h.run(1000 / 60, 300);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 50, 'foreground baseline');
    // Browsers clamp timers in hidden tabs to ~1s; the request is unchanged.
    await h.run(1000, 60);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 1000);
    // Receivers gate at twice the advertised interval. Under the old claim of
    // 50ms every real 1000ms interval was discarded as an outlier, starving the
    // statistics that size buffering for every object this member owns.
    assert.ok(1000 <= 2 * h.ObjectSync.getEffectiveSendIntervalMs());
});

test('stalls are clamped rather than advertised as cadence', async () => {
    const h = harness(50 / 1000);
    await h.run(1000 / 60, 300);
    // A 30s freeze (debugger pause, suspended machine) must not become a 30s claim.
    await h.run(30000, 5);
    assert.ok(h.ObjectSync.getEffectiveSendIntervalMs() <= 1000,
        'a multi-second stall must never be advertised as cadence');
    await h.run(30000, 100);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 1000,
        'advertised interval saturates at the 1s cap');
});

test('the advertised interval never falls below the configured request', async () => {
    const h = harness(1);
    await h.run(30000, 10);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 1000,
        'the 1s cap does not clamp below a 1s request');
});

test('the estimate is smoothed so frame jitter does not flap the claim', async () => {
    // 144Hz sits comfortably inside a band: a 50ms request needs 8 frames
    // anywhere between ~6.3ms and ~7.1ms of tick spacing. Sampling a single
    // frame instead would leave the band on every jittery frame.
    const nominal = 1000 / 144;
    const jitter = [nominal - 1, nominal + 1];
    const h = harness(50 / 1000);
    await h.run(nominal, 800);

    const smoothed = [];
    for (let i = 0; i < 200; i++) {
        await h.run(jitter[i % 2], 1);
        smoothed.push(h.ObjectSync.getEffectiveSendIntervalMs());
    }
    const spread = values => Math.max(...values) - Math.min(...values);
    const ticksPerFlush = frameMs => Math.ceil(50 / frameMs - 1e-9);
    assert.ok(spread(smoothed) < nominal,
        `advertised interval moved ${spread(smoothed).toFixed(1)}ms, more than one frame`);
    assert.notEqual(ticksPerFlush(jitter[0]), ticksPerFlush(jitter[1]),
        'an unsmoothed estimate would land on a different flush boundary each frame');
});

test('an unticked sender falls back to advertising its configured request', () => {
    const h = harness(50 / 1000);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 50);
    h.ObjectSync.tick(0);
    assert.equal(h.ObjectSync.getEffectiveSendIntervalMs(), 50,
        'zero-length ticks carry no cadence signal');
});

test('the wire carries the achievable interval, not the request', async () => {
    const h = harness(50 / 1000);
    await h.run(1000 / 24, 200);
    assert.ok(h.advertised.length > 0);
    const last = h.advertised[h.advertised.length - 1];
    assert.equal(last, h.ObjectSync.getEffectiveSendIntervalMs());
    assert.equal(last, 83, '24Hz cannot flush a 50ms request faster than every 2 frames');
    // MessagePack encodes 0-127 as a single positive fixint byte, so correcting
    // the value costs nothing on the wire in the common case.
    assert.ok(last <= 127);
});
