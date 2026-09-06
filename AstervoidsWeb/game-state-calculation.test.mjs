import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const { countExtraLivesForScore } = require('./wwwroot/js/game-config.js');
const codec = require('./wwwroot/js/astervoids-wire-codec.js');
const firstId = 'aaaaaaaa-0000-0000-0000-000000000001';
const secondId = 'bbbbbbbb-0000-0000-0000-000000000002';
const { calculateGameState, calculateGameStateTerminal } = loadInlineGameFunctions(
    ['calculateGameState', 'calculateGameStateTerminal'], { countExtraLivesForScore });

function calculate({
    persisted = {},
    hits = {},
    scores = {},
    ships = [],
    local = {},
    threshold = 100,
} = {}) {
    return calculateGameState(
        persisted, { processedHits: hits, processedScores: scores }, ships,
        { lives: 3, state: 'playing', observedScoreLifeAwardCount: null, ...local },
        threshold);
}

test('GameState calculation is deterministic and does not mutate its inputs', () => {
    const inputs = {
        persisted: Object.freeze({ lives: 3, groupScore: 90, peakShipCount: 1 }),
        hits: Object.freeze({ [firstId]: 1 }),
        scores: Object.freeze({ [firstId]: 90 }),
        ships: Object.freeze([
            Object.freeze({
                id: firstId.toUpperCase(),
                data: Object.freeze({ score: 110, hitCount: 2 }),
            }),
        ]),
        local: Object.freeze({ lives: 99 }),
    };
    const result = calculate(inputs);
    assert.deepEqual(calculate(inputs), result);
    assert.equal(result.groupScore, 110);
    assert.equal(result.lives, 3, 'persisted lives, award, then damage');
    assert.equal(result.scoreLifeAwardCount, 1);
    assert.equal(result.announceScoreLifeAward, true);
    assert.deepEqual(result.processedScores, { [firstId]: 110 });
    assert.deepEqual(result.processedHits, { [firstId]: 2 });
    assert.notEqual(result.processedScores, inputs.scores);
    assert.notEqual(result.processedHits, inputs.hits);
});

test('score lives precede damage and the player-count bonus cannot revive a terminal game', () => {
    const result = calculate({
        persisted: { lives: 1, groupScore: 90, peakShipCount: 0 },
        ships: [{ id: firstId, data: { score: 10, hitCount: 2 } }],
    });
    assert.equal(result.scoreLifeAwardCount, 1);
    assert.equal(result.announceScoreLifeAward, true);
    assert.equal(result.lives, 0);
    assert.equal(result.beatStopCount, 1);
    assert.equal(result.peakShipCount, 0);
});

test('damage clamps after each ship and retains each terminal beat-stop effect', () => {
    const result = calculate({
        persisted: { lives: 1, peakShipCount: 2 },
        ships: [
            { id: firstId, data: { hitCount: 3 } },
            { id: secondId, data: { hitCount: 2 } },
        ],
    });
    assert.equal(result.lives, 0);
    assert.equal(result.beatStopCount, 2);
    assert.deepEqual(result.processedHits, { [firstId]: 3, [secondId]: 2 });
});

test('departed ship scores and high-water ledgers survive repeat sync and migration', () => {
    const persisted = {
        lives: 4, groupScore: 150, scoreLifeAwardCount: 1, peakShipCount: 2,
        state: 'waveDelay',
    };
    const result = calculate({
        persisted,
        hits: { [firstId]: 2, [secondId]: 1 },
        scores: { [firstId]: 100, [secondId]: 50 },
        ships: [{ id: firstId, data: { score: 90, hitCount: 1 } }],
        local: { lives: 99, state: 'lobby' },
    });
    assert.equal(result.lives, 4);
    assert.equal(result.groupScore, 150);
    assert.equal(result.peakShipCount, 2);
    assert.equal(result.state, 'waveDelay');
    assert.equal(result.announceScoreLifeAward, false);
    assert.deepEqual(result.processedScores, { [firstId]: 100, [secondId]: 50 });
    assert.deepEqual(result.processedHits, { [firstId]: 2, [secondId]: 1 });
});

test('unconfirmed local score awards remain counted without repeated feedback', () => {
    const result = calculate({
        persisted: { lives: 3, groupScore: 200, scoreLifeAwardCount: 1 },
        local: { observedScoreLifeAwardCount: 2 },
    });
    assert.equal(result.lives, 4);
    assert.equal(result.scoreLifeAwardCount, 2);
    assert.equal(result.observedScoreLifeAwardCount, 2);
    assert.equal(result.announceScoreLifeAward, false);
});

test('player-count bonuses use the peak and terminal games never gain score awards', () => {
    const ships = [{ id: firstId }, { id: secondId }];
    assert.equal(calculate({ persisted: { lives: 3, peakShipCount: 1 }, ships }).lives, 4);
    const terminal = calculate({
        persisted: { lives: 0, groupScore: 300, peakShipCount: 0 }, ships,
    });
    assert.equal(terminal.lives, 0);
    assert.equal(terminal.scoreLifeAwardCount, 0);
    assert.equal(terminal.announceScoreLifeAward, false);
});

test('terminal calculation stamps once and preserves existing terminal anchors', () => {
    assert.deepEqual(calculateGameStateTerminal(1, {}, 10.7, 750),
        { gameOverAt: null, terminalAt: null });
    assert.deepEqual(calculateGameStateTerminal(0, {}, 10.7, 750),
        { gameOverAt: 11, terminalAt: 761 });
    assert.deepEqual(calculateGameStateTerminal(0, { gameOverAt: 11 }, 900, 750),
        { gameOverAt: 11, terminalAt: 761 });
    assert.deepEqual(calculateGameStateTerminal(0,
        { gameOverAt: 11, terminalAt: 700 }, 900, 750),
    { gameOverAt: 11, terminalAt: 700 });
});

function loadSyncHarness({ data = {}, ships = [], sessionMode = true, owner = true } = {}) {
    const events = [];
    const publications = [];
    const record = { data, version: 1 };
    const game = {
        score: 0, lives: 99, wave: 4, state: 'lobby',
        speedMultiplier: 1.2, waveDelayTimer: 80,
        multiplayer: { gameStateObjectId: 'gs', observedScoreLifeAwardCount: null },
    };
    const { syncGameState } = loadInlineGameFunctions([
        'calculateGameState', 'calculateGameStateTerminal',
        'applyCalculatedGameState', 'serializeGameState', 'syncGameState',
    ], {
        game, countExtraLivesForScore,
        malformedGameStateLedgerKey: null,
        CONFIG: { EXTRA_LIFE_SCORE_THRESHOLD: 100, DEADRECKON_GAMEOVER_TERMINAL_DELAY_MS: 750 },
        OBJECT_TYPES: { SHIP: 'ship', GAME_STATE: 'gameState' },
        isSessionMode: () => sessionMode,
        isGameStateOwner: () => owner,
        AstervoidsWireCodec: codec,
        announceExtraLifeAward: () => {
            assert.equal(game.score, 100);
            assert.equal(game.lives, 99, 'effects precede local life publication');
            events.push('award');
        },
        AudioSystem: { beat: { stop: () => events.push('stop') } },
        RemoteObjects: { serverNowMs: () => {
            assert.equal(game.lives, 0);
            events.push('clock');
            return 1000.4;
        } },
        _error: () => events.push('error'),
        ObjectSync: {
            getObject: () => record,
            getObjectsByType: () => ships,
            updateObject: (id, payload, immediate) => {
                events.push('publish');
                publications.push({ id, payload, immediate });
            },
        },
    });
    return { syncGameState, game, record, events, publications };
}

test('GameState effects precede terminal clock sampling and packed publication', () => {
    const harness = loadSyncHarness({
        data: { lives: 1, groupScore: 90, peakShipCount: 1, state: 'playing' },
        ships: [{ id: firstId, data: { score: 10, hitCount: 2 } }],
    });
    harness.syncGameState(true);
    assert.deepEqual(harness.events, ['award', 'stop', 'clock', 'publish']);
    const { id, payload, immediate } = harness.publications[0];
    assert.equal(id, 'gs');
    assert.equal(immediate, true);
    assert.deepEqual(payload, {
        type: 'gameState', gameStarted: true, wave: 4, state: 'playing',
        lives: 0, groupScore: 100, speedMultiplier: 1.2, waveDelayTimer: 80,
        processedHits: codec.packCounterMap({ [firstId]: 2 }),
        processedScores: codec.packCounterMap({ [firstId]: 10 }),
        peakShipCount: 1, gameOverAt: 1000, terminalAt: 1750, scoreLifeAwardCount: 1,
    });
    harness.record.data = payload;
    harness.events.length = 0;
    harness.syncGameState();
    assert.deepEqual(harness.events, ['publish'], 'no repeat effects or clock sampling');
});

test('malformed ledgers refuse all effects and publication, logging once per object version', () => {
    for (const field of ['processedHits', 'processedScores']) {
        const harness = loadSyncHarness({ data: { [field]: new Uint8Array([1]) } });
        const initialGame = structuredClone(harness.game);
        harness.syncGameState();
        harness.syncGameState();
        assert.deepEqual(harness.events, ['error']);
        assert.deepEqual(harness.game, initialGame);
        assert.equal(harness.publications.length, 0);
        harness.record.version++;
        harness.syncGameState();
        assert.deepEqual(harness.events, ['error', 'error']);
        harness.record.data = { lives: 2, peakShipCount: 0 };
        harness.syncGameState();
        assert.equal(harness.publications.length, 1);
    }
});

test('non-owners and solo players never calculate or publish GameState', () => {
    for (const options of [{ owner: false }, { sessionMode: false }]) {
        const harness = loadSyncHarness(options);
        harness.syncGameState(true);
        assert.deepEqual(harness.events, []);
    }
});
