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
