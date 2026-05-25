/**
 * RegionProbe — measures and maintains per-region RTT for the local browser.
 *
 * Usage:
 *   await RegionProbe.init();          // Pulls region list from /api/regions, starts probing
 *   RegionProbe.getRtt('westus2')      // → ms (or null if not yet sampled)
 *   RegionProbe.getSelf()              // → RTT for the local region
 *   RegionProbe.getAllRegions()        // → [{ id, displayName, publicUrl, rttMs, intervalMs, health }]
 *   RegionProbe.getBestRegion()        // → { id, displayName, rttMs }
 *   RegionProbe.getRegionHealth(id)    // → 'ok' | 'twitchy' | 'unhealthy' | 'unknown'
 *   RegionProbe.on('changed', cb)      // cb({ changedRegionIds, regionId })
 *   RegionProbe.on('unhealthy', cb)    // cb(regionId)
 *
 * Cadence ladder (per-region, independent timers)
 * ─────────────────────────────────────
 * 1) Default probe cadence starts at 15s.
 * 2) If EMA stays stable (<5 ms change) for 3 consecutive successful rounds,
 *    the region slows to 60s probes.
 * 3) If a sample is twitchy (|sample-EMA| > max(EMA*3, 30ms)), cadence snaps
 *    to 5s for the next 5 rounds.
 * 4) Failed probes (network/non-204) snap to 3s for the next 3 rounds.
 * 5) After 5 consecutive failures, the region is marked unhealthy and backs off
 *    to 30s probes until recovery.
 */
'use strict';

const RegionProbe = (() => {
    // ── Constants ─────────────────────────────────────────────────────
    const DEFAULT_INTERVAL_MS      = 15_000;
    const FAST_TWITCHY_MS          = 5_000;
    const FAST_FAILED_MS           = 3_000;
    const STEADY_INTERVAL_MS       = 60_000;
    const UNHEALTHY_BACKOFF_MS     = 30_000;
    const PROBE_WARMUP_SAMPLES     = 3;
    const PROBE_TIMEOUT_MS         = 2_500;
    const SPIKE_ALPHA              = 0.3;
    const DECAY_ALPHA              = 0.1;
    const CHANGE_THRESHOLD_MS      = 5;
    const TWITCHY_MIN_DIFF_MS      = 30;
    const TWITCHY_ROUNDS           = 5;
    const FAIL_FAST_ROUNDS         = 3;
    const STABLE_ROUNDS_TO_SLOW    = 3;
    const UNHEALTHY_FAILURES       = 5;
    const MIN_RTT_MS               = 1;

    // ── State ─────────────────────────────────────────────────────────
    let _regions     = [];
    let _selfId      = '';
    let _rttMap      = {}; // { [regionId]: RegionState }
    let _listeners   = [];
    let _timers      = {}; // { [regionId]: timeoutId }
    let _initialized = false;

    function _newState() {
        return {
            ema: null,
            samples: 0,
            stableConsecutive: 0,
            lastErrorAt: null,
            currentIntervalMs: DEFAULT_INTERVAL_MS,
            failures: 0,
            twitchyRoundsLeft: 0,
            failedFastRoundsLeft: 0,
            health: 'unknown',
            unhealthyNotified: false
        };
    }

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

    function _emitChanged(changedRegionIds) {
        if (!changedRegionIds || changedRegionIds.length === 0) return;
        _emit('changed', {
            changedRegionIds,
            regionId: changedRegionIds[0]
        });
    }

    // ── EMA update ────────────────────────────────────────────────────
    function _updateEma(prev, sample) {
        if (prev === null) return sample;
        const alpha = sample > prev ? SPIKE_ALPHA : DECAY_ALPHA;
        return prev + alpha * (sample - prev);
    }

    // Twitchy threshold: react to large outliers relative to current EMA,
    // but always require at least a 30 ms absolute jump.
    function _calculateTwitchyThreshold(ema) {
        if (ema === null) return TWITCHY_MIN_DIFF_MS;
        return Math.max(ema * 3, TWITCHY_MIN_DIFF_MS);
    }

    // ── Single probe ──────────────────────────────────────────────────
    async function _probe(region) {
        const url = region.publicUrl ? `${region.publicUrl}/api/ping` : '/api/ping';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const t0 = performance.now();

        try {
            const res = await fetch(url, {
                cache: 'no-store',
                mode: 'cors',
                signal: controller.signal
            });
            const rtt = performance.now() - t0;
            if (res.status !== 204 || rtt < MIN_RTT_MS) return null;
            return rtt;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    function _setRegionTimer(regionId, delayMs) {
        _clearRegionTimer(regionId);
        _timers[regionId] = setTimeout(() => {
            const region = _regions.find(r => r.id === regionId);
            if (!region || document.visibilityState === 'hidden') return;
            _probeCycle([region], true);
        }, Math.max(0, delayMs));
    }

    function _clearRegionTimer(regionId) {
        const timer = _timers[regionId];
        if (timer) clearTimeout(timer);
        delete _timers[regionId];
    }

    function _clearAllTimers() {
        for (const regionId of Object.keys(_timers)) {
            _clearRegionTimer(regionId);
        }
    }

    async function _probeOneRegion(region) {
        const state = _rttMap[region.id] = _rttMap[region.id] || _newState();
        const sample = await _probe(region);

        if (sample === null) {
            state.failures = Math.min(state.failures + 1, UNHEALTHY_FAILURES);
            state.lastErrorAt = Date.now();
            state.stableConsecutive = 0;

            if (state.failures >= UNHEALTHY_FAILURES) {
                state.currentIntervalMs = UNHEALTHY_BACKOFF_MS;
                state.health = 'unhealthy';
                if (!state.unhealthyNotified) {
                    state.unhealthyNotified = true;
                    _emit('unhealthy', region.id);
                }
            } else {
                state.failedFastRoundsLeft = Math.max(state.failedFastRoundsLeft, FAIL_FAST_ROUNDS);
                state.currentIntervalMs = FAST_FAILED_MS;
                if (state.health === 'unknown' && state.samples > 0) {
                    state.health = 'ok';
                }
            }

            return false;
        }

        // Recovery from failure/backoff state.
        state.lastErrorAt = null;
        state.failures = 0;
        state.unhealthyNotified = false;

        state.samples++;
        if (state.samples <= PROBE_WARMUP_SAMPLES) {
            state.ema = _updateEma(state.ema, sample);
            if (state.health === 'unknown' && state.samples >= PROBE_WARMUP_SAMPLES) {
                state.health = 'ok';
            }
            return false;
        }

        const prev = state.ema;
        const twitchyDiffThreshold = _calculateTwitchyThreshold(prev);
        const isTwitchySample = prev !== null && Math.abs(sample - prev) > twitchyDiffThreshold;

        if (isTwitchySample) {
            state.twitchyRoundsLeft = Math.max(state.twitchyRoundsLeft, TWITCHY_ROUNDS);
            state.stableConsecutive = 0;
            state.currentIntervalMs = FAST_TWITCHY_MS;
            state.health = 'twitchy';
        }

        state.ema = _updateEma(prev === null ? sample : prev, sample);

        let changed = false;
        if (prev === null || Math.abs(state.ema - prev) >= CHANGE_THRESHOLD_MS) {
            changed = true;
        }

        if (!isTwitchySample) {
            const delta = prev === null ? 0 : Math.abs(state.ema - prev);
            if (delta < CHANGE_THRESHOLD_MS) {
                state.stableConsecutive++;
            } else {
                state.stableConsecutive = 0;
            }
        }

        if (state.failedFastRoundsLeft > 0) {
            state.failedFastRoundsLeft--;
            state.currentIntervalMs = FAST_FAILED_MS;
        } else if (state.twitchyRoundsLeft > 0) {
            state.twitchyRoundsLeft--;
            state.currentIntervalMs = FAST_TWITCHY_MS;
        } else if (state.stableConsecutive >= STABLE_ROUNDS_TO_SLOW) {
            state.currentIntervalMs = STEADY_INTERVAL_MS;
            state.health = 'ok';
        } else {
            state.currentIntervalMs = DEFAULT_INTERVAL_MS;
            state.health = 'ok';
        }

        return changed;
    }

    // ── Probe cycle (one or many regions), coalesced changed event ───────────
    async function _probeCycle(regions, reschedule) {
        if (document.visibilityState === 'hidden') return;

        const changes = await Promise.all(regions.map(async region => {
            const changed = await _probeOneRegion(region);
            if (reschedule) {
                const state = _rttMap[region.id] || _newState();
                _setRegionTimer(region.id, state.currentIntervalMs);
            }
            return changed ? region.id : null;
        }));

        const changedRegionIds = changes.filter(Boolean);
        _emitChanged(changedRegionIds);
    }

    // ── Public API ────────────────────────────────────────────────────
    async function init() {
        if (_initialized) return;
        _initialized = true;

        try {
            const res = await fetch('/api/regions', { cache: 'no-store' });
            if (!res.ok) throw new Error(`/api/regions returned ${res.status}`);
            const data = await res.json();
            _selfId = data.self || 'local';
            _regions = data.all || [{ id: 'local', displayName: 'Local', publicUrl: '' }];
        } catch (err) {
            console.warn('[RegionProbe] Failed to load regions, using local fallback:', err);
            _selfId = 'local';
            _regions = [{ id: 'local', displayName: 'Local', publicUrl: '' }];
        }

        for (const r of _regions) {
            _rttMap[r.id] = _newState();
        }

        await _probeCycle(_regions, true);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                _clearAllTimers();
                return;
            }

            _clearAllTimers();
            _probeCycle(_regions, true);
        });
    }

    function getRtt(regionId) {
        const state = _rttMap[regionId];
        return state ? state.ema : null;
    }

    function getSelf() {
        return getRtt(_selfId);
    }

    function getSelfId() {
        return _selfId;
    }

    function getAllRegions() {
        return _regions.map(r => ({
            id: r.id,
            displayName: r.displayName,
            publicUrl: r.publicUrl,
            rttMs: getRtt(r.id),
            intervalMs: (_rttMap[r.id] && _rttMap[r.id].currentIntervalMs) || DEFAULT_INTERVAL_MS,
            health: getRegionHealth(r.id)
        }));
    }

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

    function getDisplayName(regionId) {
        const r = _regions.find(r => r.id === regionId);
        return r ? r.displayName : regionId;
    }

    function getRegionHealth(regionId) {
        const state = _rttMap[regionId];
        return state ? state.health : 'unknown';
    }

    function getRegionInterval(regionId) {
        const state = _rttMap[regionId];
        return state ? state.currentIntervalMs : DEFAULT_INTERVAL_MS;
    }

    return {
        init,
        on,
        getRtt,
        getSelf,
        getSelfId,
        getAllRegions,
        getBestRegion,
        getDisplayName,
        getRegionHealth,
        getRegionInterval
    };
})();
