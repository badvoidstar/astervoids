import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');

test('every former HUD publication point explicitly preserves debug metric cadence', () => {
    const calls = [...source.matchAll(/(?<!function )\bupdateHUD\(\);/g)];
    assert.equal(calls.length, 9);
    for (const call of calls) {
        assert.match(source.slice(call.index),
            /^updateHUD\(\);\s*publishDebugMetrics\(\);/);
    }
    assert.equal([...source.matchAll(/\bpublishDebugMetrics\(\);/g)].length, 9);
});

test('HUD rendering no longer computes or publishes debug metrics', () => {
    const game = { state: 'playing', score: 20, wave: 2, lives: 3 };
    const hudCache = {};
    const scoreDisplay = {};
    const waveDisplay = {};
    const livesDisplay = {};
    const { updateHUD } = loadInlineGameFunctions(['updateHUD'], {
        game, hudCache, scoreDisplay, waveDisplay, livesDisplay,
        hudDisplay: null,
        isSessionMode: () => false,
        document: { getElementById: () => null },
        publishDebugMetrics: () => assert.fail('implicit publication'),
    });
    updateHUD();
    assert.deepEqual([scoreDisplay.textContent, waveDisplay.textContent, livesDisplay.textContent],
        ['Score: 20', 'Wave: 2', 'Lives: 3']);
});

test('debug metrics retain their heartbeat gate, fields, rounding, and per-call freshness', () => {
    const messages = [];
    let now = 1999;
    let sessionMode = true;
    let objectCount = 7;
    let scans = 0;
    const { publishDebugMetrics } = loadInlineGameFunctions(['publishDebugMetrics'], {
        game: { sessionInfo: { name: 'Test session' } },
        isSessionMode: () => sessionMode,
        debugLastHeartbeat: 1000,
        DEBUG_HEARTBEAT_TIMEOUT: 1000,
        Date: { now: () => now },
        debugChannel: { postMessage: metrics => messages.push(metrics) },
        SessionClient: { getCurrentMember: () => ({ id: 'me' }) },
        ObjectSync: {
            getObjectCount: () => { scans++; return objectCount; },
            getObjectsByOwner: id => { assert.equal(id, 'me'); return [1, 2]; },
            getSendRate: () => 30,
            getReconciliationCount: () => 3,
        },
        fpsTracker: { getFps: () => 60 },
        RemoteObjects: {
            memberDelays: new Map([['other', { remoteSendInterval: 20.6, computedDelay: 30.4 }]]),
            getRtt: () => 10.6,
            getJitter: () => 2.4,
            getDelay: () => 80.5,
            getClockOffsetMs: () => -4.7,
            getClockSampleRtt: () => 9.6,
            clock: { sampleCount: 12, rejectedCount: 2 },
            isClockOffsetInitialized: () => true,
        },
    });
    publishDebugMetrics();
    assert.deepEqual(messages[0], {
        rtt: 11, tx: 33, jitter: 2, buf: 81, fps: 60,
        ownedObjs: 2, totalObjs: 7, reconciliationCount: 3,
        sessionName: 'Test session', myMemberId: 'me',
        members: { other: { remoteSendInterval: 21, computedDelay: 30 } },
        clockOffsetMs: -5, clockSampleRtt: 10, clockSampleCount: 12,
        clockRejectedCount: 2, clockOffsetInitialized: true,
    });
    objectCount = 8;
    publishDebugMetrics();
    assert.equal(messages[1].totalObjs, 8, 'no throttling or cached metrics');
    now = 2000;
    publishDebugMetrics();
    now = 1999;
    sessionMode = false;
    publishDebugMetrics();
    assert.equal(messages.length, 2);
    assert.equal(scans, 2, 'inactive listeners do not scan objects');
});
