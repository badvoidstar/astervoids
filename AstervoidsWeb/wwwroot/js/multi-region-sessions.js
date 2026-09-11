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

        async function performRefresh(region, request, generation) {
            const isCurrent = () => generation === runGeneration
                && inFlight.get(region.id) === request;
            try {
                try {
                    const body = await fetchOneRegion(region, request.controller);
                    if (!isCurrent()) return;
                    if (request.controller.signal.aborted) throw new Error('Region refresh aborted');
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
                    if (!isCurrent()) return;
                    const previous = perRegion.get(region.id) ?? {};
                    perRegion.set(region.id, {
                        ...previous,
                        sessions: [],
                        state: 'stale',
                        lastError: error?.message,
                    });
                }
                applyMerged();
            } finally {
                const followUp = request.followUp;
                if (isCurrent()) {
                    inFlight.delete(region.id);
                    if (followUp) {
                        refreshRegion(followUp.region, generation).then(followUp.resolve, followUp.reject);
                    }
                } else {
                    followUp?.resolve();
                }
            }
        }

        function refreshRegion(region, generation = runGeneration) {
            if (generation !== runGeneration) return Promise.resolve();
            const active = inFlight.get(region.id);
            if (active) {
                // Hints during a request need one later snapshot, not a replacement
                // request. Immediate callers wait for that snapshot, not the old one.
                if (!active.followUp) {
                    const followUp = { region };
                    followUp.promise = new Promise((resolve, reject) => {
                        followUp.resolve = resolve;
                        followUp.reject = reject;
                    });
                    followUp.promise.catch(() => {});
                    active.followUp = followUp;
                }
                active.followUp.region = region;
                return active.followUp.promise;
            }
            const request = { controller: new AbortController(), followUp: null };
            inFlight.set(region.id, request);
            request.promise = performRefresh(region, request, generation);
            // Background hints may ignore the promise; explicit callers can still
            // observe callback errors without producing unhandled rejections.
            request.promise.catch(() => {});
            return request.promise;
        }

        function requestRefresh(region, immediate = false) {
            const existing = pendingRefetch.get(region.id);
            if (existing != null) {
                clearTimeout(existing);
                pendingRefetch.delete(region.id);
            }
            if (immediate || inFlight.has(region.id)) {
                const promise = refreshRegion(region, runGeneration);
                return immediate ? promise : Promise.resolve();
            }
            const generation = runGeneration;
            const handle = setTimeout(() => {
                if (pendingRefetch.get(region.id) !== handle) return;
                pendingRefetch.delete(region.id);
                refreshRegion(region, generation);
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
            for (const request of inFlight.values()) {
                request.controller.abort();
                request.followUp?.resolve();
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
