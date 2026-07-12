/**
 * Region Service Module
 *
 * Discovers peer regions and progressively measures RTT to each so the session
 * picker can show every visitor where every session lives and how reachable
 * each region is for them right now.
 *
 * ## Measurement model
 *
 * Each region has its own measurement state. New regions start in `'warming'`
 * because the corresponding Container Apps instance may have scaled to zero
 * (see `infra/main.bicep`) and the first request to wake it can take several
 * seconds — that wall-clock cost is container start-up, not network RTT, so
 * we deliberately exclude it from the displayed value.
 *
 * For each region we:
 *
 *   1. Issue a **bootstrap burst** of 3 back-to-back `GET /api/ping` requests
 *      to that region's hostname immediately on `start()`. The first request
 *      is the warm-up sample — discarded because it includes TLS handshake
 *      and CORS preflight setup that polluted RTT measurements in the
 *      existing `clock-offset.test.mjs` work.
 *   2. If the first valid (post-warm-up) sample is > `COLD_START_THRESHOLD_MS`
 *      (1500 ms), emit `coldStart(regionId)`, leave the region in `'warming'`
 *      state, and DO NOT feed the sample into the smoothing window — it is a
 *      cold-start measurement, not RTT.
 *   3. Subsequent **rolling bursts** fire every `BURST_INTERVAL_MS` (5000 ms),
 *      staggered per region by a random initial offset to avoid synchronised
 *      bursts hammering the network.
 *   4. Each burst's minimum sample (jitter rejection) is fed into an
 *      exponential moving average with smoothing factor `EMA_ALPHA` (0.3).
 *      The displayed value is the EMA — stable across single-burst outliers.
 *   5. `confidence` ramps from 0 to 1 as more bursts land
 *      (`min(1, sampleCount / CONFIDENCE_FULL_AFTER_SAMPLES)`), so the picker
 *      can show a "settling" indicator that visibly converges.
 *
 * ## `bestRegion()`
 *
 * Returns the region with the lowest EMA RTT amongst regions whose state is
 * NOT `'warming'`. Warming regions are never picked because their true RTT
 * is unknown and they would otherwise appear deceptively attractive (a NaN
 * EMA sorts ambiguously). A 10 ms hysteresis prevents oscillation when two
 * regions have near-identical RTT.
 *
 * ## Visibility gating
 *
 * While `document.hidden`, burst timers are paused — backgrounded tabs must
 * NOT keep regions warm (would defeat the CAE scale-to-zero requirement).
 * On `visibilitychange`-back, one immediate burst fires per region so the
 * picker is fresh by the time the user is looking.
 */

const RegionService = (function () {
    // ── Tunables (overridable for tests) ──────────────────────────────────────
    const CONFIG = {
        BOOTSTRAP_SAMPLES: 3,           // pings in the initial burst (1 warm-up + 2 measured)
        ROLLING_SAMPLES: 3,             // pings in each rolling burst
        BURST_INTERVAL_MS: 5000,        // base interval between bursts per region
        BURST_STAGGER_MAX_MS: 1000,     // random offset per region so bursts don't align
        WARM_PING_TIMEOUT_MS: 5000,     // per-request timeout for warm regions
        COLD_PING_TIMEOUT_MS: 15000,    // per-request timeout for first ping (cold-start budget)
        COLD_START_THRESHOLD_MS: 1500,  // samples above this on first measurement are container start, not RTT
        EMA_ALPHA: 0.3,                 // smoothing factor for displayed RTT
        CONFIDENCE_FULL_AFTER_SAMPLES: 10,
        BEST_REGION_HYSTERESIS_MS: 10,  // prevent best-region flapping on near-tie
        REGIONS_ENDPOINT: '/api/regions',
        PING_PATH: '/api/ping',
    };

    // ── State ─────────────────────────────────────────────────────────────────
    const regions = [];        // [{id, displayName, hostname}, ...]
    let localRegionId = null;  // id of the region we landed on
    const rtt = new Map();     // regionId -> {valueMs, confidence, sampleCount, lastSampleAt, state}
    const burstTimers = new Map();  // regionId -> timeout handle
    const burstSequences = new Map();
    let currentBestRegion = null;   // memoised, recomputed only when bestRegion() advantage exceeds hysteresis
    let started = false;
    let runGeneration = 0;
    let loadGeneration = 0;
    let visibilityHandler = null;

    // ── Event bus (mirrors session-client.js shape) ───────────────────────────
    const listeners = {
        rttUpdated: new Set(),
        coldStart: new Set(),
        regionsLoaded: new Set(),
    };

    function emit(event, ...args) {
        const set = listeners[event];
        if (!set) return;
        for (const fn of set) {
            try { fn(...args); } catch (e) { console.error('[RegionService]', event, e); }
        }
    }

    function on(event, fn) {
        if (!listeners[event]) throw new Error(`Unknown RegionService event: ${event}`);
        listeners[event].add(fn);
        return () => listeners[event].delete(fn);
    }

    // ── Pure measurement helpers (exported for tests) ─────────────────────────

    /**
     * Initial per-region state. `state === 'warming'` until a real (non-cold-start)
     * sample lands; UI shows `Warming up…` and never picks this region as best.
     */
    function initialRttState() {
        return {
            valueMs: null,
            confidence: 0,
            sampleCount: 0,
            lastSampleAt: null,
            state: 'warming',
        };
    }

    /**
     * Fold a fresh burst-minimum into a region's measurement state.
     *
     * - FIRST attempt only, sample > COLD_START_THRESHOLD_MS → treated as
     *   container wake-up: sample is discarded, state stays warming, returns
     *   {state, coldStart: true}. `lastSampleAt` is stamped so the suppression
     *   fires AT MOST ONCE.
     * - `state === 'warming'` and sample ≤ threshold → first real RTT; state
     *   advances to `'measuring'`, EMA seeded with the sample.
     * - Otherwise → EMA-update displayed value; advance to `'settled'` once
     *   confidence reaches 1.
     *
     * Pure function: takes the previous state and a sample, returns next state.
     */
    function applyBurstSample(prev, sampleMs, nowMs, cfg = CONFIG) {
        // Cold-start guard: fires AT MOST ONCE, on the genuine first measurement
        // attempt (lastSampleAt == null), to absorb container wake-up latency.
        //
        // Keying the guard only on `sampleCount === 0` was a bug: a cold-start
        // sample is intentionally NOT counted (sampleCount stays 0), so the
        // guard re-fired on every following sample. Any region whose real RTT
        // is consistently above COLD_START_THRESHOLD_MS — a geographically
        // distant region, or *every* region on a slow/mobile link — had each
        // sample discarded as "container start" and was stuck 'warming' forever.
        // Once we've recorded one attempt, later slow samples are honest RTT.
        if (prev.sampleCount === 0 && prev.lastSampleAt == null && sampleMs > cfg.COLD_START_THRESHOLD_MS) {
            return {
                next: { ...prev, lastSampleAt: nowMs },  // record attempt without polluting EMA
                coldStart: true,
            };
        }

        const nextSampleCount = prev.sampleCount + 1;
        const ema = prev.valueMs == null
            ? sampleMs
            : prev.valueMs + cfg.EMA_ALPHA * (sampleMs - prev.valueMs);
        const confidence = Math.min(1, nextSampleCount / cfg.CONFIDENCE_FULL_AFTER_SAMPLES);
        const state = confidence >= 1 ? 'settled' : 'measuring';

        return {
            next: {
                valueMs: ema,
                confidence,
                sampleCount: nextSampleCount,
                lastSampleAt: nowMs,
                state,
            },
            coldStart: false,
        };
    }

    /**
     * Pick the region id with the lowest EMA RTT amongst non-warming regions,
     * preserving the previous best unless a candidate beats it by at least
     * `BEST_REGION_HYSTERESIS_MS`. Tied EMAs are broken by higher confidence.
     *
     * Returns null when no region is measurable yet (all warming).
     */
    function pickBestRegion(rttMap, previousBest, cfg = CONFIG) {
        const candidates = [];
        for (const [id, s] of rttMap.entries()) {
            if (s.state === 'warming' || s.valueMs == null) continue;
            candidates.push({ id, value: s.valueMs, confidence: s.confidence });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.value - b.value || b.confidence - a.confidence);
        const best = candidates[0];
        if (previousBest == null) return best.id;
        const prev = rttMap.get(previousBest);
        if (!prev || prev.state === 'warming' || prev.valueMs == null) return best.id;
        if (prev.valueMs - best.value >= cfg.BEST_REGION_HYSTERESIS_MS) return best.id;
        return previousBest;
    }

    // ── Network I/O ───────────────────────────────────────────────────────────

    /**
     * Single ping with timeout. Returns elapsed ms (using performance.now() so
     * the measurement is immune to wall-clock slewing) or rejects on
     * timeout / non-OK response. Cache-busting query param defeats anything
     * upstream that might cache the response.
     */
    async function pingOnce(hostname, timeoutMs) {
        const url = `${hostname.replace(/\/$/, '')}${CONFIG.PING_PATH}?_=${performance.now()}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const t0 = performance.now();
        try {
            const res = await fetch(url, {
                method: 'GET',
                cache: 'no-store',
                mode: 'cors',
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`ping ${url} → ${res.status}`);
            await res.text();  // drain body so the connection is reusable
            return performance.now() - t0;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Fire a burst of N pings to a region, return the minimum elapsed time
     * (jitter rejection — matches clock-offset.test.mjs philosophy). When
     * `discardFirst` is true, the first sample is treated as warm-up and
     * excluded from the min. Failed pings reduce the burst size; if all fail,
     * returns null.
     */
    async function measureBurst(hostname, samples, timeoutMs, discardFirst) {
        const times = [];
        for (let i = 0; i < samples; i++) {
            try {
                const ms = await pingOnce(hostname, timeoutMs);
                if (i === 0 && discardFirst) continue;
                times.push(ms);
            } catch (_) {
                // Individual ping failure ignored — only an all-failed burst returns null.
            }
        }
        if (times.length === 0) return null;
        return Math.min(...times);
    }

    // ── Per-region burst loop ─────────────────────────────────────────────────

    function scheduleNextBurst(regionId, delayMs, generation) {
        if (!started || generation !== runGeneration) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        clearBurstTimer(regionId);
        const handle = setTimeout(
            () => runBurst(regionId, false, generation),
            delayMs);
        burstTimers.set(regionId, handle);
    }

    function clearBurstTimer(regionId) {
        const h = burstTimers.get(regionId);
        if (h != null) clearTimeout(h);
        burstTimers.delete(regionId);
    }

    function clearAllBurstTimers() {
        for (const id of Array.from(burstTimers.keys())) clearBurstTimer(id);
    }

    async function runBurst(regionId, isBootstrap, generation) {
        if (!started || generation !== runGeneration) return;
        const burstSequence = (burstSequences.get(regionId) ?? 0) + 1;
        burstSequences.set(regionId, burstSequence);
        const region = regions.find(r => r.id === regionId);
        if (!region) return;
        const prev = rtt.get(regionId) ?? initialRttState();
        const isFirstSample = prev.sampleCount === 0;
        // Cold-start budget only for the very first attempt against this region.
        const timeoutMs = isFirstSample ? CONFIG.COLD_PING_TIMEOUT_MS : CONFIG.WARM_PING_TIMEOUT_MS;
        const samples = isBootstrap ? CONFIG.BOOTSTRAP_SAMPLES : CONFIG.ROLLING_SAMPLES;
        const min = await measureBurst(region.hostname, samples, timeoutMs, /*discardFirst=*/isFirstSample);
        if (!started
            || generation !== runGeneration
            || burstSequences.get(regionId) !== burstSequence) return;

        if (min == null) {
            // All pings in the burst failed — surface as a measurement attempt without state change,
            // then reschedule.
            scheduleNextBurst(regionId, CONFIG.BURST_INTERVAL_MS, generation);
            return;
        }

        const { next, coldStart } = applyBurstSample(prev, min, Date.now());
        rtt.set(regionId, next);
        if (coldStart) emit('coldStart', regionId);
        emit('rttUpdated', regionId);

        // bestRegion memo refresh — recompute whenever any region's EMA moves.
        const newBest = pickBestRegion(rtt, currentBestRegion);
        if (newBest !== currentBestRegion) currentBestRegion = newBest;

        scheduleNextBurst(regionId, CONFIG.BURST_INTERVAL_MS, generation);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function getWindowBootstrap() {
        if (typeof window === 'undefined') return null;
        const b = window.ASTERVOIDS_REGION_BOOTSTRAP;
        if (!b || !Array.isArray(b.regions) || b.regions.length === 0) return null;
        return b;
    }

    /**
     * Fetch the region manifest (or use injected bootstrap data) and initialise
     * per-region state. Does NOT start measurements — call `start()` for that.
     * Calling `load()` again replaces the manifest atomically.
     *
     * Backward compatible signatures:
     *   - load()                    -> same-origin /api/regions (or window bootstrap)
     *   - load('https://origin')    -> fetch from override origin + /api/regions
     *   - load({ bootstrap, originOverride })
     */
    async function load(options) {
        const generation = ++loadGeneration;
        const opts = (typeof options === 'string')
            ? { originOverride: options }
            : (options || {});
        const body = opts.bootstrap
            ? {
                regionId: opts.bootstrap.regionId ?? null,
                displayName: opts.bootstrap.displayName ?? null,
                regions: opts.bootstrap.regions ?? [],
            }
            : (getWindowBootstrap() || await (async () => {
                const url = (opts.originOverride ?? '') + CONFIG.REGIONS_ENDPOINT;
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
                return res.json();
            })());
        if (generation !== loadGeneration) return;

        if (started) {
            clearAllBurstTimers();
            runGeneration++;
        }

        regions.length = 0;
        for (const r of body.regions ?? []) {
            regions.push({
                id: r.id,
                displayName: r.displayName,
                hostname: (r.hostname ?? '').replace(/\/$/, ''),
            });
        }
        localRegionId = body.regionId ?? null;

        // Single-region fallback: when the server's manifest is empty
        // (RegionSettings.Regions=[] — the default in appsettings.json,
        // which is also what single-region prod + branch deploys see),
        // synthesize a self-pointing entry using window.location.origin.
        // Without this the picker would show '🔥 Warming…' forever for
        // every session because no region exists to ping.
        if (regions.length === 0 && typeof window !== 'undefined' && window.location && window.location.origin) {
            const synthId = localRegionId || 'local';
            regions.push({
                id: synthId,
                displayName: body.displayName || 'Local',
                hostname: window.location.origin,
            });
        }

        // Reset measurement state to 'warming' for every region.
        rtt.clear();
        for (const r of regions) rtt.set(r.id, initialRttState());
        currentBestRegion = null;
        emit('regionsLoaded', { regions: [...regions], localRegionId });

        if (started) {
            const generation = runGeneration;
            for (const region of regions) {
                const stagger = Math.floor(Math.random() * CONFIG.BURST_STAGGER_MAX_MS);
                const handle = setTimeout(
                    () => runBurst(region.id, true, generation),
                    stagger);
                burstTimers.set(region.id, handle);
            }
        }
    }

    /**
     * Begin per-region burst loops. Bootstrap burst per region fires immediately
     * (staggered by a small random offset so concurrent fetches don't pile up).
     * Calling `start()` while already started is a no-op.
     */
    function start() {
        if (started) return;
        if (regions.length === 0) {
            throw new Error('RegionService.start() called before load() (no regions configured)');
        }
        started = true;
        const generation = ++runGeneration;
        for (const r of regions) {
            const stagger = Math.floor(Math.random() * CONFIG.BURST_STAGGER_MAX_MS);
            const handle = setTimeout(
                () => runBurst(r.id, true, generation),
                stagger);
            burstTimers.set(r.id, handle);
        }
        // Visibility gating: closing burst timers on hide ensures backgrounded
        // tabs don't keep regions warm and defeat CAE scale-to-zero.
        if (typeof document !== 'undefined' && visibilityHandler == null) {
            visibilityHandler = () => {
                if (!started) return;
                if (document.hidden) {
                    clearAllBurstTimers();
                } else {
                    // Immediate burst per region so the picker is fresh by the
                    // time the user is looking, then resume the normal cadence.
                    for (const r of regions) {
                        if (!burstTimers.has(r.id)) {
                            const generation = runGeneration;
                            const handle = setTimeout(
                                () => runBurst(r.id, false, generation),
                                0);
                            burstTimers.set(r.id, handle);
                        }
                    }
                }
            };
            document.addEventListener('visibilitychange', visibilityHandler);
        }
    }

    /**
     * Stop all burst loops and detach the visibility listener. Does NOT clear
     * the manifest or accumulated measurements so `start()` can resume cleanly.
     */
    function stop() {
        started = false;
        runGeneration++;
        clearAllBurstTimers();
        if (typeof document !== 'undefined' && visibilityHandler != null) {
            document.removeEventListener('visibilitychange', visibilityHandler);
            visibilityHandler = null;
        }
    }

    /** Returns the measured RTT state for a region (or initial state). */
    function getRtt(regionId) {
        return rtt.get(regionId) ?? initialRttState();
    }

    /** Returns the region with the lowest EMA RTT (with hysteresis), or null. */
    function bestRegion() {
        return currentBestRegion;
    }

    /** Returns the canonical region manifest as loaded from /api/regions. */
    function getRegions() {
        return [...regions];
    }

    /** Returns the id of the region serving this client's origin. */
    function getLocalRegionId() {
        return localRegionId;
    }

    // Test hook — allows tests to override CONFIG values without re-importing.
    function _configure(overrides) {
        Object.assign(CONFIG, overrides);
    }

    // Test hook — pure functions exported for unit testing without network I/O.
    const _internals = {
        initialRttState,
        applyBurstSample,
        pickBestRegion,
        measureBurst,
        pingOnce,
        CONFIG,
    };

    return {
        load,
        start,
        stop,
        on,
        getRtt,
        bestRegion,
        getRegions,
        getLocalRegionId,
        _configure,
        _internals,
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RegionService;
}

// Browser: attach to window so the picker (which uses `window.RegionService`
// as a feature-detection idiom) can reach the IIFE result. Top-level
// `const X = ...` in a classic <script> is NOT attached to window — it's
// only accessible by bare name from sibling scripts via the script-level
// lexical scope. Explicit window assignment makes the module reachable
// either way.
if (typeof window !== 'undefined') {
    window.RegionService = RegionService;
}
