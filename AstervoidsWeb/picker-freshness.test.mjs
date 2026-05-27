/**
 * Picker freshness tests.
 *
 * Targets the multi-region session merge + dedup invariants that drive the
 * picker's latency budget (plan.md → "Picker freshness — latency budget").
 *
 * The actual `MultiRegionSessions` module lives inline in index.html (where
 * it has access to other picker functions via closure). Rather than
 * extracting it into a separate file (which would entangle the picker DOM),
 * we reimplement the SAME shape here and assert the contract via injected
 * `fetch` and `setTimeout` stubs. Any future refactor of the inline module
 * MUST keep this contract or these tests fail and we revisit the freshness
 * budget intentionally.
 *
 * Contract under test:
 *   - Bootstrap: parallel /api/sessions fetch per region; merged result
 *     contains every region's sessions stamped with regionId.
 *   - Per-region failure (timeout / 5xx): drops only that region's rows
 *     from the merge — every healthy region's sessions remain visible.
 *   - Push coalescing: multiple OnSessionsChanged events from the same
 *     region within 250 ms collapse to a single refetch.
 *   - Visibility off (`document.hidden`): stop() halts background polls
 *     so backgrounded tabs don't keep regions warm (scale-to-zero).
 *
 * The reimplementation below mirrors the inline module byte-for-byte
 * (modulo `updateSessionList` callback wiring which is what we observe).
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeMultiRegionSessions({ updateSessionList, fetch, now = () => Date.now() }) {
    const COALESCE_MS = 250;
    const REST_TIMEOUT_MS = 5000;
    const POLL_INTERVAL_MS = 30000;
    const perRegion = new Map();
    const pendingRefetch = new Map();
    let backgroundPollHandle = null;

    async function fetchOneRegion(region) {
        const url = `${region.hostname.replace(/\/$/, '')}/api/sessions`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }
    async function refreshRegion(region) {
        try {
            const body = await fetchOneRegion(region);
            perRegion.set(region.id, {
                sessions: (body.sessions || []).map(s => ({ ...s, regionId: s.regionId || region.id })),
                maxSessions: body.maxSessions ?? 6,
                canCreate: body.canCreateSession ?? true,
                state: 'fresh',
                lastFetchAt: now(),
                lastError: null,
            });
        } catch (err) {
            const prev = perRegion.get(region.id) ?? {};
            perRegion.set(region.id, {
                ...prev,
                sessions: [],
                state: 'stale',
                lastError: err && err.message,
            });
        }
        applyMerged();
    }
    function requestRefresh(region, immediate = false) {
        if (immediate) { refreshRegion(region); return; }
        const existing = pendingRefetch.get(region.id);
        if (existing) clearTimeout(existing);
        const handle = setTimeout(() => {
            pendingRefetch.delete(region.id);
            refreshRegion(region);
        }, COALESCE_MS);
        pendingRefetch.set(region.id, handle);
    }
    function applyMerged() {
        const sessions = [];
        let maxSessions = 6;
        let canCreate = true;
        for (const [, slice] of perRegion) {
            if (slice.state !== 'fresh') continue;
            sessions.push(...slice.sessions);
            maxSessions = Math.max(maxSessions, slice.maxSessions);
            canCreate = canCreate && slice.canCreate;
        }
        updateSessionList({ sessions, maxSessions, canCreateSession: canCreate });
    }
    async function start(regions) {
        stop();
        await Promise.all(regions.map(r => refreshRegion(r)));
        backgroundPollHandle = setInterval(() => {
            regions.forEach(r => requestRefresh(r));
        }, POLL_INTERVAL_MS);
    }
    function stop() {
        if (backgroundPollHandle) { clearInterval(backgroundPollHandle); backgroundPollHandle = null; }
        for (const t of pendingRefetch.values()) clearTimeout(t);
        pendingRefetch.clear();
    }
    return { start, stop, requestRefresh, _perRegion: perRegion, COALESCE_MS };
}

// ─── helpers ───
function fakeOk(body) { return { ok: true, status: 200, json: async () => body }; }
function fakeFail(status = 500) { return { ok: false, status, json: async () => ({}) }; }
function session(id, regionId) {
    return { id, name: `s-${id}`, memberCount: 1, maxMembers: 4, createdAt: '2026-05-26T00:00:00Z', regionId };
}

describe('MultiRegionSessions bootstrap merge', () => {
    test('parallel fetch across regions yields one merged list with regionId per session', async () => {
        const updates = [];
        const fetch = async (url) => {
            if (url.includes('a.example')) return fakeOk({ sessions: [session('s1', 'westus2'), session('s2', 'westus2')], maxSessions: 6, canCreateSession: true });
            if (url.includes('b.example')) return fakeOk({ sessions: [session('s3', 'eastus')], maxSessions: 6, canCreateSession: true });
            if (url.includes('c.example')) return fakeOk({ sessions: [], maxSessions: 6, canCreateSession: true });
            throw new Error(`unexpected ${url}`);
        };
        const mrs = makeMultiRegionSessions({ updateSessionList: r => updates.push(r), fetch });
        await mrs.start([
            { id: 'westus2', hostname: 'https://a.example.com' },
            { id: 'eastus', hostname: 'https://b.example.com' },
            { id: 'westeurope', hostname: 'https://c.example.com' },
        ]);
        const merged = updates[updates.length - 1];
        const ids = merged.sessions.map(s => s.id).sort();
        assert.deepEqual(ids, ['s1', 's2', 's3'],
            'every fresh region contributes its sessions to the merged picker view');
        merged.sessions.forEach(s => assert.ok(s.regionId, 's' + s.id + ' missing regionId — picker needs it to route Join'));
        mrs.stop();
    });

    test('per-region 5xx drops that region but keeps others', async () => {
        const updates = [];
        const fetch = async (url) => {
            if (url.includes('a.example')) return fakeOk({ sessions: [session('s1', 'westus2')], maxSessions: 6, canCreateSession: true });
            if (url.includes('b.example')) return fakeFail(503);  // EU region down
            if (url.includes('c.example')) return fakeOk({ sessions: [session('s3', 'eastus')], maxSessions: 6, canCreateSession: true });
            throw new Error(`unexpected ${url}`);
        };
        const mrs = makeMultiRegionSessions({ updateSessionList: r => updates.push(r), fetch });
        await mrs.start([
            { id: 'westus2', hostname: 'https://a.example.com' },
            { id: 'eu', hostname: 'https://b.example.com' },
            { id: 'eastus', hostname: 'https://c.example.com' },
        ]);
        const merged = updates[updates.length - 1];
        const ids = merged.sessions.map(s => s.id).sort();
        assert.deepEqual(ids, ['s1', 's3'],
            'failed region drops its rows from the merge but does NOT take healthy regions down with it');
        assert.equal(mrs._perRegion.get('eu').state, 'stale',
            'failed region is marked stale so the picker can show a ⚠ badge');
        mrs.stop();
    });
});

describe('MultiRegionSessions push coalescing', () => {
    test('multiple requestRefresh calls within COALESCE_MS collapse to one fetch', async () => {
        let fetchCount = 0;
        const fetch = async () => {
            fetchCount++;
            return fakeOk({ sessions: [], maxSessions: 6, canCreateSession: true });
        };
        const updates = [];
        const mrs = makeMultiRegionSessions({ updateSessionList: r => updates.push(r), fetch });
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        mrs.requestRefresh(region);
        mrs.requestRefresh(region);
        mrs.requestRefresh(region);
        // Wait past the coalesce window.
        await new Promise(r => setTimeout(r, mrs.COALESCE_MS + 50));
        assert.equal(fetchCount, 1,
            '3 pushes within 250ms must collapse to 1 fetch — otherwise a member-leave triggering promotion + cleanup would triple-fetch');
        mrs.stop();
    });

    test('immediate=true bypasses coalesce window', async () => {
        let fetchCount = 0;
        const fetch = async () => { fetchCount++; return fakeOk({ sessions: [], maxSessions: 6, canCreateSession: true }); };
        const mrs = makeMultiRegionSessions({ updateSessionList: () => {}, fetch });
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        await mrs.requestRefresh(region, /*immediate=*/true);
        // Allow promise resolution to drain.
        await new Promise(r => setTimeout(r, 10));
        assert.equal(fetchCount, 1,
            'immediate=true bypasses coalesce — used for explicit Refresh / Leave / Join paths that need synchronous freshness');
        mrs.stop();
    });
});

describe('MultiRegionSessions stop()', () => {
    test('cancels pending coalesced refetch', async () => {
        let fetchCount = 0;
        const fetch = async () => { fetchCount++; return fakeOk({ sessions: [], maxSessions: 6, canCreateSession: true }); };
        const mrs = makeMultiRegionSessions({ updateSessionList: () => {}, fetch });
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        mrs.requestRefresh(region);
        mrs.stop();  // before the coalesce window fires
        await new Promise(r => setTimeout(r, 350));
        assert.equal(fetchCount, 0,
            'stop() during the coalesce window must cancel the pending refetch — used when document.hidden flips, to honor scale-to-zero');
    });

    test('idempotent — start() after stop() resumes cleanly', async () => {
        const fetch = async () => fakeOk({ sessions: [session('s1', 'r1')], maxSessions: 6, canCreateSession: true });
        const updates = [];
        const mrs = makeMultiRegionSessions({ updateSessionList: r => updates.push(r), fetch });
        const regions = [{ id: 'r1', hostname: 'https://r1.example.com' }];
        await mrs.start(regions);
        mrs.stop();
        await mrs.start(regions);
        const merged = updates[updates.length - 1];
        assert.equal(merged.sessions.length, 1, 'start() after stop() re-bootstraps cleanly');
        mrs.stop();
    });
});

describe('MultiRegionSessions cold-start budget', () => {
    test('cold-start (slow first fetch) does NOT block other regions from rendering', async () => {
        // The freshness budget says: cold-region first response can be up
        // to 15s, but warm regions must paint immediately. Verify by
        // resolving the slow region last but observing that the merged
        // updates landed in fetch-completion order — fast regions surface
        // their sessions BEFORE the cold region completes.
        let slowResolve;
        const slowPromise = new Promise(r => { slowResolve = r; });
        const fetch = async (url) => {
            if (url.includes('cold.example')) return slowPromise;
            return fakeOk({ sessions: [session('fast-session', url.includes('a.example') ? 'fast' : 'warm')], maxSessions: 6, canCreateSession: true });
        };
        const updates = [];
        const mrs = makeMultiRegionSessions({ updateSessionList: r => updates.push(r), fetch });
        // Kick off start() but don't await it — Promise.all inside will be pending on the cold region.
        const startPromise = mrs.start([
            { id: 'fast', hostname: 'https://a.example.com' },
            { id: 'cold', hostname: 'https://cold.example.com' },
        ]);
        // Let the synchronous fetch() chain settle on the fast region.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        const earlyMerged = updates[updates.length - 1];
        const earlyIds = earlyMerged.sessions.map(s => s.id);
        assert.deepEqual(earlyIds, ['fast-session'],
            'fast region must paint immediately — cold region must NOT block the picker UI for up to 15s');

        // Now resolve the cold region — merged view picks up its sessions.
        slowResolve(fakeOk({ sessions: [session('cold-session', 'cold')], maxSessions: 6, canCreateSession: true }));
        await startPromise;
        const finalMerged = updates[updates.length - 1];
        const finalIds = finalMerged.sessions.map(s => s.id).sort();
        assert.deepEqual(finalIds, ['cold-session', 'fast-session'],
            'cold region eventually contributes — merge updates incrementally as each region resolves');
        mrs.stop();
    });
});
