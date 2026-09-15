import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadClassicModule } from './test-support/classic-module.mjs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const { heartbeatDue, createBallisticGate } =
    require('./wwwroot/js/replication-send-policy.js');
const AuthoritativeObject =
    require('./wwwroot/js/authoritative-object.js');

// Heartbeat deadlines are quantized onto a fixed local wall-clock grid
// (`floor((lastSentMs + HB) / HB) * HB`) so that objects whose last send
// happened at unrelated instants re-anchor together and coalesce into ONE
// transport flush, instead of trickling across flush opportunities one or two
// objects at a time and each paying the full hub-frame envelope.
//
// This file pins the three properties that make that safe, and then drives the
// production frame scheduler (`gameLoop`), the production flush quantizer
// (`ObjectSync.tick`) and the production gate together at several display
// refresh rates, because the interesting behaviour only appears when all three
// interact. The layers stay independent: the gate never sees a frame or a
// flush, and `ObjectSync` remains the sole authority on when bytes leave.

const HEARTBEAT = 250;
const CONFIG = {
    SEND_ON_CHANGE_ENABLED: true,
    SEND_ON_CHANGE_HEARTBEAT_MS: HEARTBEAT,
    SEND_ON_CHANGE_VEL_EPS: 1e-4,
    SEND_ON_CHANGE_ROT_EPS: 1e-4,
    SEND_ON_CHANGE_WRAP_JUMP: 0.25,
};

// ── deadline algebra ────────────────────────────────────────────────────────

// Locates the exact instant the production predicate flips, without restating
// its formula here. The deadline is bracketed by (lastSent, lastSent + HB],
// which the first test below independently establishes.
function nextDue(lastSentMs, heartbeatMs = HEARTBEAT) {
    let low = lastSentMs;
    let high = lastSentMs + heartbeatMs;
    for (let i = 0; i < 100; i++) {
        const mid = (low + high) / 2;
        if (mid <= low || mid >= high) break;
        if (heartbeatDue(mid, lastSentMs, heartbeatMs)) high = mid;
        else low = mid;
    }
    return high;
}

test('the aligned deadline lies in (lastSent, lastSent + HEARTBEAT]', () => {
    // Fires no later than the unaligned deadline => receiver-visible staleness
    // can never regress; fires strictly later than the send => no busy-send.
    for (let lastSent = 0; lastSent < 4 * HEARTBEAT; lastSent += 0.5) {
        assert.equal(heartbeatDue(lastSent, lastSent, HEARTBEAT), false,
            `fired at the instant of the send (lastSent=${lastSent})`);
        assert.equal(heartbeatDue(lastSent + HEARTBEAT, lastSent, HEARTBEAT), true,
            `fired later than the unaligned deadline (lastSent=${lastSent})`);
    }
});

test('consecutive heartbeats stay a full period apart: the packet rate is unchanged', () => {
    // Firing at or after a grid point pushes the next deadline a full period
    // out, so aligning cannot raise the steady-state heartbeat rate.
    for (const offset of [0, 1, 7.5, 124, 249, 249.9]) {
        let lastSent = offset;
        let previous = null;
        for (let i = 0; i < 20; i++) {
            const due = nextDue(lastSent);
            if (previous !== null) {
                assert.ok(due - previous >= HEARTBEAT,
                    `heartbeats ${due - previous}ms apart (offset=${offset})`);
            }
            previous = due;
            lastSent = due;
        }
    }
});

test('an off-grid send converges onto the grid within one period, then locks', () => {
    let lastSent = 1;             // e.g. a motion change at an arbitrary instant
    const fired = [];
    for (let i = 0; i < 5; i++) {
        lastSent = nextDue(lastSent);
        fired.push(lastSent);
    }
    for (const instant of fired) {
        assert.equal(instant % HEARTBEAT, 0, `${instant} is not on the grid`);
    }
    assert.ok(fired[0] - 1 <= HEARTBEAT, 'convergence costs at most one period');
});

test('a non-positive or unset period falls back to the plain elapsed comparison', () => {
    assert.equal(heartbeatDue(1000, 1000, 0), true, '0 => always due, as before');
    assert.equal(heartbeatDue(1000, 1000, undefined), false, 'unset => never due');
    assert.equal(heartbeatDue(1000, 1000, NaN), false);
    assert.equal(heartbeatDue(1000, 1200, -1), false);
});

test('the grid is the LOCAL clock, so senders do not burst in lockstep', () => {
    // performance.now() origins differ per document. Aligning to the shared
    // server clock instead would put every member of a session on the same
    // 250ms boundary and correlate server fan-out and ingress queueing.
    const sendInstants = origin => {
        const fired = [];
        let lastSent = 0;                       // local axis
        for (let i = 0; i < 6; i++) {
            lastSent = nextDue(lastSent);
            fired.push(lastSent + origin);      // shared absolute axis
        }
        return fired;
    };
    const a = sendInstants(0);
    const b = sendInstants(137.5);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.notEqual(a[i], b[i], 'two documents burst on the same instant');
    }
});

// ── end-to-end: frame scheduler + flush quantizer + gate ────────────────────

function ballisticObject(id, x) {
    return { id, x, y: 0.5, velocityX: 0.01, velocityY: 0, angle: 0, rotationSpeed: 0.2 };
}

function makeTransport() {
    const handlers = {};
    const flushes = [];
    return {
        flushes,
        handlers,
        on: (event, callback) => { handlers[event] = callback; },
        getSessionEpoch: () => 1,
        isInSession: () => true,
        getCurrentMember: () => ({ id: 'me' }),
        broadcastObjectEvent: async () => true,
        updateObjects: async (updates, sequence) => {
            flushes.push(updates.map(update => update.objectId));
            return { versions: {}, memberSequence: sequence };
        },
        deleteObject: async () => ({ success: true, memberSequence: 1 }),
    };
}

/**
 * Drives `durationMs` of wall time through the production pipeline at a given
 * display refresh rate, with `objectCount` ballistic objects seeded at
 * staggered instants so their heartbeat phases start unrelated.
 *
 * rAF timestamp -> gameLoop -> ObjectSync.tick (flush quantizer)
 *                           -> fixed-step runSimulationStep -> send gate
 *
 * Frames are separated by a microtask drain because real rAF callbacks are
 * separate tasks: without it the first in-flight invoke would never settle and
 * ObjectSync would stay blocked behind its own backpressure.
 */
async function run({ displayHz, txMs, objectCount = 5, durationMs = 6000 }) {
    const transport = makeTransport();
    const ObjectSync = loadClassicModule('object-sync.js', 'ObjectSync', {
        window: { ASTERVOIDS_DEBUG: false },
        console,
        SessionClient: transport,
        AuthoritativeObject,
        signalR: { HubConnectionState: { Connected: 'Connected', Reconnecting: 'Reconnecting' } },
    });
    ObjectSync.init();
    ObjectSync.configure({ nominalFrameTime: txMs / 1000, deltaEncoding: false });

    let nowMs = 0;
    const gate = createBallisticGate({
        config: CONFIG,
        isDeterministic: () => true,
        nowMs: () => nowMs,
    });

    const objects = [];
    const sends = new Map();            // id -> [gate-approval instants]
    const game = { lastFrameTime: 0, connectionLost: false };
    const fixedStep = { accumulatorMs: 0, alpha: 0 };
    const { gameLoop } = loadInlineGameFunctions(['gameLoop'], {
        game,
        fixedStep,
        ObjectSync,
        CONFIG: { TARGET_FPS: 60 },
        MAX_SIM_STEPS_PER_FRAME: 5,
        MAX_ACCUMULATED_MS: 250,
        fpsTracker: { sample() {} },
        runFrameCallbacks() {},
        isSessionMode: () => true,
        isDeterministicMode: () => true,
        renderScene() {},
        requestAnimationFrame() {},
        runSimulationStep: () => {
            for (const object of objects) {
                object.x = (object.x + 0.001) % 1;       // pure coast: never a trigger
                if (gate.shouldSend(object.id, object)) {
                    sends.get(object.id).push(nowMs);
                    ObjectSync.updateObject(object.id, { x: object.x, y: object.y });
                }
            }
        },
    });

    const frameMs = 1000 / displayHz;
    for (let frame = 1; nowMs < durationMs; frame++) {
        nowMs = frame * frameMs;
        // Stagger creation so the objects' heartbeat phases start unrelated.
        if (objects.length < objectCount && nowMs >= objects.length * 37) {
            const id = `rock-${objects.length}`;
            objects.push(ballisticObject(id, objects.length / 10));
            sends.set(id, []);
            transport.handlers.onObjectCreated?.(
                {
                    id, handle: objects.length, version: 1,
                    data: { x: 0, y: 0.5 }, ownerMemberId: 'me',
                    creatorMemberId: 'me', scope: 'Session',
                },
                'me', objects.length, nowMs);
        }
        gameLoop(nowMs);
        await Promise.resolve();
        await Promise.resolve();
    }

    const flushes = transport.flushes.filter(batch => batch.length > 0);
    const batched = flushes.reduce((total, batch) => total + batch.length, 0);
    let maxStaleness = 0;
    for (const instants of sends.values()) {
        for (let i = 1; i < instants.length; i++) {
            maxStaleness = Math.max(maxStaleness, instants[i] - instants[i - 1]);
        }
    }
    return {
        flushesPerSecond: flushes.length / (durationMs / 1000),
        objectsPerFlush: batched / flushes.length,
        maxStaleness,
        objectCount,
    };
}

const REFRESH_RATES = [30, 60, 120, 144];

test('the flush rate no longer depends on the display refresh rate', async () => {
    // Before alignment an independently-phased deadline was serviced sooner on
    // a finer frame grid, so a 120Hz device emitted materially more packets
    // than a 30Hz device for identical gameplay. Aligned, the objects share one
    // deadline and ride one flush at every refresh rate.
    const results = [];
    for (const displayHz of REFRESH_RATES) {
        results.push({ displayHz, ...await run({ displayHz, txMs: 50 }) });
    }
    const rates = results.map(result => result.flushesPerSecond);
    const spread = Math.max(...rates) - Math.min(...rates);
    assert.ok(spread <= 0.5,
        `flush rate still varies with refresh rate: ${JSON.stringify(results)}`);
    for (const result of results) {
        assert.ok(result.flushesPerSecond <= 1000 / HEARTBEAT + 0.5,
            `${result.displayHz}Hz flushes faster than the heartbeat: ${result.flushesPerSecond}`);
    }
});

test('coalesced heartbeats amortise the envelope over the whole object set', async () => {
    for (const displayHz of REFRESH_RATES) {
        const result = await run({ displayHz, txMs: 50 });
        assert.ok(result.objectsPerFlush > result.objectCount * 0.8,
            `${displayHz}Hz batched only ${result.objectsPerFlush.toFixed(2)} objects/flush`);
    }
});

test('staleness stays inside the receiver dead-reckon clamp at every refresh rate', async () => {
    // 250/66.7 = 3.75 at 30Hz is the worst non-harmonic frame/heartbeat ratio,
    // and cellular-like TX budgets add a second quantization on top.
    for (const displayHz of REFRESH_RATES) {
        for (const txMs of [50, 100, 200]) {
            const { maxStaleness } = await run({ displayHz, txMs });
            assert.ok(maxStaleness <= 500,
                `${displayHz}Hz/TX${txMs}: ${maxStaleness}ms exceeds the clamp window`);
        }
    }
});
