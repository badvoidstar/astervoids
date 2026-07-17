import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'wwwroot/index.html'), 'utf8');
const statusFunction = html.match(
    /function updateCurrentSessionStatus\(\) \{[\s\S]*?\n {4}\}/
);

assert.ok(statusFunction, 'updateCurrentSessionStatus must be defined in index.html');

function extractFunctionSource(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must be defined in index.html`);
    const bodyStart = html.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < html.length; index++) {
        if (html[index] === '{') depth++;
        if (html[index] === '}') depth--;
        if (depth === 0) return html.slice(start, index + 1);
    }
    assert.fail(`could not find the end of ${name}`);
}

const connectionStatusFunction = extractFunctionSource('updatePickerConnectionStatus');
const regionalReadinessFunction = extractFunctionSource('getRegionalCreateReadiness');

function loadStatusUpdater({ sessionPicker, clientSession, game, status }) {
    const factory = new Function(
        'sessionPicker',
        'SessionClient',
        'game',
        'setPickerStatus',
        `${statusFunction[0]}; return updateCurrentSessionStatus;`
    );
    return factory(
        sessionPicker,
        { getCurrentSession: () => clientSession },
        game,
        (message, type = '') => Object.assign(status, { message, type })
    );
}

function loadConnectionStatusUpdater({ sessionPicker, clientSession, game, status }) {
    const factory = new Function(
        'sessionPicker',
        'SessionClient',
        'game',
        'setPickerStatus',
        `${statusFunction[0]}; ${connectionStatusFunction}; return updatePickerConnectionStatus;`
    );
    return factory(
        sessionPicker,
        { getCurrentSession: () => clientSession },
        game,
        (message, type = '') => Object.assign(status, { message, type })
    );
}

function loadRegionalReadiness({ sessionPicker, regionService }) {
    const factory = new Function(
        'sessionPicker',
        'window',
        `${regionalReadinessFunction}; return getRegionalCreateReadiness;`
    );
    return factory(sessionPicker, { RegionService: regionService });
}

test('connected session status does not depend on the multi-region list worker', () => {
    const sessionPicker = {
        currentSessionId: 'session-1',
        sessions: [],
        isServer: false
    };
    const clientSession = {
        id: 'session-1',
        name: 'Swift Mango',
        members: [{ id: 'member-1' }]
    };
    const game = {
        sessionInfo: { id: 'session-1', name: 'Swift Mango' }
    };
    const status = { message: 'Connecting...', type: 'connecting' };
    const updateStatus = loadStatusUpdater({ sessionPicker, clientSession, game, status });

    assert.equal(updateStatus(), true);
    assert.deepEqual(status, {
        message: 'In Swift Mango (member)',
        type: ''
    });
});

test('connected session status uses live membership with listed capacity', () => {
    const sessionPicker = {
        currentSessionId: 'session-1',
        sessions: [{
            id: 'session-1',
            name: 'Swift Mango',
            memberCount: 1,
            maxMembers: 4
        }],
        isServer: true
    };
    const clientSession = {
        id: 'session-1',
        name: 'Swift Mango',
        members: [{ id: 'member-1' }, { id: 'member-2' }]
    };
    const game = {
        sessionInfo: { id: 'session-1', name: 'Swift Mango' }
    };
    const status = {};
    const updateStatus = loadStatusUpdater({ sessionPicker, clientSession, game, status });

    updateStatus();

    assert.equal(status.message, 'In Swift Mango (host) - 2/4');
});

test('transport status distinguishes connecting, connected, reconnecting, and offline', () => {
    const sessionPicker = {
        currentSessionId: null,
        sessions: [],
        maxSessions: 6,
        connectionState: 'connecting',
        isServer: false,
    };
    const status = {};
    const updateStatus = loadConnectionStatusUpdater({
        sessionPicker,
        clientSession: null,
        game: {},
        status,
    });

    updateStatus();
    assert.deepEqual(status, { message: 'Connecting...', type: 'connecting' });

    sessionPicker.connectionState = 'connected';
    updateStatus();
    assert.deepEqual(status, { message: 'Connected - 0/6 sessions', type: 'connected' });

    sessionPicker.connectionState = 'reconnecting';
    updateStatus();
    assert.deepEqual(status, { message: 'Reconnecting...', type: 'connecting' });

    sessionPicker.connectionState = 'offline';
    updateStatus();
    assert.deepEqual(status, { message: 'Offline - Solo play only', type: 'error' });
});

test('transport status overrides stale in-session text until the connection is restored', () => {
    const sessionPicker = {
        currentSessionId: 'session-1',
        sessions: [],
        maxSessions: 6,
        connectionState: 'connecting',
        isServer: false,
    };
    const clientSession = {
        id: 'session-1',
        name: 'Swift Mango',
        members: [{ id: 'member-1' }],
    };
    const status = {};
    const updateStatus = loadConnectionStatusUpdater({
        sessionPicker,
        clientSession,
        game: { sessionInfo: { id: 'session-1', name: 'Swift Mango' } },
        status,
    });

    updateStatus();
    assert.deepEqual(status, { message: 'Connecting...', type: 'connecting' });

    sessionPicker.connectionState = 'connected';
    updateStatus();
    assert.deepEqual(status, { message: 'In Swift Mango (member)', type: '' });

    sessionPicker.connectionState = 'offline';
    updateStatus();
    assert.deepEqual(status, { message: 'Offline - Solo play only', type: 'error' });
});

test('regional create readiness waits for every assessment but accepts concluded outages', () => {
    const sessionPicker = {
        regionDiscoveryState: 'loaded',
        regions: [{ id: 'westus2' }, { id: 'eastus' }],
    };
    let allAssessed = false;
    const available = new Set(['westus2']);
    const getReadiness = loadRegionalReadiness({
        sessionPicker,
        regionService: {
            areAllRegionsAssessed: () => allAssessed,
            isRegionAvailable: id => available.has(id),
        },
    });

    assert.deepEqual(getReadiness(), {
        assessmentsComplete: false,
        hasAvailableRegion: true,
    }, 'one warming region must keep Create unavailable');

    allAssessed = true; // eastus completed as unavailable
    assert.deepEqual(getReadiness(), {
        assessmentsComplete: true,
        hasAvailableRegion: true,
    }, 'an unavailable peer concludes assessment while a measured peer remains usable');

    available.clear();
    assert.deepEqual(getReadiness(), {
        assessmentsComplete: true,
        hasAvailableRegion: false,
    }, 'all-unavailable regions must not leave an enabled Create target');
});

test('join and create reactivate live picker updates after membership succeeds', () => {
    const joinStart = html.indexOf('async function handleSelectSession(sessionId)');
    const createStart = html.indexOf('async function handleCreateSession()');
    const soloStart = html.indexOf('async function handleSoloPlay()');
    assert.ok(joinStart >= 0 && createStart > joinStart && soloStart > createStart);

    const joinSource = html.slice(joinStart, createStart);
    const createSource = html.slice(createStart, soloStart);
    const statusBeforeActivation =
        /updateCurrentSessionStatus\(\);[\s\S]*?await activateSessionPickerUpdates\(\);/;

    assert.match(joinSource, statusBeforeActivation);
    assert.match(createSource, statusBeforeActivation);
});

test('create is guarded by regional readiness and avoids a global refresh during handoff', () => {
    const createStart = html.indexOf('async function handleCreateSession()');
    const soloStart = html.indexOf('async function handleSoloPlay()', createStart);
    const connectStart = html.indexOf('async function connectToSessionHub(');
    const selectStart = html.indexOf('async function handleSelectSession(', connectStart);
    assert.ok(createStart >= 0 && soloStart > createStart && connectStart >= 0 && selectStart > connectStart);

    const createSource = html.slice(createStart, soloStart);
    const connectSource = html.slice(connectStart, selectStart);
    assert.match(
        createSource,
        /const createEligibility = getCreateEligibility\(\);[\s\S]*?if \(!createEligibility\.canCreateNow\)/,
        'programmatic or stale clicks must be rejected by the same readiness gate as the button');
    assert.match(
        createSource,
        /await connectToSessionHub\(true, targetHostname, false\);/,
        'Create must not wait for a global multi-region session refresh after it has selected a host');
    assert.match(
        connectSource,
        /async function connectToSessionHub\(force = false, hubHostname = '', refreshSessions = true\)/);
    assert.match(
        connectSource,
        /if \(refreshSessions\) \{[\s\S]*?await refreshSessionList\(\);/,
        'normal connection startup may refresh, while routed Create explicitly opts out');
});

test('entering gameplay tears down picker updates before initialization', () => {
    const startGameStart = html.indexOf('async function startGameFromPicker()');
    const returnStart = html.indexOf('async function returnToStartScreen', startGameStart);
    assert.ok(startGameStart >= 0 && returnStart > startGameStart);

    const startGameSource = html.slice(startGameStart, returnStart);
    assert.match(
        startGameSource,
        /await teardownMultiRegionPicker\(\);[\s\S]*?await init\(isCurrent\);/
    );
});

test('visibility resume includes the lobby of an active session', () => {
    const visibilityStart = html.indexOf(
        "document.addEventListener('visibilitychange'",
        html.indexOf('async function initMultiRegionPicker')
    );
    const startFunction = html.indexOf(
        'async function startMultiRegionPicker()',
        visibilityStart
    );
    assert.ok(visibilityStart >= 0 && startFunction > visibilityStart);

    const visibilitySource = html.slice(visibilityStart, startFunction);
    assert.match(
        visibilitySource,
        /multiRegionActive && !startScreen\.classList\.contains\('hidden'\)/
    );
    assert.doesNotMatch(visibilitySource, /!sessionPicker\.currentSessionId/);

    const startSource = html.slice(
        startFunction,
        html.indexOf('async function pauseMultiRegionPicker()', startFunction)
    );
    assert.match(
        startSource,
        /if \(startScreen\.classList\.contains\('hidden'\)\) return;[\s\S]*?multiRegionActive = true;[\s\S]*?if \(document\.hidden\) return;/
    );
});
