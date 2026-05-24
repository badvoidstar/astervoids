/**
 * RegionProbe — measures and maintains per-region RTT for the local browser.
 *
 * Usage:
 *   await RegionProbe.init();         // Pulls region list from /api/regions, starts probing
 *   RegionProbe.getRtt('westus2')     // → ms (or null if not yet sampled)
 *   RegionProbe.getSelf()             // → RTT for the local region
 *   RegionProbe.getAllRegions()        // → [{ id, displayName, publicUrl, rttMs }]
 *   RegionProbe.getBestRegion()       // → { id, displayName, rttMs }
 *   RegionProbe.on('changed', cb)     // fires when any region's EMA changes by >5ms
 *
 * Architecture notes
 * ──────────────────
 * • Fully standalone; has no dependency on SignalR, SessionClient, or ObjectSync.
 * • RTT is measured via fetch(<region.publicUrl>/api/ping, { cache: 'no-store' }).
 *   For the local region (same origin) the URL is '/api/ping'.
 * • Uses an asymmetric EMA (spike α = 0.3, decay α = 0.1) for consistency with
 *   ObjectSync.updateSendRate.
 * • Re-probes every PROBE_INTERVAL_MS (default 15 s) and on visibilitychange.
 * • Probes pause when document.visibilityState === 'hidden'.
 * • Three samples are taken before the first EMA is published (avoids first-call
 *   DNS skew). Samples <1 ms or from non-204 responses are rejected as noise.
 */
'use strict';

const RegionProbe = (() => {
    // ── Constants ─────────────────────────────────────────────────────
    const PROBE_INTERVAL_MS      = 15_000;
    const PROBE_WARMUP_SAMPLES   = 3;
    const SPIKE_ALPHA            = 0.3;
    const DECAY_ALPHA            = 0.1;
    const CHANGE_THRESHOLD_MS    = 5;
    const MIN_RTT_MS             = 1;   // below this is loopback / proxy noise

    // ── State ─────────────────────────────────────────────────────────
    let _regions     = [];   // [{ id, displayName, publicUrl }]
    let _selfId      = '';
    let _rttMap      = {};   // { [regionId]: { ema: number|null, samples: number } }
    let _listeners   = [];
    let _timer       = null;
    let _initialized = false;

    // ── Event emitter (minimal) ───────────────────────────────────────
    function on(event, cb) {
        _listeners.push({ event, cb });
    }

    function _emit(event, data) {
        for (const l of _listeners) {
            if (l.event === event) {
                try { l.cb(data); } catch (err) {
                    console.warn('[RegionProbe] listener error:', err);
                }
            }
        }
    }

    // ── EMA update ────────────────────────────────────────────────────
    /**
     * Asymmetric EMA: rising edges (spikes) use SPIKE_ALPHA for fast reaction;
     * falling edges use DECAY_ALPHA so transient spikes don't permanently inflate
     * the estimate.
     */
    function _updateEma(prev, sample) {
        if (prev === null) return sample;
        const alpha = sample > prev ? SPIKE_ALPHA : DECAY_ALPHA;
        return prev + alpha * (sample - prev);
    }

    // ── Single probe ──────────────────────────────────────────────────
    async function _probe(region) {
        const url = region.publicUrl ? `${region.publicUrl}/api/ping` : '/api/ping';
        const t0 = performance.now();
        try {
            const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
            const rtt = performance.now() - t0;
            if (res.status !== 204 || rtt < MIN_RTT_MS) return null;
            return rtt;
        } catch (_) {
            return null;
        }
    }

    // ── Probe one region, update EMA ──────────────────────────────────
    async function _probeRegion(region) {
        const sample = await _probe(region);
        if (sample === null) return;

        const state = _rttMap[region.id] = _rttMap[region.id] || { ema: null, samples: 0 };
        state.samples++;

        // Warm-up: collect PROBE_WARMUP_SAMPLES before publishing the EMA
        if (state.samples < PROBE_WARMUP_SAMPLES) {
            state.ema = _updateEma(state.ema, sample);
            return;
        }

        const prev = state.ema;
        state.ema = _updateEma(state.ema === null ? sample : state.ema, sample);

        if (prev === null || Math.abs(state.ema - prev) >= CHANGE_THRESHOLD_MS) {
            _emit('changed', { regionId: region.id, rttMs: state.ema });
        }
    }

    // ── Probe all regions in parallel ────────────────────────────────
    async function _probeAll() {
        if (document.visibilityState === 'hidden') return;
        await Promise.all(_regions.map(_probeRegion));
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Initialise RegionProbe. Fetches /api/regions, then starts probing.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    async function init() {
        if (_initialized) return;
        _initialized = true;

        try {
            const res = await fetch('/api/regions', { cache: 'no-store' });
            if (!res.ok) throw new Error(`/api/regions returned ${res.status}`);
            const data = await res.json();
            _selfId  = data.self   || 'local';
            _regions = data.all    || [{ id: 'local', displayName: 'Local', publicUrl: '' }];
        } catch (err) {
            console.warn('[RegionProbe] Failed to load regions, using local fallback:', err);
            _selfId  = 'local';
            _regions = [{ id: 'local', displayName: 'Local', publicUrl: '' }];
        }

        // Initialise state map
        for (const r of _regions) {
            _rttMap[r.id] = { ema: null, samples: 0 };
        }

        // First probe
        await _probeAll();

        // Periodic re-probe
        _timer = setInterval(_probeAll, PROBE_INTERVAL_MS);

        // Re-probe on tab focus
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') _probeAll();
        });
    }

    /**
     * Returns the current EMA RTT (ms) for the given regionId, or null if not yet sampled.
     */
    function getRtt(regionId) {
        const state = _rttMap[regionId];
        return state ? state.ema : null;
    }

    /**
     * Returns the current EMA RTT for this instance's own region.
     */
    function getSelf() {
        return getRtt(_selfId);
    }

    /**
     * Returns the region ID for this instance.
     */
    function getSelfId() {
        return _selfId;
    }

    /**
     * Returns all regions as [{ id, displayName, publicUrl, rttMs }].
     */
    function getAllRegions() {
        return _regions.map(r => ({
            id: r.id,
            displayName: r.displayName,
            publicUrl: r.publicUrl,
            rttMs: getRtt(r.id)
        }));
    }

    /**
     * Returns the region with the lowest EMA RTT, or null if no samples yet.
     */
    function getBestRegion() {
        let best = null;
        for (const r of _regions) {
            const rtt = getRtt(r.id);
            if (rtt === null) continue;
            if (best === null || rtt < best.rttMs) {
                best = { id: r.id, displayName: r.displayName, publicUrl: r.publicUrl, rttMs: rtt };
            }
        }
        return best;
    }

    /**
     * Looks up the display name for a regionId. Falls back to the raw id.
     */
    function getDisplayName(regionId) {
        const r = _regions.find(r => r.id === regionId);
        return r ? r.displayName : regionId;
    }

    return { init, on, getRtt, getSelf, getSelfId, getAllRegions, getBestRegion, getDisplayName };
})();
