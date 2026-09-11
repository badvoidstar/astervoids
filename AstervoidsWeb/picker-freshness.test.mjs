/**
 * Picker freshness tests.
 *
 * Targets the multi-region session merge + dedup invariants that drive the
 * picker's latency budget (plan.md → "Picker freshness — latency budget").
 *
 * The tests execute the same dependency-injected aggregation module used by
 * the browser picker.
 *
 * Contract under test:
 *   - Bootstrap: parallel /api/sessions fetch per region; merged result
 *     contains every region's sessions stamped with regionId.
 *   - Per-region failure (timeout / 5xx): drops only that region's rows
 *     from the merge — every healthy region's sessions remain visible.
 *   - Push coalescing: multiple OnSessionsChanged events from the same
 *     region within 250 ms collapse to a single refetch. Hints received while
 *     fetching queue one follow-up without aborting the active request.
 *   - Visibility off (`document.hidden`): stop() halts background polls
 *     so backgrounded tabs don't keep regions warm (scale-to-zero).
 *   - Explicit refresh after stop(): remains available for Join/Create
 *     transitions while stale pre-stop requests are still rejected.
 *
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const makeMultiRegionSessions =
    require('./wwwroot/js/multi-region-sessions.js').create;

// ─── helpers ───
function fakeOk(body) { return { ok: true, status: 200, json: async () => body }; }
function fakeFail(status = 500) { return { ok: false, status, json: async () => ({}) }; }
function session(id, regionId) {
    return { id, name: `s-${id}`, memberCount: 1, maxMembers: 4, createdAt: '2026-05-26T00:00:00Z', regionId };
}
const drain = () => new Promise(resolve => setImmediate(resolve));

function refreshHarness({ updateSessionList } = {}) {
    const timers = new Map();
    const requests = [];
    const updates = [];
    let nextTimer = 0;
    const module = { exports: {} };
    runInNewContext(
        readFileSync(new URL('wwwroot/js/multi-region-sessions.js', import.meta.url), 'utf8'),
        {
            module, AbortController, Date,
            setTimeout: (fn, delay) => {
                timers.set(++nextTimer, { fn, delay });
                return nextTimer;
            },
            clearTimeout: id => timers.delete(id),
            setInterval: () => ++nextTimer,
            clearInterval() {},
        });
    const mrs = module.exports.create({
        updateSessionList: updateSessionList ?? (result => updates.push(result)),
        fetch: (url, init) => new Promise((resolve, reject) => {
            requests.push({ url, signal: init.signal, resolve, reject });
        }),
    });
    return {
        mrs, requests, updates, timers,
        runTimers: async delay => {
            for (const [id, timer] of [...timers]) {
                if (timer.delay <= delay && timers.delete(id)) timer.fn();
            }
            await drain();
        },
    };
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

    test('in-flight hints share exactly one follow-up and immediate callers wait for its snapshot', async t => {
        const { mrs, requests, updates, runTimers } = refreshHarness();
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        const older = mrs.requestRefresh(region, true);
        await mrs.requestRefresh(region);
        const newer = mrs.requestRefresh(region, true);
        assert.strictEqual(mrs.requestRefresh(region, true), newer);
        await mrs.requestRefresh(region);
        await runTimers(250);
        assert.equal(requests.length, 1, 'hints cannot restart a slow request');
        assert.equal(requests[0].signal.aborted, false);
        let settled = false;
        newer.then(() => { settled = true; });
        requests[0].resolve(fakeOk({ sessions: [session('old', 'r1')] }));
        await older;
        assert.equal(settled, false, 'a queued immediate refresh waits for the later snapshot');
        assert.equal(requests.length, 2);
        assert.equal(updates.at(-1).sessions[0].id, 'old', 'the active request can still paint useful rows');
        requests[1].resolve(fakeOk({ sessions: [session('new', 'r1')] }));
        await newer;
        await runTimers(250);
        assert.equal(requests.length, 2, 'no leftover debounce creates a third request');
        assert.equal(updates.at(-1).sessions[0].id, 'new');
    });

    test('immediate refresh consumes an idle debounce instead of fetching again later', async t => {
        const { mrs, requests, runTimers } = refreshHarness();
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        await mrs.requestRefresh(region);
        const immediate = mrs.requestRefresh(region, true);
        requests[0].resolve(fakeOk({ sessions: [] }));
        await immediate;
        await runTimers(250);
        assert.equal(requests.length, 1);
    });

    test('a slow response body remains single-flight and new follow-up hints queue only one later fetch', async t => {
        const { mrs, requests } = refreshHarness();
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        let resolveBody;
        const body = new Promise(resolve => { resolveBody = resolve; });
        const first = mrs.requestRefresh(region, true);
        requests[0].resolve({ ok: true, json: () => body });
        await drain();
        const second = mrs.requestRefresh(region, true);
        assert.equal(requests.length, 1);
        resolveBody({ sessions: [] });
        await first;
        assert.equal(requests.length, 2);
        const third = mrs.requestRefresh(region, true);
        await mrs.requestRefresh(region);
        requests[1].resolve(fakeOk({ sessions: [] }));
        await second;
        assert.equal(requests.length, 3);
        requests[2].resolve(fakeOk({ sessions: [] }));
        await third;
        assert.equal(requests.length, 3);
        assert.ok(requests.every(request => !request.signal.aborted));
    });

    test('a failed region drains its queued refresh without blocking healthy regions', async t => {
        const { mrs, requests, updates } = refreshHarness();
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        const first = mrs.requestRefresh(region, true);
        const second = mrs.requestRefresh(region, true);
        const healthy = mrs.requestRefresh({ id: 'r2', hostname: 'https://r2.example.com' }, true);
        requests[1].resolve(fakeOk({ sessions: [session('healthy', 'r2')] }));
        await healthy;
        assert.equal(updates.at(-1).sessions[0].id, 'healthy');
        requests[0].reject(new Error('network failed'));
        await first;
        assert.equal(mrs.regionState('r1'), 'stale');
        assert.equal(requests.length, 3);
        requests[2].resolve(fakeOk({ sessions: [session('recovered', 'r1')] }));
        await second;
        assert.equal(mrs.regionState('r1'), 'fresh');
        assert.deepEqual(Array.from(updates.at(-1).sessions, row => row.id), ['healthy', 'recovered']);
    });

    test('timeout still aborts the request and a queued hint recovers after abort rejection', async t => {
        const { mrs, requests, runTimers } = refreshHarness();
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        const first = mrs.requestRefresh(region, true);
        const second = mrs.requestRefresh(region, true);
        requests[0].signal.addEventListener('abort', () => requests[0].reject(new Error('aborted')));
        await runTimers(5000);
        await first;
        assert.equal(requests[0].signal.aborted, true);
        assert.equal(mrs.regionState('r1'), 'stale');
        assert.equal(requests.length, 2);
        requests[1].resolve(fakeOk({ sessions: [] }));
        await second;
        assert.equal(mrs.regionState('r1'), 'fresh');
    });

    test('an abort-resistant response cannot become fresh after its timeout', async t => {
        const { mrs, requests, updates, runTimers } = refreshHarness();
        t.after(() => mrs.stop());
        const first = mrs.requestRefresh({ id: 'r1', hostname: 'https://r1.example.com' }, true);
        await runTimers(5000);
        assert.equal(requests[0].signal.aborted, true);
        requests[0].resolve(fakeOk({ sessions: [session('late', 'r1')] }));
        await first;
        assert.equal(mrs.regionState('r1'), 'stale');
        assert.equal(updates.at(-1).sessions.length, 0);
    });

    test('background follow-up callback errors stay handled and remain observable by immediate callers', async t => {
        const { mrs, requests } = refreshHarness({
            updateSessionList: () => { throw new Error('render failed'); },
        });
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        const first = mrs.requestRefresh(region, true);
        await mrs.requestRefresh(region);
        const second = mrs.requestRefresh(region, true);
        requests[0].resolve(fakeOk({ sessions: [] }));
        await drain();
        requests[1].resolve(fakeOk({ sessions: [] }));
        await drain();
        await assert.rejects(first, /render failed/);
        await assert.rejects(second, /render failed/);
    });
});

describe('MultiRegionSessions stop()', () => {
    test('stop cancels a queued refresh and a late pre-stop body cannot overwrite a new generation', async t => {
        const { mrs, requests, updates, timers } = refreshHarness();
        t.after(() => mrs.stop());
        const region = { id: 'r1', hostname: 'https://r1.example.com' };
        let resolveBody;
        const body = new Promise(resolve => { resolveBody = resolve; });
        const older = mrs.requestRefresh(region, true);
        requests[0].resolve({ ok: true, json: () => body });
        await drain();
        const cancelled = mrs.requestRefresh(region, true);
        mrs.stop();
        await cancelled;
        assert.equal(requests[0].signal.aborted, true);
        const newer = mrs.requestRefresh(region, true);
        requests[1].resolve(fakeOk({ sessions: [session('new', 'r1')] }));
        await newer;
        resolveBody({ sessions: [session('old', 'r1')] });
        await older;
        assert.equal(requests.length, 2, 'teardown discards the old generation follow-up');
        assert.equal(updates.length, 1);
        assert.equal(updates[0].sessions[0].id, 'new');
        assert.equal(timers.size, 0);
    });

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

    test('explicit refresh started after stop() still applies', async () => {
        let sessions = [session('before-stop', 'r1')];
        const updates = [];
        const fetch = async () => fakeOk({
            sessions,
            maxSessions: 6,
            canCreateSession: true
        });
        const mrs = makeMultiRegionSessions({
            updateSessionList: result => updates.push(result),
            fetch,
        });
        const region = { id: 'r1', hostname: 'https://r1.example.com' };

        await mrs.start([region]);
        mrs.stop();
        sessions = [session('after-stop', 'r1')];
        await mrs.requestRefresh(region, true);

        assert.deepEqual(
            updates.at(-1).sessions.map(value => value.id),
            ['after-stop'],
            'Join/Create one-shot refresh must not be discarded merely because background polling is stopped'
        );
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
