import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const regionSource = readFileSync(new URL('wwwroot/js/region-service.js', import.meta.url), 'utf8');
const regions = [
    { id: 'a', displayName: 'A', hostname: 'https://a.example.com' },
    { id: 'b', displayName: 'B', hostname: 'https://b.example.com' },
];
const drain = () => new Promise(resolve => setImmediate(resolve));
const ok = body => ({ ok: true, json: async () => body, text: async () => '' });

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function createRegionHarness({ manifest = regions, ping, manifestResponse, hidden = false } = {}) {
    const timers = new Map();
    const visibilityListeners = new Set();
    const requests = [];
    let nextTimer = 0;
    let now = 0;
    const document = {
        hidden,
        addEventListener: (_, listener) => visibilityListeners.add(listener),
        removeEventListener: (_, listener) => visibilityListeners.delete(listener),
    };
    const window = { location: { origin: regions[0].hostname } };
    const setTimeout = (fn, delay) => {
        timers.set(++nextTimer, { fn, delay });
        return nextTimer;
    };
    const clearTimeout = id => timers.delete(id);
    const module = { exports: {} };
    runInNewContext(regionSource, {
        module, window, document, AbortController, console, Date, setTimeout, clearTimeout,
        performance: { now: () => now },
        fetch: async (url, init) => {
            if (url.endsWith('/api/regions')) {
                return manifestResponse ? manifestResponse.promise : ok({ regionId: 'a', regions: manifest });
            }
            const request = { url, signal: init.signal };
            requests.push(request);
            now += 20;
            return ping ? ping(request, requests.length) : ok();
        },
    });
    const service = module.exports;
    service._configure({ BURST_STAGGER_MAX_MS: 0, BURST_INTERVAL_MS: 60_000 });
    async function runTimers(maxDelay = 0) {
        for (const [id, timer] of [...timers]) {
            if (timer.delay <= maxDelay && timers.delete(id)) timer.fn();
        }
        await drain();
    }
    function visibility(hidden) {
        document.hidden = hidden;
        for (const listener of [...visibilityListeners]) listener();
    }
    return {
        service, window, document, timers, requests, visibilityListeners,
        runTimers, visibility, setTimeout, clearTimeout,
    };
}

for (const manifest of [regions.slice(0, 1), regions]) {
    test(`${manifest.length} region(s): picker stop aborts a burst, rejects stale completion, and resumes fresh`, async t => {
        const pending = deferred();
        const h = createRegionHarness({
            manifest,
            ping: (_, count) => count <= manifest.length ? pending.promise : ok(),
        });
        t.after(() => h.service.stop());
        await h.service.load();
        const updates = [];
        h.service.on('rttUpdated', id => updates.push(id));
        h.service.start();
        await h.runTimers();
        assert.equal(h.requests.length, manifest.length);
        h.service.stop();
        assert.ok(h.requests.every(request => request.signal.aborted));
        assert.equal(h.visibilityListeners.size, 0);
        h.service.start();
        await h.runTimers();
        assert.equal(h.requests.length, manifest.length * 4, 'one fresh three-ping burst per region');
        assert.equal(updates.length, manifest.length);
        const samples = manifest.map(region => h.service.getRtt(region.id));
        pending.resolve(ok());
        await drain();
        assert.equal(h.requests.length, manifest.length * 4, 'cancelled bursts cannot send their remaining pings');
        assert.deepEqual(manifest.map(region => h.service.getRtt(region.id)), samples);
        assert.equal(updates.length, manifest.length, 'old completion cannot publish an RTT');
        h.service.stop();
        h.service.start();
        h.service.start();
        await h.runTimers();
        assert.ok(manifest.every(region => h.service.getRtt(region.id).sampleCount === 2),
            'resume immediately refreshes retained measurements without duplicate loops');
    });
}

test('stop aborts an in-progress response body without issuing another ping or marking unavailable', async t => {
    const body = deferred();
    const h = createRegionHarness({
        manifest: regions.slice(0, 1),
        ping: () => ({ ok: true, text: () => body.promise }),
    });
    t.after(() => h.service.stop());
    await h.service.load();
    h.service.start();
    await h.runTimers();
    h.service.stop();
    assert.equal(h.requests[0].signal.aborted, true);
    body.resolve('');
    await drain();
    assert.equal(h.requests.length, 1);
    assert.equal(h.service.getRtt('a').state, 'warming');
    assert.equal(h.timers.size, 0);
});

test('fetch abort rejection ends the burst rather than retrying remaining samples', async t => {
    const h = createRegionHarness({
        manifest: regions.slice(0, 1),
        ping: request => new Promise((_, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    t.after(() => h.service.stop());
    await h.service.load();
    h.service.start();
    await h.runTimers();
    h.service.stop();
    await drain();
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.service.getRtt('a').state, 'warming');
});

test('hidden startup, hide/show races, and stop keep regional assessment visibility-gated', async t => {
    const pending = deferred();
    const h = createRegionHarness({
        hidden: true,
        manifest: regions.slice(0, 1),
        ping: (_, count) => count === 1 ? pending.promise : ok(),
    });
    t.after(() => h.service.stop());
    await h.service.load();
    h.service.start();
    assert.equal(h.timers.size, 0, 'hidden startup must not even schedule bootstrap pings');
    h.visibility(false);
    await h.runTimers();
    assert.equal(h.requests.length, 1);
    h.visibility(true);
    assert.equal(h.requests[0].signal.aborted, true);
    h.visibility(false);
    await h.runTimers();
    assert.equal(h.service.getRtt('a').sampleCount, 1);
    pending.resolve(ok());
    await drain();
    assert.equal(h.requests.length, 4);
    assert.equal(h.service.getRtt('a').sampleCount, 1);
    h.service.stop();
    h.visibility(true);
    h.visibility(false);
    await h.runTimers(60_000);
    assert.equal(h.requests.length, 4, 'visibility changes cannot resurrect a stopped picker');
});

test('hidden checks cover timer dispatch and mid-burst races before visibilitychange is delivered', async t => {
    const pending = deferred();
    const h = createRegionHarness({
        manifest: regions.slice(0, 1),
        ping: () => pending.promise,
    });
    t.after(() => h.service.stop());
    await h.service.load();
    h.service.start();
    h.document.hidden = true;
    await h.runTimers();
    assert.equal(h.requests.length, 0);
    h.visibility(false);
    await h.runTimers();
    h.document.hidden = true;
    pending.resolve(ok());
    await drain();
    assert.equal(h.requests.length, 1);
    assert.equal(h.service.getRtt('a').state, 'warming');
    assert.equal(h.timers.size, 0);
});

test('manifest replacement aborts active bursts and cannot restart probes while hidden', async t => {
    const pending = deferred();
    const h = createRegionHarness({ ping: () => pending.promise });
    t.after(() => h.service.stop());
    await h.service.load();
    h.service.start();
    await h.runTimers();
    h.document.hidden = true;
    await h.service.load({ bootstrap: { regionId: 'a', regions: regions.slice(0, 1) } });
    assert.ok(h.requests.every(request => request.signal.aborted));
    pending.resolve(ok());
    await drain();
    assert.equal(h.timers.size, 0);
    assert.equal(h.requests.length, 2);
    assert.equal(h.service.getRtt('a').state, 'warming');
});

function createPickerHarness(options = {}) {
    const h = createRegionHarness(options);
    const domUpdates = [];
    const sessionResults = [];
    const regionalRefreshes = [];
    const spectatorHandlers = new Map();
    let screenHidden = false;
    let hubHostname = regions[0].hostname;
    let singleRefreshes = 0;
    const game = { state: 'start', mode: 'solo', ship: null };
    const sessionPicker = {
        regions: [], regionDiscoveryState: 'loading', sessions: [],
        selectedCreateRegion: null, userOverrodeCreateRegion: false,
        btnStartEnter: {}, currentSessionId: null,
    };
    const startScreen = { classList: { contains: () => screenHidden } };
    const recordDom = name => () => domUpdates.push(name);
    const SessionClient = {
        isConnected: () => true,
        getCurrentHubHostname: () => hubHostname,
        getSessionEpoch: () => 1,
        getActiveSessions: async () => {
            singleRefreshes++;
            if (options.getActiveSessions) return options.getActiveSessions();
            return options.sessionsResponse ? options.sessionsResponse.promise : { sessions: [] };
        },
    };
    Object.assign(h.window, {
        SessionClient,
        SpectatorClient: {
            on: (event, fn) => spectatorHandlers.set(event, fn),
            openAll: async () => {},
            closeAll: () => options.closeResponse?.promise || Promise.resolve(),
        },
    });
    const functions = loadInlineGameFunctions([
        'isSessionPickerVisible', 'isSessionPickerActive',
        'initRegionService', 'initMultiRegionPicker', 'startMultiRegionPicker',
        'pausePickerAssessment', 'pauseMultiRegionPicker', 'teardownMultiRegionPicker',
        'activateSessionPickerUpdates', 'handlePickerVisibilityChange',
        'getSessionClientRegion', 'refreshSessionList', 'handleSessionListChanged',
        'handleSoloPlay', 'startGameFromPicker', 'captureGameStartContext', 'isGameStartContextCurrent',
    ], {
        window: h.window, document: h.document, startScreen, sessionPicker, game, SessionClient,
        pickerUpdatesActive: true, multiRegionActive: false, multiRegionInitialized: false,
        sessionRefreshTimeout: null, sessionListRequestSequence: 0,
        staleRegions: new Set(), reconnectingSince: new Map(), startGameOperation: null,
        setTimeout: h.setTimeout, clearTimeout: h.clearTimeout,
        MultiRegionSessions: {
            start: async () => regionalRefreshes.push('all'),
            stop() {},
            requestRefresh: async region => regionalRefreshes.push(region.id),
        },
        isSessionMode: () => game.mode === 'session',
        isCreateRegionAvailable: id => h.service.isRegionAvailable(id),
        updatePingCellsForRegion: recordDom('ping'),
        renderRegionBanner: recordDom('banner'),
        renderRegionDownBanner: recordDom('down-banner'),
        renderCreateRegionSelector: recordDom('selector'),
        renderSessionList: recordDom('list'),
        updatePickerButtons: recordDom('buttons'),
        updatePickerConnectionStatus: recordDom('status'),
        updateSessionList: result => { sessionResults.push(result); domUpdates.push('sessions'); },
        setPickerStatus: recordDom('set-status'),
        cancelPickerOperations() {},
        clearPickerMembership: () => { sessionPicker.currentSessionId = null; },
        restoreSoloMode: () => { game.mode = 'solo'; },
        resizeCanvas() {},
        init: async () => { screenHidden = true; game.state = 'playing'; },
        _warn() {}, _log() {}, _error() {},
    });
    h.document.addEventListener('visibilitychange', functions.handlePickerVisibilityChange);
    return {
        ...h, ...functions, game, sessionPicker, domUpdates, sessionResults, regionalRefreshes, spectatorHandlers,
        setScreenHidden: hidden => { screenHidden = hidden; },
        setHubHostname: hostname => { hubHostname = hostname; },
        getSingleRefreshes: () => singleRefreshes,
    };
}

for (const count of [1, 2]) {
    for (const mode of ['solo', 'session']) {
        test(`${count} region(s): ${mode} gameplay stops HTTP assessment; returning to picker resumes`, async t => {
            const h = createPickerHarness({ manifest: regions.slice(0, count) });
            t.after(() => h.service.stop());
            await h.initRegionService();
            await h.runTimers();
            assert.equal(h.requests.length, count * 3);
            h.game.mode = mode;
            h.game.state = 'lobby';
            if (mode === 'solo') await h.handleSoloPlay();
            else await h.startGameFromPicker();
            const requestCount = h.requests.length;
            h.domUpdates.length = 0;
            h.handleSessionListChanged();
            h.visibility(true);
            h.visibility(false);
            await h.runTimers(60_000);
            assert.equal(h.requests.length, requestCount);
            assert.deepEqual(h.domUpdates, []);
            h.setScreenHidden(false);
            h.game.state = 'start';
            await h.activateSessionPickerUpdates();
            await h.runTimers();
            assert.equal(h.requests.length, requestCount + count * 3);
            assert.ok(h.domUpdates.includes('ping'));
        });
    }
}

for (const count of [1, 2]) {
    test(`${count} region(s): delayed initial manifest must not restart assessment after solo begins`, async t => {
        const manifestResponse = deferred();
        const h = createPickerHarness({ manifestResponse });
        t.after(() => h.service.stop());
        const init = h.initRegionService();
        await h.handleSoloPlay();
        h.domUpdates.length = 0;
        manifestResponse.resolve(ok({ regionId: 'a', regions: regions.slice(0, count) }));
        await init;
        await h.runTimers(60_000);
        assert.equal(h.requests.length, 0);
        assert.equal(h.regionalRefreshes.length, 0);
        assert.deepEqual(h.domUpdates, []);
        assert.equal(h.sessionPicker.regions.length, count, 'discovery still records routing for return');
        h.setScreenHidden(false);
        await h.activateSessionPickerUpdates();
        await h.runTimers();
        assert.equal(h.requests.length, count * 3);
    });
}

test('a delayed manifest cannot reactivate assessment while multiplayer start waits for spectator close', async t => {
    const manifestResponse = deferred();
    const closeResponse = deferred();
    const h = createPickerHarness({ manifestResponse, closeResponse });
    t.after(() => h.service.stop());
    h.sessionPicker.regions = regions;
    const init = h.initRegionService();
    h.game.mode = 'session';
    h.game.state = 'lobby';
    const start = h.startGameFromPicker();
    manifestResponse.resolve(ok({ regionId: 'a', regions }));
    await init;
    h.visibility(true);
    h.visibility(false);
    await h.runTimers(60_000);
    assert.equal(h.requests.length, 0);
    assert.equal(h.regionalRefreshes.length, 0);
    closeResponse.resolve();
    await start;
});

test('single-region delayed session response and queued notification are discarded across pause/resume', async t => {
    const sessionsResponse = deferred();
    const h = createPickerHarness({ manifest: regions.slice(0, 1), sessionsResponse });
    t.after(() => h.service.stop());
    await h.initRegionService();
    h.handleSessionListChanged();
    h.visibility(true);
    sessionsResponse.resolve({ sessions: [] });
    await drain();
    h.domUpdates.length = 0;
    await h.runTimers(500);
    assert.equal(h.getSingleRefreshes(), 1);
    assert.deepEqual(h.domUpdates, []);
    h.visibility(false);
    await drain();
    assert.equal(h.getSingleRefreshes(), 2, 'visible picker gets a fresh single-region list');
    assert.ok(h.domUpdates.includes('sessions'));
});

test('a pre-hide single-region response cannot overwrite the fresh list after rapid visibility resume', async t => {
    const oldResponse = deferred();
    const newResponse = deferred();
    let calls = 0;
    const h = createPickerHarness({
        manifest: regions.slice(0, 1),
        getActiveSessions: () => (++calls === 1 ? oldResponse : newResponse).promise,
    });
    t.after(() => h.service.stop());
    await h.initRegionService();
    h.visibility(true);
    h.visibility(false);
    newResponse.resolve({ sessions: [{ id: 'new' }] });
    await drain();
    oldResponse.resolve({ sessions: [{ id: 'old' }] });
    await drain();
    assert.deepEqual(h.sessionResults, [{ sessions: [{ id: 'new' }] }]);
});

test('RTT assessment does not depend on the optional spectator module', async t => {
    const h = createPickerHarness();
    delete h.window.SpectatorClient;
    t.after(() => h.service.stop());
    await h.initRegionService();
    await h.runTimers();
    assert.equal(h.requests.length, 6);
    await h.teardownMultiRegionPicker();
    await h.runTimers(60_000);
    assert.equal(h.requests.length, 6);
});

test('hidden initial load waits for visibility and resumes even in a joined single-region lobby', async t => {
    const h = createPickerHarness({ manifest: regions.slice(0, 1), hidden: true });
    t.after(() => h.service.stop());
    await h.initRegionService();
    await h.runTimers(60_000);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.domUpdates, []);
    h.sessionPicker.currentSessionId = 'joined';
    h.game.mode = 'session';
    h.game.state = 'lobby';
    h.visibility(false);
    await h.runTimers();
    assert.equal(h.requests.length, 3);
    assert.equal(h.getSingleRefreshes(), 1);
});

test('SessionClient notifications refresh only its region; explicit refresh still refreshes all', async t => {
    const h = createPickerHarness();
    t.after(() => h.service.stop());
    await h.initRegionService();
    h.regionalRefreshes.length = 0;
    h.setHubHostname(`${regions[1].hostname}/`);
    h.handleSessionListChanged();
    assert.deepEqual(h.regionalRefreshes, ['b']);
    h.setHubHostname('');
    h.handleSessionListChanged();
    assert.deepEqual(h.regionalRefreshes, ['b', 'a'], 'same-origin hub maps to its local region');
    h.setHubHostname('https://unlisted.example.com');
    h.handleSessionListChanged();
    assert.deepEqual(h.regionalRefreshes, ['b', 'a'], 'unknown host must not cause a fan-out');
    await h.refreshSessionList();
    assert.deepEqual(h.regionalRefreshes, ['b', 'a', 'a', 'b']);
    h.visibility(true);
    h.regionalRefreshes.length = 0;
    h.handleSessionListChanged();
    h.spectatorHandlers.get('sessionsChanged')('b');
    await h.refreshSessionList();
    assert.deepEqual(h.regionalRefreshes, []);
});

test('regional teardown does not block a rapid visible-picker restart', async t => {
    const closeResponse = deferred();
    const h = createPickerHarness({ closeResponse });
    t.after(() => h.service.stop());
    await h.initRegionService();
    await h.runTimers();
    const stopping = h.teardownMultiRegionPicker();
    await h.activateSessionPickerUpdates();
    await h.runTimers();
    closeResponse.resolve();
    await stopping;
    assert.ok(h.isSessionPickerActive());
    assert.equal(h.requests.length, 12);
    h.handleSessionListChanged();
    assert.equal(h.regionalRefreshes.at(-1), 'a', 'old shutdown must not disable the new run');
});

test('picker rendering helpers do not touch hidden DOM during gameplay or backgrounding', () => {
    const names = [
        'setPickerStatus', 'renderSessionList', 'updatePingCellsForRegion', 'renderRegionBanner',
        'renderCreateRegionSelector', 'updatePickerButtons', 'renderRegionDownBanner',
    ];
    for (const documentHidden of [false, true]) {
        const functions = loadInlineGameFunctions(['isSessionPickerVisible', ...names], {
            document: { hidden: documentHidden },
            startScreen: { classList: { contains: () => !documentHidden } },
            sessionPicker: new Proxy({}, { get: () => assert.fail('hidden picker DOM accessed') }),
        });
        for (const name of names) functions[name]();
    }
});
