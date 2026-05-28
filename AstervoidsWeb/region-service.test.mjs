import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// region-service.js is a browser IIFE that conditionally exports as CommonJS
// when `module.exports` is available. Use createRequire so the .js file loads
// under Node without needing a wrapper.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const RegionService = require(resolve(here, 'wwwroot/js/region-service.js'));

const { initialRttState, applyBurstSample, pickBestRegion } = RegionService._internals;

// ─────────────────────────────────────────────────────────────────────────────
// initialRttState
// ─────────────────────────────────────────────────────────────────────────────

describe('initialRttState', () => {
    test('starts in warming state with no value or samples', () => {
        const s = initialRttState();
        assert.equal(s.state, 'warming',
            'new regions are warming until a real sample arrives — UI must NOT display them as best');
        assert.equal(s.valueMs, null);
        assert.equal(s.sampleCount, 0);
        assert.equal(s.confidence, 0);
        assert.equal(s.lastSampleAt, null);
    });
});

describe('RegionService browser export', () => {
    test('module attaches itself to window.RegionService when window is defined', () => {
        // Regression for the bug where picker code `if (window.RegionService)`
        // always evaluated false because top-level `const X = ...` in a
        // classic <script> is NOT attached to window — burst loop never
        // fired, picker stayed warming forever. The IIFE end of
        // region-service.js MUST set window.RegionService for the picker's
        // feature-detection idiom to work.
        const origWindow = globalThis.window;
        globalThis.window = globalThis.window || {};
        try {
            // Re-require to force the IIFE's window-attachment to run again.
            const path = resolve(here, 'wwwroot/js/region-service.js');
            delete require.cache[require.resolve(path)];
            const RS = require(path);
            assert.equal(typeof globalThis.window.RegionService, 'object',
                'window.RegionService must be set after region-service.js loads');
            assert.strictEqual(globalThis.window.RegionService, RS,
                'window.RegionService must be the same object that CommonJS exports');
            assert.equal(typeof globalThis.window.RegionService.load, 'function',
                'window.RegionService must expose the public API surface');
        } finally {
            globalThis.window = origWindow;
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyBurstSample — cold-start gating
// ─────────────────────────────────────────────────────────────────────────────

describe('applyBurstSample cold-start handling', () => {
    test('first sample above COLD_START_THRESHOLD_MS is treated as container start, not RTT', () => {
        const prev = initialRttState();
        const { next, coldStart } = applyBurstSample(prev, 4200, 1700000000000);
        assert.equal(coldStart, true,
            'a >1500ms first sample is container start-up — must signal coldStart so picker can show "Warming up…"');
        assert.equal(next.state, 'warming',
            'after a cold-start sample, region stays warming until a real (sub-threshold) sample arrives');
        assert.equal(next.valueMs, null, 'cold-start sample must NOT pollute the EMA');
        assert.equal(next.sampleCount, 0, 'cold-start sample is not counted toward confidence');
        assert.equal(next.lastSampleAt, 1700000000000, 'lastSampleAt is still recorded so we know we tried');
    });

    test('first sample below threshold seeds EMA and transitions to measuring', () => {
        const prev = initialRttState();
        const { next, coldStart } = applyBurstSample(prev, 47, 1700000000000);
        assert.equal(coldStart, false);
        assert.equal(next.state, 'measuring',
            'first valid sample advances out of warming so the region becomes pickable as best');
        assert.equal(next.valueMs, 47);
        assert.equal(next.sampleCount, 1);
        assert.equal(next.confidence, 0.1, 'confidence ramps as samples/10 (1/10 = 0.1 after first sample)');
    });

    test('only the FIRST sample is gated by COLD_START_THRESHOLD_MS', () => {
        // Once a real sample landed, a transient spike (e.g. mid-burst stall)
        // should still feed the EMA — it's part of the latency distribution.
        // We just don't want the very first wake-up cycle to be displayed as RTT.
        let prev = initialRttState();
        prev = applyBurstSample(prev, 42, 1700000000000).next;
        const { next, coldStart } = applyBurstSample(prev, 2500, 1700000005000);
        assert.equal(coldStart, false,
            'after first measurement, no sample is ever rejected as cold-start');
        assert.notEqual(next.valueMs, prev.valueMs, 'EMA must update');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyBurstSample — EMA convergence
// ─────────────────────────────────────────────────────────────────────────────

describe('applyBurstSample EMA convergence', () => {
    test('EMA with α=0.3 smooths noisy samples toward the true mean', () => {
        // True latency ≈ 50ms with ±20ms jitter. After enough samples the EMA
        // should land within a few ms of 50, even though individual samples
        // never sit exactly there. This is the property the UI relies on:
        // the displayed value is stable even while raw measurements vary.
        let state = initialRttState();
        const samples = [70, 32, 58, 41, 65, 36, 52, 49, 61, 40, 55, 47, 53, 48, 51];
        for (const s of samples) {
            state = applyBurstSample(state, s, Date.now()).next;
        }
        assert.ok(Math.abs(state.valueMs - 50) < 10,
            `EMA settled at ${state.valueMs.toFixed(1)}ms — expected within 10ms of true 50ms mean`);
    });

    test('confidence advances monotonically and caps at 1', () => {
        let state = initialRttState();
        let prevConfidence = 0;
        for (let i = 0; i < 20; i++) {
            state = applyBurstSample(state, 50, Date.now()).next;
            assert.ok(state.confidence >= prevConfidence,
                `confidence regressed from ${prevConfidence} to ${state.confidence} at sample ${i}`);
            assert.ok(state.confidence <= 1, `confidence exceeded 1: ${state.confidence}`);
            prevConfidence = state.confidence;
        }
        assert.equal(state.confidence, 1,
            'after 10+ samples, confidence is fully ramped — UI shows solid settling indicator');
        assert.equal(state.state, 'settled');
    });

    test('state transitions warming → measuring → settled', () => {
        let state = initialRttState();
        assert.equal(state.state, 'warming');

        state = applyBurstSample(state, 60, Date.now()).next;
        assert.equal(state.state, 'measuring',
            'after first valid sample, state advances so bestRegion() considers this region');

        // Drive confidence to 1 (need 10 total samples since CONFIDENCE_FULL_AFTER_SAMPLES=10).
        for (let i = 0; i < 9; i++) {
            state = applyBurstSample(state, 60, Date.now()).next;
        }
        assert.equal(state.state, 'settled',
            'after CONFIDENCE_FULL_AFTER_SAMPLES (10) samples, state is settled');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickBestRegion — hysteresis + warming exclusion
// ─────────────────────────────────────────────────────────────────────────────

describe('pickBestRegion', () => {
    function mapOf(entries) {
        return new Map(entries);
    }
    function measuredAt(valueMs, confidence = 1) {
        return { valueMs, confidence, sampleCount: 10, lastSampleAt: Date.now(), state: 'settled' };
    }

    test('returns null when every region is still warming', () => {
        const m = mapOf([
            ['westus2', initialRttState()],
            ['eastus', initialRttState()],
        ]);
        assert.equal(pickBestRegion(m, null), null,
            'before any measurements land, no region can be recommended — UI defers Create button');
    });

    test('warming regions are never picked, even when other regions exist', () => {
        const m = mapOf([
            ['westus2', initialRttState()],            // warming
            ['eastus', measuredAt(120)],
        ]);
        assert.equal(pickBestRegion(m, null), 'eastus',
            'warming region was never measured — choosing it would mislead the user');
    });

    test('lowest EMA wins amongst measured regions', () => {
        const m = mapOf([
            ['westus2', measuredAt(40)],
            ['eastus', measuredAt(120)],
            ['westeurope', measuredAt(80)],
        ]);
        assert.equal(pickBestRegion(m, null), 'westus2');
    });

    test('hysteresis prevents flapping between near-tie regions', () => {
        // BEST_REGION_HYSTERESIS_MS defaults to 10. westus2 is currently best.
        // eastus is 5ms lower — NOT enough to trigger a switch.
        const m = mapOf([
            ['westus2', measuredAt(50)],
            ['eastus', measuredAt(45)],
        ]);
        assert.equal(pickBestRegion(m, 'westus2'), 'westus2',
            '5ms advantage is below 10ms hysteresis — must NOT switch best region');
    });

    test('hysteresis is crossed once advantage exceeds threshold', () => {
        const m = mapOf([
            ['westus2', measuredAt(50)],
            ['eastus', measuredAt(35)],  // 15ms lower — crosses hysteresis
        ]);
        assert.equal(pickBestRegion(m, 'westus2'), 'eastus',
            'a 15ms advantage crosses the 10ms hysteresis threshold — switch best region');
    });

    test('previous best falling into warming releases the hysteresis lock', () => {
        // If a previous best region's state regresses to warming (e.g. connection
        // dropped and it was reset), the hysteresis lock shouldn't pin it.
        const warmingPrev = initialRttState();
        const m = mapOf([
            ['westus2', warmingPrev],   // previous best, now warming
            ['eastus', measuredAt(80)],
        ]);
        assert.equal(pickBestRegion(m, 'westus2'), 'eastus',
            'previous best is no longer measurable — must release the lock and pick the next best');
    });

    test('ties broken by higher confidence', () => {
        const m = mapOf([
            ['a', { valueMs: 50, confidence: 0.5, sampleCount: 5, lastSampleAt: 0, state: 'measuring' }],
            ['b', { valueMs: 50, confidence: 1.0, sampleCount: 10, lastSampleAt: 0, state: 'settled' }],
        ]);
        assert.equal(pickBestRegion(m, null), 'b',
            'equal EMAs broken by confidence — prefer the more-measured region');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: load + start with stubbed fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('RegionService load + bootstrap burst (stubbed fetch)', () => {
    // Reusable fetch stub: maps URL substrings to either a JSON body or a delay.
    function installFetchStub(responses) {
        const originalFetch = globalThis.fetch;
        const originalPerf = globalThis.performance;
        const originalDocument = globalThis.document;

        let now = 1_000_000;
        globalThis.performance = { now: () => now };
        globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
        const callLog = [];

        globalThis.fetch = async (url, init) => {
            callLog.push(url);
            for (const [match, handler] of responses) {
                if (!url.includes(match)) continue;
                const { body, delayMs, ok = true, status = 200 } = await handler(url, init);
                if (delayMs) now += delayMs;
                return {
                    ok,
                    status,
                    json: async () => body,
                    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
                };
            }
            throw new Error(`fetch stub: no handler matched URL ${url}`);
        };

        return () => {
            globalThis.fetch = originalFetch;
            globalThis.performance = originalPerf;
            globalThis.document = originalDocument;
        };
    }

    test('load() populates regions and initial RTT state per region', async () => {
        const restore = installFetchStub([
            ['/api/regions', async () => ({
                body: {
                    regionId: 'westus2',
                    displayName: 'US West',
                    regions: [
                        { id: 'westus2', displayName: 'US West', hostname: 'https://a.example.com/' },
                        { id: 'eastus', displayName: 'US East', hostname: 'https://b.example.com' },
                    ],
                },
            })],
        ]);
        try {
            await RegionService.load();
            const regions = RegionService.getRegions();
            assert.equal(regions.length, 2);
            assert.equal(regions[0].hostname, 'https://a.example.com',
                'trailing slash on configured hostname must be normalised — otherwise burst URLs double-slash');
            assert.equal(RegionService.getLocalRegionId(), 'westus2');
            assert.equal(RegionService.getRtt('westus2').state, 'warming',
                'load() initialises every region in warming state');
            assert.equal(RegionService.bestRegion(), null,
                'no region is pickable before measurements land');
        } finally {
            RegionService.stop();
            restore();
        }
    });

    test('load() prefers window-injected bootstrap manifest over /api/regions fetch', async () => {
        const originalFetch = globalThis.fetch;
        const originalWindow = globalThis.window;
        globalThis.fetch = async () => {
            throw new Error('fetch must not be called when bootstrap manifest is injected');
        };
        globalThis.window = {
            ...(originalWindow || {}),
            ASTERVOIDS_REGION_BOOTSTRAP: {
                regionId: null,
                displayName: null,
                regions: [
                    { id: 'westus2', displayName: 'US West', hostname: 'https://asteroids-westus2.example.com/' },
                    { id: 'northeurope', displayName: 'Europe', hostname: 'https://asteroids-northeurope.example.com' },
                ],
            },
        };
        try {
            await RegionService.load();
            const regions = RegionService.getRegions();
            assert.equal(regions.length, 2);
            assert.equal(regions[0].hostname, 'https://asteroids-westus2.example.com',
                'bootstrap hostnames are normalised the same as /api/regions payloads');
            assert.equal(RegionService.getLocalRegionId(), null,
                'static apex is not itself a gameplay region, so regionId can remain null');
        } finally {
            RegionService.stop();
            globalThis.fetch = originalFetch;
            globalThis.window = originalWindow;
        }
    });

    test('bootstrap burst feeds EMA and advances state out of warming', async () => {
        // 1 warm-up sample (discarded) + 2 measured samples = burst. Stub returns
        // a consistent ~50ms latency by advancing the fake clock between t0
        // and the fetch resolution.
        let pingCount = 0;
        const restore = installFetchStub([
            ['/api/regions', async () => ({
                body: {
                    regionId: 'r1',
                    displayName: 'Region 1',
                    regions: [{ id: 'r1', displayName: 'Region 1', hostname: 'https://r1.example.com' }],
                },
            })],
            ['/api/ping', async () => {
                pingCount++;
                return { body: { now: Date.now() }, delayMs: 50 };
            }],
        ]);
        try {
            // Force a deterministic bootstrap (no stagger) and a tight test config.
            RegionService._configure({ BURST_STAGGER_MAX_MS: 0, BURST_INTERVAL_MS: 60_000 });
            await RegionService.load();
            const rttUpdates = [];
            RegionService.on('rttUpdated', id => rttUpdates.push(id));
            RegionService.start();
            // Yield until burst completes: 3 pings, each awaiting one microtask cycle.
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.ok(pingCount >= 3, `expected at least 3 pings (1 warm-up + 2 measured), got ${pingCount}`);
            const rtt = RegionService.getRtt('r1');
            assert.notEqual(rtt.state, 'warming',
                'after a successful bootstrap burst, region must leave warming so picker can recommend it');
            assert.equal(rtt.valueMs, 50, 'EMA seeded with the burst minimum (50ms)');
            assert.deepEqual(rttUpdates, ['r1'], 'rttUpdated emitted exactly once per burst');
        } finally {
            RegionService.stop();
            restore();
        }
    });

    test('cold-start sample emits coldStart event and leaves region warming', async () => {
        const restore = installFetchStub([
            ['/api/regions', async () => ({
                body: {
                    regionId: 'r1',
                    displayName: 'Region 1',
                    regions: [{ id: 'r1', displayName: 'Region 1', hostname: 'https://r1.example.com' }],
                },
            })],
            // Warm-up sample fine (250ms), first MEASURED sample looks like cold-start (3000ms),
            // second measured sample also high — but only the first sample is gated.
            ['/api/ping', async () => ({ body: { now: Date.now() }, delayMs: 3000 })],
        ]);
        try {
            RegionService._configure({ BURST_STAGGER_MAX_MS: 0, BURST_INTERVAL_MS: 60_000 });
            await RegionService.load();
            const coldEvents = [];
            RegionService.on('coldStart', id => coldEvents.push(id));
            RegionService.start();
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.deepEqual(coldEvents, ['r1'],
                'first measured sample >1500ms must emit coldStart so picker can show "Warming up…"');
            const rtt = RegionService.getRtt('r1');
            assert.equal(rtt.state, 'warming',
                'cold-start sample must NOT advance state — region stays warming until a real sample arrives');
            assert.equal(rtt.valueMs, null, 'EMA must NOT be polluted by container start-up time');
        } finally {
            RegionService.stop();
            restore();
        }
    });

    test('stop() halts burst loop and detaches visibility listener', async () => {
        const restore = installFetchStub([
            ['/api/regions', async () => ({
                body: {
                    regionId: 'r1',
                    displayName: 'Region 1',
                    regions: [{ id: 'r1', displayName: 'Region 1', hostname: 'https://r1.example.com' }],
                },
            })],
            ['/api/ping', async () => ({ body: { now: Date.now() }, delayMs: 20 })],
        ]);
        try {
            RegionService._configure({ BURST_STAGGER_MAX_MS: 0, BURST_INTERVAL_MS: 50 });
            await RegionService.load();
            RegionService.start();
            RegionService.stop();
            const beforeWait = RegionService.getRtt('r1').sampleCount;
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(RegionService.getRtt('r1').sampleCount, beforeWait,
                'after stop() no further bursts may run');
        } finally {
            RegionService.stop();
            restore();
        }
    });

    test('empty regions manifest synthesizes a self-pointing entry from window.location.origin', async () => {
        // Single-region prod + branch deploys serve /api/regions with an
        // empty regions array (default RegionSettings.Regions=[]). Without
        // synthesis the picker would show '🔥 Warming…' forever because no
        // region exists to ping. The synthesis uses window.location.origin
        // so RegionService measures RTT against the current page's server.
        const restore = installFetchStub([
            ['/api/regions', async () => ({
                body: {
                    regionId: 'local',
                    displayName: 'Local',
                    regions: [],  // ← empty: triggers fallback
                },
            })],
            ['/api/ping', async () => ({ body: { now: Date.now() }, delayMs: 30 })],
        ]);
        // Stub window.location.origin so the synthesis branch fires.
        const origWindow = globalThis.window;
        globalThis.window = { ...(origWindow || {}), location: { origin: 'https://my-app.example.com' } };
        try {
            RegionService._configure({ BURST_STAGGER_MAX_MS: 0, BURST_INTERVAL_MS: 60_000 });
            await RegionService.load();
            const regions = RegionService.getRegions();
            assert.equal(regions.length, 1,
                'empty manifest must synthesize exactly one self-pointing region — otherwise the picker is stuck warming forever');
            assert.equal(regions[0].id, 'local', 'synthesised region inherits the server-stamped regionId');
            assert.equal(regions[0].hostname, 'https://my-app.example.com',
                'synthesised hostname comes from window.location.origin so RTT measures against the current server');

            // Verify the synthesis produces a working measurement path
            // — start() must NOT throw "no regions configured", and a
            // burst against the synthetic host must populate RTT state.
            RegionService.start();
            await new Promise(r => setTimeout(r, 50));
            const rtt = RegionService.getRtt('local');
            assert.notEqual(rtt.state, 'warming',
                'after first burst against the synthetic host, state must advance out of warming');
        } finally {
            RegionService.stop();
            globalThis.window = origWindow;
            restore();
        }
    });

    test('empty regions manifest WITHOUT window.location leaves regions empty (Node / SSR safe)', async () => {
        // The synthesis is browser-only — defensive guard so the module
        // remains safe to require in Node tests / SSR contexts where
        // window.location may not exist.
        const restore = installFetchStub([
            ['/api/regions', async () => ({
                body: { regionId: 'local', displayName: 'Local', regions: [] },
            })],
        ]);
        const origWindow = globalThis.window;
        globalThis.window = { /* deliberately no location */ };
        try {
            await RegionService.load();
            assert.equal(RegionService.getRegions().length, 0,
                'without window.location the synthesis is skipped — start() then throws, picker falls back to legacy single-region SignalR');
        } finally {
            globalThis.window = origWindow;
            restore();
        }
    });
});
