/**
 * Cross-region REST aggregation for the session picker.
 */
const MultiRegionSessionsFactory = (function() {
    const COALESCE_MS = 250;
    const REST_TIMEOUT_MS = 5000;
    const POLL_INTERVAL_MS = 30000;

    function create({
        updateSessionList,
        fetch: fetchFn = globalThis.fetch,
        now = () => Date.now(),
        isDocumentHidden = () =>
            typeof document !== 'undefined' && document.hidden,
    }) {
        if (typeof updateSessionList !== 'function') {
            throw new TypeError('updateSessionList is required');
        }
        if (typeof fetchFn !== 'function') {
            throw new TypeError('fetch is required');
        }

        const perRegion = new Map();
        const pendingRefetch = new Map();
        const inFlight = new Map();
        const requestSequences = new Map();
        let backgroundPollHandle = null;
        let runGeneration = 0;
        let running = false;

        function regionState(regionId) {
            return perRegion.get(regionId)?.state ?? 'cold';
        }

        async function fetchOneRegion(region, controller) {
            const url = `${region.hostname.replace(/\/$/, '')}/api/sessions`;
            const timer = setTimeout(
                () => controller.abort(),
                REST_TIMEOUT_MS);
            try {
                const response = await fetchFn(url, {
                    method: 'GET',
                    cache: 'no-store',
                    mode: 'cors',
                    credentials: 'omit',
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } finally {
                clearTimeout(timer);
            }
        }

        async function refreshRegion(region, generation = runGeneration) {
            const requestSequence =
                (requestSequences.get(region.id) ?? 0) + 1;
            requestSequences.set(region.id, requestSequence);
            inFlight.get(region.id)?.abort();
            const controller = new AbortController();
            inFlight.set(region.id, controller);
            try {
                const body = await fetchOneRegion(region, controller);
                if (generation !== runGeneration
                    || requestSequences.get(region.id) !== requestSequence) {
                    return;
                }
                perRegion.set(region.id, {
                    sessions: (body.sessions || []).map(session => ({
                        ...session,
                        regionId: session.regionId || region.id,
                    })),
                    maxSessions: body.maxSessions ?? 6,
                    canCreate: body.canCreateSession ?? true,
                    state: 'fresh',
                    lastFetchAt: now(),
                    lastError: null,
                });
            } catch (error) {
                if (generation !== runGeneration
                    || requestSequences.get(region.id) !== requestSequence) {
                    return;
                }
                const previous = perRegion.get(region.id) ?? {};
                perRegion.set(region.id, {
                    ...previous,
                    sessions: [],
                    state: 'stale',
                    lastError: error?.message,
                });
            } finally {
                if (inFlight.get(region.id) === controller) {
                    inFlight.delete(region.id);
                }
            }

            if (generation !== runGeneration
                || requestSequences.get(region.id) !== requestSequence) {
                return;
            }
            applyMerged();
        }

        function requestRefresh(region, immediate = false) {
            if (immediate) {
                return refreshRegion(region, runGeneration);
            }
            const existing = pendingRefetch.get(region.id);
            if (existing) clearTimeout(existing);
            const handle = setTimeout(() => {
                pendingRefetch.delete(region.id);
                refreshRegion(region, runGeneration);
            }, COALESCE_MS);
            pendingRefetch.set(region.id, handle);
            return Promise.resolve();
        }

        function applyMerged() {
            const sessions = [];
            let maxSessions = 6;
            let canCreate = true;
            for (const slice of perRegion.values()) {
                if (slice.state !== 'fresh') continue;
                sessions.push(...slice.sessions);
                maxSessions = Math.max(maxSessions, slice.maxSessions);
                canCreate = canCreate && slice.canCreate;
            }
            updateSessionList({
                sessions,
                maxSessions,
                canCreateSession: canCreate,
            });
        }

        async function start(regions) {
            stop();
            running = true;
            const generation = ++runGeneration;
            await Promise.all(
                regions.map(region => refreshRegion(region, generation)));
            if (!running || generation !== runGeneration) return;
            backgroundPollHandle = setInterval(() => {
                if (isDocumentHidden()) return;
                regions.forEach(region => requestRefresh(region));
            }, POLL_INTERVAL_MS);
        }

        function stop() {
            running = false;
            runGeneration++;
            if (backgroundPollHandle) {
                clearInterval(backgroundPollHandle);
                backgroundPollHandle = null;
            }
            for (const handle of pendingRefetch.values()) {
                clearTimeout(handle);
            }
            pendingRefetch.clear();
            for (const controller of inFlight.values()) {
                controller.abort();
            }
            inFlight.clear();
        }

        function reset() {
            perRegion.clear();
        }

        return Object.freeze({
            start,
            stop,
            reset,
            requestRefresh,
            regionState,
            applyMerged,
            _perRegion: perRegion,
            COALESCE_MS,
        });
    }

    return Object.freeze({
        create,
        COALESCE_MS,
        REST_TIMEOUT_MS,
        POLL_INTERVAL_MS,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MultiRegionSessionsFactory;
}
