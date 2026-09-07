import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

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

function loadConnectionStatusUpdater({
    sessionPicker,
    clientSession,
    game,
    status,
    regionalReadiness = () => ({ assessmentsComplete: true, hasAvailableRegion: true }),
    browserNavigator = { onLine: true },
}) {
    const factory = new Function(
        'sessionPicker',
        'SessionClient',
        'game',
        'setPickerStatus',
        'getRegionalCreateReadiness',
        'navigator',
        `${statusFunction[0]}; ${connectionStatusFunction}; return updatePickerConnectionStatus;`
    );
    return factory(
        sessionPicker,
        { getCurrentSession: () => clientSession },
        game,
        (message, type = '') => Object.assign(status, { message, type }),
        regionalReadiness,
        browserNavigator,
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
    const browserNavigator = { onLine: true };
    const updateStatus = loadConnectionStatusUpdater({
        sessionPicker,
        clientSession: null,
        game: {},
        status,
        browserNavigator,
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
    assert.deepEqual(status, { message: 'Connection unavailable', type: 'error' });

    browserNavigator.onLine = false;
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
    const browserNavigator = { onLine: true };
    const updateStatus = loadConnectionStatusUpdater({
        sessionPicker,
        clientSession,
        game: { sessionInfo: { id: 'session-1', name: 'Swift Mango' } },
        status,
        browserNavigator,
    });

    updateStatus();
    assert.deepEqual(status, { message: 'Connecting...', type: 'connecting' });

    sessionPicker.connectionState = 'connected';
    updateStatus();
    assert.deepEqual(status, { message: 'In Swift Mango (member)', type: '' });

    sessionPicker.connectionState = 'offline';
    updateStatus();
    assert.deepEqual(status, { message: 'Connection unavailable', type: 'error' });

    browserNavigator.onLine = false;
    updateStatus();
    assert.deepEqual(status, { message: 'Offline - Solo play only', type: 'error' });
});

test('online regional startup stays connecting through assessment and reports connected afterward', () => {
    const sessionPicker = {
        currentSessionId: null,
        sessions: [],
        maxSessions: 6,
        connectionState: 'connecting',
        regionDiscoveryState: 'loading',
        regions: [],
        isServer: false,
    };
    const status = {};
    const browserNavigator = { onLine: true };
    let readiness = { assessmentsComplete: false, hasAvailableRegion: false };
    const updateStatus = loadConnectionStatusUpdater({
        sessionPicker,
        clientSession: null,
        game: {},
        status,
        browserNavigator,
        regionalReadiness: () => readiness,
    });

    updateStatus();
    assert.deepEqual(status, { message: 'Connecting...', type: 'connecting' });

    sessionPicker.regionDiscoveryState = 'loaded';
    sessionPicker.regions = [{ id: 'westus2' }, { id: 'eastus' }];
    readiness = { assessmentsComplete: true, hasAvailableRegion: true };
    sessionPicker.connectionState = 'offline'; // Static apex has no same-origin hub.
    updateStatus();
    assert.deepEqual(status, { message: 'Connected - 0/6 sessions', type: 'connected' });

    readiness = { assessmentsComplete: true, hasAvailableRegion: false };
    updateStatus();
    assert.deepEqual(status, { message: 'Regional servers unavailable', type: 'error' });

    browserNavigator.onLine = false;
    updateStatus();
    assert.deepEqual(status, { message: 'Offline - Solo play only', type: 'error' });
});

test('single-region hub failure does not claim regional connectivity', () => {
    const sessionPicker = {
        currentSessionId: null,
        sessions: [],
        maxSessions: 6,
        connectionState: 'offline',
        regionDiscoveryState: 'loaded',
        regions: [{ id: 'westus2' }],
        isServer: false,
    };
    const status = {};
    const updateStatus = loadConnectionStatusUpdater({
        sessionPicker,
        clientSession: null,
        game: {},
        status,
        regionalReadiness: () => ({ assessmentsComplete: true, hasAvailableRegion: true }),
    });

    updateStatus();
    assert.deepEqual(status, { message: 'Connection unavailable', type: 'error' });
});

test('region assessment updates refresh the picker status line', () => {
    const initStart = html.indexOf('async function initRegionService()');
    const multiRegionStart = html.indexOf('let multiRegionActive = false;', initStart);
    assert.ok(initStart >= 0 && multiRegionStart > initStart);

    const initSource = html.slice(initStart, multiRegionStart);
    assert.match(
        initSource,
        /on\('rttUpdated',[\s\S]*?updatePickerConnectionStatus\(\);/,
        'the final RTT/unavailable assessment must replace Connecting with the current regional status');
    assert.match(
        initSource,
        /on\('regionsLoaded',[\s\S]*?updatePickerConnectionStatus\(\);/,
        'loading a multi-region manifest must immediately enter the assessment status flow');
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

test('entering session gameplay tears down picker updates before initialization', () => {
    const startGameStart = html.indexOf('async function startGameFromPicker()');
    const returnStart = html.indexOf('async function returnToStartScreen', startGameStart);
    assert.ok(startGameStart >= 0 && returnStart > startGameStart);

    const startGameSource = html.slice(startGameStart, returnStart);
    assert.match(
        startGameSource,
        /if \(context\.mode === 'session' && sessionPicker\.regions\.length > 1\) \{[\s\S]*?await teardownMultiRegionPicker\(\);[\s\S]*?await init\(isCurrent\);/
    );
});

test('solo play starts without waiting for regional or session services', () => {
    const soloSource = extractFunctionSource('handleSoloPlay');
    const startGameSource = extractFunctionSource('startGameFromPicker');
    const leaveSource = extractFunctionSource('leaveSessionInBackground');

    assert.match(
        html,
        /<button id="btn-solo" class="picker-btn solo">Start Solo Play<\/button>/);
    assert.match(soloSource, /cancelPickerOperations\(\);/);
    assert.match(
        soloSource,
        /void teardownMultiRegionPicker\(\)\.catch\(/,
        'regional teardown must continue in the background');
    assert.match(
        soloSource,
        /leaveSessionInBackground\('Failed to leave session before solo:'\);/,
        'session departure must continue in the background');
    assert.match(leaveSource, /void SessionClient\.leaveSession\(\)\.catch\(/);
    assert.doesNotMatch(soloSource, /await (teardownMultiRegionPicker|SessionClient\.leaveSession)\(/);
    assert.match(
        startGameSource,
        /context\.mode === 'session' && sessionPicker\.regions\.length > 1/,
        'only session gameplay may wait for regional teardown');
});

test('a transport disconnect cannot interrupt an active solo game', () => {
    const disconnectStart = html.indexOf("SessionClient.on('onDisconnected'");
    const expirationStart = html.indexOf("SessionClient.on('onSessionExpired'", disconnectStart);
    const roleChangeStart = html.indexOf("SessionClient.on('onRoleChanged'", expirationStart);
    assert.ok(disconnectStart >= 0 && expirationStart > disconnectStart);
    assert.ok(roleChangeStart > expirationStart);

    const disconnectSource = html.slice(disconnectStart, expirationStart);
    const expirationSource = html.slice(expirationStart, roleChangeStart);
    assert.match(
        disconnectSource,
        /if \(leavingSession \|\| isActiveSoloGame\(\)\) return;/
    );
    assert.match(expirationSource, /if \(!isSessionMode\(\)\) return;/);
});

test('solo play cancels delayed join and create workflows', () => {
    const selectSource = extractFunctionSource('handleSelectSession');
    const createSource = extractFunctionSource('handleCreateSession');

    for (const source of [selectSource, createSource]) {
        assert.match(source, /const isCurrentOperation = beginPickerOperation\(\);/);
        assert.match(source, /if \(!isCurrentOperation\(\)\) return;/);
        assert.match(
            source,
            /if \(result && isActiveSoloGame\(\)\) \{\s*leaveSessionInBackground\('Failed to leave session after starting solo play:'\);/
        );
    }
});

test('solo play cleans up a delayed auto-rejoin', () => {
    const rejoinSource = extractFunctionSource('attemptAutoRejoin');

    assert.match(
        rejoinSource,
        /const result = await SessionClient\.joinSession\(sessionId\);\s*if \(leavingSession \|\| !isSessionMode\(\)\) \{\s*if \(result && isActiveSoloGame\(\)\) \{\s*leaveSessionInBackground\(\s*'Failed to leave session after starting solo play:'\);/
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

test('successful membership helpers keep snapshot epochs and identity separate from path-specific state', () => {
    for (const role of ['Server', 'Client']) {
        const calls = [];
        const game = { state: 'waveDelay', connectionLost: true };
        const sessionPicker = { gameStarted: false };
        const result = {
            session: {
                id: 's', name: 'Test session', metadata: { seed: 7 },
                objects: [{ id: 'existing' }],
            },
            member: { id: 'm', role },
        };
        const { beginSessionSnapshot, applySessionMembership } = loadInlineGameFunctions(
            ['beginSessionSnapshot', 'applySessionMembership'], {
                game, sessionPicker,
                SessionClient: { getSessionEpoch: () => 42 },
                replicationRuntime: { beginSession: context => calls.push(context) },
                adoptSessionConfig: metadata => calls.push(metadata),
            });
        beginSessionSnapshot(result);
        applySessionMembership(result);
        assert.deepEqual(calls, [
            { epoch: 42, snapshotObjectIds: ['existing'] }, result.session.metadata,
        ]);
        assert.deepEqual(game.sessionInfo, {
            id: 's', name: 'Test session', memberId: 'm', role, metadata: result.session.metadata,
        });
        assert.equal(game.mode, 'session');
        assert.equal(game.state, 'waveDelay', 'rejoin controls its own transition');
        assert.equal(game.connectionLost, true, 'membership must not unfreeze rejoin');
        assert.equal(sessionPicker.currentSessionId, 's');
        assert.equal(sessionPicker.isServer, role === 'Server');
        assert.equal(sessionPicker.gameStarted, false, 'create and join retain explicit game-start policy');
    }
});

test('voluntary leave bookkeeping blocks rejoin synchronously without clearing picker selection', async () => {
    const sessionPicker = {
        currentSessionId: 's', isServer: true, gameStarted: true, selectedSessionId: 's',
    };
    const logs = [];
    const { beginVoluntarySessionLeave, attemptAutoRejoin } = loadInlineGameFunctions([
        'clearPickerMembership', 'beginVoluntarySessionLeave', 'attemptAutoRejoin',
    ], {
        sessionPicker, leavingSession: false, rejoinInProgress: false,
        isSessionMode: () => true,
        _log: (...args) => logs.push(args),
    });
    beginVoluntarySessionLeave();
    assert.deepEqual(sessionPicker, {
        currentSessionId: null, isServer: false, gameStarted: false, selectedSessionId: 's',
    });
    await attemptAutoRejoin('s');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][2], 'leavingSession:');
    assert.equal(logs[0][3], true);
});

test('shared solo-mode reset restores local configuration after clearing session identity', () => {
    const game = { mode: 'session', sessionInfo: { id: 's' }, state: 'lobby' };
    let restored = false;
    const { restoreSoloMode } = loadInlineGameFunctions(['restoreSoloMode'], {
        game,
        restoreLocalConfigBaseline: () => {
            assert.equal(game.mode, 'solo');
            assert.equal(game.sessionInfo, null);
            restored = true;
        },
    });
    restoreSoloMode();
    assert.equal(restored, true);
    assert.equal(game.state, 'lobby', 'caller retains state-transition ordering');
});

test('leave and rejoin paths keep guards and reset-before-snapshot ordering explicit', () => {
    for (const name of ['handleLeaveLobby', 'returnToStartScreen']) {
        const source = extractFunctionSource(name);
        assert.ok(source.indexOf('beginVoluntarySessionLeave();') < source.indexOf('await '));
        assert.ok(source.indexOf('resetMultiplayerState();') < source.indexOf('restoreSoloMode();'));
        assert.match(source, /finally \{\s*leavingSession = false;/);
    }
    const rejoin = extractFunctionSource('attemptAutoRejoin');
    const markers = [
        'ObjectSync.suspendReconciliation();',
        'resetMultiplayerState();',
        'await SessionClient.joinSession(sessionId)',
        'if (leavingSession || !isSessionMode())',
        'beginSessionSnapshot(result);',
        'applySessionMembership(result);',
        'await startGameFromPicker();',
        'game.connectionLost = false;',
        'ObjectSync.resumeReconciliation();',
    ];
    let offset = 0;
    for (const marker of markers) {
        const next = rejoin.indexOf(marker, offset);
        assert.ok(next >= offset, `rejoin preserves ${marker}`);
        offset = next + marker.length;
    }
    for (const name of ['handleSelectSession', 'handleCreateSession']) {
        const source = extractFunctionSource(name);
        assert.match(source, /if \(!isCurrentOperation\(\)\) \{[\s\S]*?return;[\s\S]*?beginSessionSnapshot\(result\);/);
        assert.ok(source.indexOf('beginSessionSnapshot(result);')
            < source.indexOf('applySessionMembership(result);'));
    }
});
