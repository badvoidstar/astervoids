import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { loadClassicModule } from './test-support/classic-module.mjs';

const require = createRequire(import.meta.url);
const { countExtraLivesForScore } = require('./wwwroot/js/game-config.js');
const codec = require('./wwwroot/js/astervoids-wire-codec.js');
const firstId = 'aaaaaaaa-0000-0000-0000-000000000001';
const secondId = 'bbbbbbbb-0000-0000-0000-000000000002';
const thirdId = 'cccccccc-0000-0000-0000-000000000003';
// Participants are identified by GUID, like the member ids they are seeded from.
const participant = letter => `${letter.repeat(8)}-1111-1111-1111-111111111111`;
const participantA = participant('a');
const participantB = participant('b');
const participantC = participant('c');
const member = letter => `${letter.repeat(8)}-2222-2222-2222-222222222222`;
const memberA = member('a');
const memberB = member('b');
const memberC = member('c');
const { calculateGameState, calculateGameStateTerminal } = loadInlineGameFunctions(
    ['calculateGameState', 'calculateGameStateTerminal'],
    { countExtraLivesForScore, GuidUtils: require('./wwwroot/js/guid-utils.js') });

function calculate({
    persisted = {},
    hits = {},
    scores = {},
    counted = {},
    ships = [],
    local = {},
    threshold = 100,
} = {}) {
    return calculateGameState(
        persisted,
        { processedHits: hits, processedScores: scores, countedParticipants: counted },
        ships,
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
        ships: [{ id: firstId, ownerMemberId: 'member-a', data: { score: 10, hitCount: 2 } }],
    });
    assert.equal(result.scoreLifeAwardCount, 1);
    assert.equal(result.announceScoreLifeAward, true);
    assert.equal(result.lives, 0);
    assert.equal(result.beatStopCount, 1);
    assert.equal(result.peakShipCount, 0);
    assert.deepEqual(result.countedParticipants, {}, 'a terminal game counts no newcomers');
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
    const ships = [
        { id: firstId, ownerMemberId: memberA, data: { participantId: participantA } },
        { id: secondId, ownerMemberId: memberB, data: { participantId: participantB } },
    ];
    const bonus = calculate({
        persisted: { lives: 3, peakShipCount: 1 },
        counted: { [participantA]: 1 },
        ships,
    });
    assert.equal(bonus.lives, 4);
    assert.equal(bonus.peakShipCount, 2);
    assert.deepEqual(bonus.countedParticipants,
        { [participantA]: 1, [participantB]: 1 });
    const terminal = calculate({
        persisted: { lives: 0, groupScore: 300, peakShipCount: 0 }, ships,
    });
    assert.equal(terminal.lives, 0);
    assert.equal(terminal.scoreLifeAwardCount, 0);
    assert.equal(terminal.announceScoreLifeAward, false);
});

test('every participant is worth exactly one life, whoever they follow', () => {
    // The first participant plays on the base lives; each additional one adds a
    // life the first time they are seen, in any order and from any starting ledger.
    const ship = (id, participantId) => ({
        id, ownerMemberId: id, data: { participantId },
    });
    const solo = calculate({ persisted: { lives: 3 }, ships: [ship(firstId, participantA)] });
    assert.equal(solo.lives, 3, 'the first participant is covered by the base lives');
    assert.equal(solo.peakShipCount, 1);

    // Everyone already aboard when the GameState object is created is counted on
    // the first sync, instead of being swallowed by a creation-time ship sample.
    const crowd = calculate({
        persisted: { lives: 3 },
        ships: [ship(firstId, participantA), ship(secondId, participantB),
            ship(thirdId, participantC)],
    });
    assert.equal(crowd.lives, 5);
    assert.equal(crowd.peakShipCount, 3);

    // The bug: a newcomer entering after somebody left used to refill the
    // vacated slot for free because the concurrent ship count never exceeded the
    // peak. The ledger makes the award depend on the player, not on churn.
    const afterDeparture = calculate({
        persisted: { lives: 4, peakShipCount: 2 },
        counted: { [participantA]: 1, [participantB]: 1 },
        ships: [ship(firstId, participantA), ship(thirdId, participantC)],
    });
    assert.equal(afterDeparture.lives, 5);
    assert.equal(afterDeparture.peakShipCount, 3);
    assert.deepEqual(afterDeparture.countedParticipants,
        { [participantA]: 1, [participantB]: 1, [participantC]: 1 });
});

test('a returning participant is never counted twice, however their ship or member changes', () => {
    const persisted = { lives: 4, peakShipCount: 2 };
    const counted = { [participantA]: 1, [participantB]: 1 };
    // Re-entering the game takes a fresh ship object, and a reconnect also mints
    // a fresh member id; participantId is the only identity that survives both.
    const rejoined = calculate({
        persisted, counted,
        ships: [
            { id: firstId, ownerMemberId: memberA, data: { participantId: participantA } },
            { id: thirdId, ownerMemberId: memberC, data: { participantId: participantB } },
        ],
    });
    assert.equal(rejoined.lives, 4);
    assert.equal(rejoined.peakShipCount, 2);
    assert.deepEqual(rejoined.countedParticipants, counted);

    // Repeating the calculation (every sync tick, and on the new owner after an
    // ownership migration) is idempotent, and casing never splits an identity.
    const migrated = calculate({
        persisted: { ...persisted, lives: rejoined.lives },
        counted: rejoined.countedParticipants,
        ships: [{
            id: firstId, ownerMemberId: memberA.toUpperCase(),
            data: { participantId: participantA.toUpperCase() },
        }],
    });
    assert.equal(migrated.lives, 4);
    assert.deepEqual(migrated.countedParticipants, counted);
});

test('ships without a reconnect-safe identity are never counted', () => {
    const result = calculate({
        persisted: { lives: 3, peakShipCount: 1 },
        counted: { [participantA]: 1 },
        ships: [
            { id: firstId, ownerMemberId: memberA, data: { participantId: participantA } },
            // The owning member is not a stable identity — it changes on every
            // reconnect — so a ship that publishes no participantId is skipped
            // rather than counted (and re-counted) through its owner.
            { id: secondId, ownerMemberId: memberB, data: { memberId: memberB } },
            // A malformed id must not reach the GUID-keyed ledger packer.
            { id: thirdId, ownerMemberId: memberC, data: { participantId: 'not-a-guid' } },
        ],
    });
    assert.equal(result.lives, 3);
    assert.deepEqual(result.countedParticipants, { [participantA]: 1 });
});

test('the ledger stops growing at the peak field ceiling instead of overflowing it', () => {
    const counted = {};
    for (let i = 0; i < 255; i++) {
        counted[`${i.toString(16).padStart(8, '0')}-3333-3333-3333-333333333333`] = 1;
    }
    const result = calculate({
        persisted: { lives: 3, peakShipCount: 255 },
        counted,
        ships: [{ id: firstId, ownerMemberId: memberA, data: { participantId: participantA } }],
    });
    assert.equal(result.peakShipCount, 255);
    assert.equal(result.lives, 3);
    assert.equal(Object.keys(result.countedParticipants).length, 255);
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

test('the standalone serializer still packs pure calculation results without a cache', () => {
    const { serializeGameState } = loadInlineGameFunctions(['serializeGameState'], {
        game: { wave: 2, state: 'playing', speedMultiplier: 1, waveDelayTimer: 0 },
        OBJECT_TYPES: { GAME_STATE: 'gameState' },
        AstervoidsWireCodec: codec,
    });
    const next = calculate({
        persisted: { lives: 3, peakShipCount: 1 },
        ships: [{ id: firstId, data: { score: 20, hitCount: 1 } }],
    });
    const payload = serializeGameState(next, { gameOverAt: null, terminalAt: null });
    assert.equal(payload.groupScore, 20);
    assert.equal(payload.lives, 2);
    assert.deepEqual(codec.unpackCounterMap(payload.processedScores), { [firstId]: 20 });
    assert.deepEqual(codec.unpackCounterMap(payload.processedHits), { [firstId]: 1 });
});

function loadSyncHarness({
    data = {}, ships = [], sessionMode = true, owner = true, optimistic = true,
    objectSync = null,
} = {}) {
    const events = [];
    const publications = [];
    const awardStates = [];
    const counts = { calculate: 0, pack: 0, unpack: 0 };
    const terminalCalls = [];
    const record = { id: 'gs', data, version: 1, ownerMemberId: 'member-a' };
    const controls = {
        sessionMode, owner, epoch: 1, memberId: 'member-a', record,
        optimistic, writeResult: true, throwWrite: false, clock: 1000.4,
    };
    const config = {
        EXTRA_LIFE_SCORE_THRESHOLD: 100,
        DEADRECKON_GAMEOVER_TERMINAL_DELAY_MS: 750,
    };
    const game = {
        score: 0, lives: 99, wave: 4, state: 'lobby',
        speedMultiplier: 1.2, waveDelayTimer: 80,
        multiplayer: { gameStateObjectId: 'gs', observedScoreLifeAwardCount: null },
    };
    const { syncGameState, resetGameStateSyncCache } = loadInlineGameFunctions([
        'calculateGameState',
        'applyCalculatedGameState', 'serializeGameState', 'syncGameState',
        'resetGameStateSyncCache', 'gameStateCounterMapsEqual', 'gameStateLedgerMatches',
        'readGameStateLedger', 'packGameStateLedger', 'gameStateCalculationInputs',
        'gameStateInputsEqual',
    ], {
        game,
        countExtraLivesForScore: (...args) => {
            counts.calculate++;
            return countExtraLivesForScore(...args);
        },
        calculateGameStateTerminal: (...args) => {
            terminalCalls.push(args);
            return calculateGameStateTerminal(...args);
        },
        malformedGameStateLedgerKey: null, gameStateSyncCache: null,
        GuidUtils: require('./wwwroot/js/guid-utils.js'),
        CONFIG: config,
        OBJECT_TYPES: { SHIP: 'ship', GAME_STATE: 'gameState' },
        isSessionMode: () => controls.sessionMode,
        isGameStateOwner: () => controls.owner,
        SessionClient: {
            getSessionEpoch: () => controls.epoch,
            getCurrentMember: () => ({ id: controls.memberId }),
        },
        AstervoidsWireCodec: {
            ...codec,
            packCounterMap: (...args) => {
                counts.pack++;
                return codec.packCounterMap(...args);
            },
            unpackCounterMap: (...args) => {
                counts.unpack++;
                return codec.unpackCounterMap(...args);
            },
        },
        announceExtraLifeAward: () => {
            awardStates.push({ score: game.score, lives: game.lives });
            events.push('award');
        },
        AudioSystem: { beat: { stop: () => events.push('stop') } },
        RemoteObjects: { serverNowMs: () => {
            assert.equal(game.lives, 0);
            events.push('clock');
            return controls.clock;
        } },
        _error: () => events.push('error'),
        ObjectSync: objectSync ?? {
            getObject: () => controls.record,
            getObjectsByType: () => ships,
            updateObject: (id, payload, immediate) => {
                events.push('publish');
                publications.push({ id, payload, immediate });
                if (controls.throwWrite) throw new Error('write failed');
                if (!controls.writeResult) return false;
                if (controls.optimistic) Object.assign(controls.record.data, payload);
                return true;
            },
        },
    });
    return {
        syncGameState, resetGameStateSyncCache, game, record, events, publications,
        counts, config, controls, ships, awardStates, terminalCalls,
    };
}

test('GameState effects precede terminal clock sampling and packed publication', () => {
    const harness = loadSyncHarness({
        data: { lives: 1, groupScore: 90, peakShipCount: 1, state: 'playing' },
        ships: [{ id: firstId, data: { score: 10, hitCount: 2 } }],
    });
    harness.syncGameState(true);
    assert.deepEqual(harness.events, ['award', 'stop', 'clock', 'publish']);
    assert.deepEqual(harness.awardStates, [{ score: 100, lives: 99 }]);
    const { id, payload, immediate } = harness.publications[0];
    assert.equal(id, 'gs');
    assert.equal(immediate, true);
    assert.deepEqual(payload, {
        type: 'gameState', gameStarted: true, wave: 4, state: 'playing',
        lives: 0, groupScore: 100, speedMultiplier: 1.2, waveDelayTimer: 80,
        processedHits: codec.packCounterMap({ [firstId]: 2 }),
        processedScores: codec.packCounterMap({ [firstId]: 10 }),
        countedParticipants: codec.packCounterMap({}),
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

test('unchanged optimistic ticks reuse calculation and packed ledgers without suppressing enqueue', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, groupScore: 20, peakShipCount: 1, state: 'playing' },
        ships: [{ id: firstId, version: 1, data: { score: 30, hitCount: 1 } }],
    });
    harness.syncGameState();
    const initial = { ...harness.counts };
    assert.deepEqual(initial, { calculate: 1, pack: 3, unpack: 3 });
    for (let i = 0; i < 20; i++) {
        harness.record.version++;
        harness.ships[0].version++;
        harness.ships[0].data.x = i / 100;
        harness.syncGameState(i === 19);
    }
    assert.deepEqual(harness.counts, initial);
    assert.equal(harness.terminalCalls.length, 1);
    assert.equal(harness.publications.length, 21);
    assert.equal(harness.publications.at(-1).immediate, true);
    assert.equal(harness.game.score, 50);
    assert.equal(harness.game.lives, 2);
    for (const publication of harness.publications) {
        assert.equal(publication.payload.processedHits,
            harness.publications[0].payload.processedHits);
        assert.equal(publication.payload.processedScores,
            harness.publications[0].payload.processedScores);
    }
});

test('score and hit events invalidate only changed ledgers without a version change', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, groupScore: 0, peakShipCount: 1, state: 'playing' },
        ships: [{ id: firstId, version: 7, data: { score: 20, hitCount: 0 } }],
    });
    harness.syncGameState();
    harness.ships[0].data.score = 35;
    harness.syncGameState();
    assert.equal(harness.game.score, 35);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 4, unpack: 3 });
    harness.ships[0].data.hitCount = 1;
    harness.syncGameState();
    assert.equal(harness.game.lives, 2);
    assert.deepEqual(harness.counts, { calculate: 3, pack: 5, unpack: 3 });
    assert.equal(harness.record.version, 1);
    assert.equal(harness.ships[0].version, 7);

    harness.ships[0].data.score = 1;
    harness.ships[0].data.hitCount = 0;
    harness.syncGameState();
    assert.equal(harness.game.score, 35);
    assert.equal(harness.game.lives, 2);
    assert.deepEqual(harness.counts, { calculate: 4, pack: 5, unpack: 3 });
});

test('ship membership, ownership, and order are calculation inputs', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, peakShipCount: 1 },
        ships: [{
            id: firstId, ownerMemberId: 'member-a',
            data: { score: 10, participantId: participantA },
        }],
    });
    harness.syncGameState();
    harness.ships.push({
        id: secondId, ownerMemberId: 'member-b',
        data: { score: 15, participantId: participantB },
    });
    harness.syncGameState();
    assert.equal(harness.game.lives, 4);
    assert.equal(harness.game.score, 25);
    harness.ships.reverse();
    harness.syncGameState();
    harness.ships[0].ownerMemberId = 'member-c';
    harness.syncGameState();
    harness.ships.pop();
    harness.syncGameState();
    assert.equal(harness.game.lives, 4,
        'reordering, re-owning, and losing a ship never re-award a counted participant');
    assert.equal(harness.game.score, 25, 'departed score remains in the ledger');
    assert.deepEqual(harness.counts, { calculate: 5, pack: 5, unpack: 3 });
});

test('configuration, local fallback, state, and observed awards invalidate calculation', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, peakShipCount: 1 },
        ships: [{ id: firstId, data: { score: 100 } }],
    });
    harness.syncGameState();
    assert.equal(harness.game.lives, 4);
    harness.config.EXTRA_LIFE_SCORE_THRESHOLD = 50;
    harness.syncGameState();
    assert.equal(harness.game.lives, 5);
    assert.equal(harness.game.multiplayer.observedScoreLifeAwardCount, 2);
    harness.game.multiplayer.observedScoreLifeAwardCount = 3;
    harness.syncGameState();
    assert.equal(harness.game.lives, 6);
    harness.game.state = 'waveDelay';
    harness.syncGameState();
    assert.equal(harness.publications.at(-1).payload.state, 'waveDelay');
    harness.game.lives = 999;
    harness.syncGameState();
    assert.equal(harness.game.lives, 6, 'canonical lives override the local fallback');
    delete harness.record.data.lives;
    harness.game.lives = 8;
    harness.syncGameState();
    assert.equal(harness.game.lives, 8);
    assert.deepEqual(harness.counts, { calculate: 6, pack: 3, unpack: 3 });
    assert.equal(harness.events.filter(event => event === 'award').length, 2);
});

test('publication-only fields remain fresh without reaggregating or repacking', () => {
    const harness = loadSyncHarness({ data: { lives: 3, peakShipCount: 0 } });
    harness.syncGameState();
    harness.game.wave = 8;
    harness.game.speedMultiplier = 2;
    harness.game.waveDelayTimer = 12;
    harness.syncGameState(true);
    const { payload, immediate } = harness.publications.at(-1);
    assert.equal(payload.wave, 8);
    assert.equal(payload.speedMultiplier, 2);
    assert.equal(payload.waveDelayTimer, 12);
    assert.equal(immediate, true);
    assert.deepEqual(harness.counts, { calculate: 1, pack: 3, unpack: 3 });
});

test('in-place canonical scalar edits and byte mutations cannot hide behind cached references', () => {
    for (const field of ['processedHits', 'processedScores']) {
        const harness = loadSyncHarness({
            data: {
                lives: 3, groupScore: 10, peakShipCount: 1,
                processedHits: codec.packCounterMap({ [firstId]: 1 }),
                processedScores: codec.packCounterMap({ [firstId]: 10 }),
            },
            ships: [{ id: firstId, data: { score: 10, hitCount: 1 } }],
        });
        harness.syncGameState();
        const bytes = harness.record.data[field];
        bytes[16] = field === 'processedHits' ? 0 : 5;
        harness.syncGameState();
        assert.equal(harness.game.score, field === 'processedHits' ? 10 : 15);
        assert.equal(harness.game.lives, field === 'processedHits' ? 2 : 3);
        assert.deepEqual(codec.unpackCounterMap(harness.record.data[field]),
            { [firstId]: field === 'processedHits' ? 1 : 10 });
        assert.notEqual(harness.record.data[field], bytes, 'never reuse mutated publication bytes');
        assert.deepEqual(harness.counts, { calculate: 2, pack: 4, unpack: 4 });

        harness.record.data.lives = 7;
        harness.record.data.groupScore = 90;
        harness.syncGameState();
        assert.equal(harness.game.lives, 7);
        assert.equal(harness.game.score, 90);
        assert.deepEqual(harness.counts, { calculate: 3, pack: 4, unpack: 4 });
    }
});

test('mutable legacy counter maps invalidate on edits, added keys, and removed keys', () => {
    const harness = loadSyncHarness({
        optimistic: false,
        data: {
            lives: 3, groupScore: 10, peakShipCount: 1,
            processedHits: {}, processedScores: { [firstId]: 10 },
        },
        ships: [{ id: firstId, data: { score: 10 } }],
    });
    harness.syncGameState();
    harness.record.data.processedScores[firstId] = 5;
    harness.syncGameState();
    assert.equal(harness.game.score, 15);
    harness.record.data.processedScores[secondId] = 25;
    harness.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(harness.publications.at(-1).payload.processedScores),
        { [firstId]: 10, [secondId]: 25 });
    delete harness.record.data.processedScores[secondId];
    harness.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(harness.publications.at(-1).payload.processedScores),
        { [firstId]: 10 });
    assert.deepEqual(harness.counts, { calculate: 4, pack: 5, unpack: 6 });
});

test('canonical replacement and ownership/session identity changes discard cached state', () => {
    const changes = [
        harness => { harness.controls.record = { ...harness.record }; },
        harness => { harness.record.data = structuredClone(harness.record.data); },
        harness => { harness.record.ownerMemberId = 'member-b'; },
        harness => { harness.controls.memberId = 'member-b'; },
        harness => { harness.controls.epoch++; },
        harness => { harness.game.multiplayer.gameStateObjectId = 'replacement'; },
        harness => {
            harness.controls.owner = false;
            harness.syncGameState();
            harness.controls.owner = true;
        },
        harness => {
            harness.controls.sessionMode = false;
            harness.syncGameState();
            harness.controls.sessionMode = true;
        },
        harness => {
            harness.controls.record = null;
            harness.syncGameState();
            harness.controls.record = harness.record;
        },
        harness => harness.resetGameStateSyncCache(),
    ];
    for (const change of changes) {
        const harness = loadSyncHarness({ data: { lives: 3, peakShipCount: 0 } });
        harness.syncGameState();
        change(harness);
        harness.syncGameState();
        assert.equal(harness.publications.length, 2, change.toString());
        assert.deepEqual(harness.counts, { calculate: 2, pack: 6, unpack: 6 },
            change.toString());
        harness.syncGameState();
        assert.deepEqual(harness.counts, { calculate: 2, pack: 6, unpack: 6 });
    }
    const { resetMultiplayerState } = loadInlineGameFunctions(['resetMultiplayerState']);
    assert.match(resetMultiplayerState.toString(), /resetGameStateSyncCache\(\)/);
});

test('a same-version recovery snapshot replaces optimistic scores and lives', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, peakShipCount: 1 },
        ships: [{ id: firstId, data: { score: 25, hitCount: 1 } }],
    });
    harness.syncGameState();
    harness.record.data = {
        lives: 8, groupScore: 40, peakShipCount: 1, scoreLifeAwardCount: 0,
        processedHits: codec.packCounterMap({ [firstId]: 1 }),
        processedScores: codec.packCounterMap({ [firstId]: 20 }),
    };
    harness.syncGameState();
    assert.equal(harness.game.lives, 8);
    assert.equal(harness.game.score, 45);
    assert.equal(harness.record.version, 1);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 6, unpack: 6 });
});

test('failed writes retry cached payloads without replaying effects or moving the terminal edge', () => {
    const harness = loadSyncHarness({
        data: { lives: 1, groupScore: 90, peakShipCount: 1, state: 'playing' },
        ships: [{ id: firstId, data: { score: 10, hitCount: 2 } }],
    });
    harness.controls.writeResult = false;
    harness.syncGameState(true);
    harness.controls.clock = 9000;
    harness.syncGameState(true);
    harness.syncGameState();
    assert.deepEqual(harness.events, ['award', 'stop', 'clock', 'publish', 'publish', 'publish']);
    assert.equal(harness.record.data.lives, 1, 'failed publication is not an optimistic write');
    assert.deepEqual(harness.counts, { calculate: 1, pack: 3, unpack: 3 });
    harness.controls.writeResult = true;
    harness.syncGameState();
    harness.syncGameState();
    assert.deepEqual(harness.counts, { calculate: 1, pack: 3, unpack: 3 });
    assert.equal(harness.publications.length, 5);
    assert.equal(harness.record.data.gameOverAt, 1000);
    assert.equal(harness.record.data.terminalAt, 1750);
});

test('scalar-only failed writes also rebase the cache when a retry succeeds', () => {
    const harness = loadSyncHarness({
        data: {
            lives: 3, groupScore: 200, peakShipCount: 0, state: 'playing',
            processedHits: codec.packCounterMap({}), processedScores: codec.packCounterMap({}),
        },
    });
    harness.controls.writeResult = false;
    harness.syncGameState();
    harness.controls.writeResult = true;
    harness.syncGameState();
    harness.syncGameState();
    assert.equal(harness.game.lives, 5);
    assert.equal(harness.record.data.scoreLifeAwardCount, 2);
    assert.deepEqual(harness.counts, { calculate: 1, pack: 3, unpack: 3 });
    assert.deepEqual(harness.events, ['award', 'publish', 'publish', 'publish']);
});

test('dirty retries consume terminal effects once and refresh delay without restamping the clock', () => {
    const harness = loadSyncHarness({
        data: { lives: 1, peakShipCount: 1, state: 'playing' },
        ships: [{ id: firstId, data: { hitCount: 2 } }],
    });
    harness.controls.writeResult = false;
    harness.syncGameState();
    harness.game.state = 'waveDelay';
    harness.config.DEADRECKON_GAMEOVER_TERMINAL_DELAY_MS = 900;
    harness.controls.clock = 9000;
    harness.syncGameState();
    assert.deepEqual(harness.events, ['stop', 'clock', 'publish', 'publish']);
    assert.equal(harness.publications.at(-1).payload.gameOverAt, 1000);
    assert.equal(harness.publications.at(-1).payload.terminalAt, 1900);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 3, unpack: 3 });

    harness.controls.throwWrite = true;
    assert.throws(() => harness.syncGameState(), /write failed/);
    harness.controls.throwWrite = false;
    harness.controls.writeResult = true;
    harness.syncGameState();
    assert.equal(harness.events.filter(event => event === 'stop').length, 1);
    assert.equal(harness.events.filter(event => event === 'clock').length, 1);
});

test('malformed replacements refuse cached results and recover after same-version repair', () => {
    const harness = loadSyncHarness({ data: { lives: 3, peakShipCount: 0 } });
    harness.syncGameState();
    const initialGame = structuredClone(harness.game);
    harness.record.data.processedScores = new Uint8Array([1]);
    harness.syncGameState();
    harness.syncGameState();
    assert.deepEqual(harness.events, ['publish', 'error']);
    assert.deepEqual(harness.game, initialGame);
    harness.record.data.processedScores = codec.packCounterMap({ [firstId]: 12 });
    harness.syncGameState();
    assert.equal(harness.publications.length, 2);
    assert.deepEqual(codec.unpackCounterMap(harness.publications.at(-1).payload.processedScores),
        { [firstId]: 12 });
});

test('equivalent byte views reuse the cache, but mutations in offset views are detected', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, peakShipCount: 1 },
        ships: [{ id: firstId, data: { score: 10 } }],
    });
    harness.syncGameState();
    const storage = new Uint8Array(40);
    storage.set(harness.record.data.processedScores, 7);
    harness.record.data.processedScores = storage.subarray(7, 27);
    harness.syncGameState();
    assert.deepEqual(harness.counts, { calculate: 1, pack: 3, unpack: 3 });
    harness.record.data.processedScores = storage.subarray(7, 27);
    storage[7 + 16] = 5;
    harness.syncGameState();
    assert.equal(harness.game.score, 15);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 3, unpack: 4 });
});

test('recovery snapshots invalidate aggregation without replaying already-consumed effects', () => {
    const data = { lives: 1, groupScore: 90, peakShipCount: 1, state: 'playing' };
    const harness = loadSyncHarness({
        data: { ...data },
        ships: [{ id: firstId, data: { score: 10, hitCount: 2 } }],
    });
    harness.syncGameState();
    harness.record.data = { ...data };
    harness.controls.clock = 9000;
    harness.syncGameState();
    assert.deepEqual(harness.events, ['award', 'stop', 'clock', 'publish', 'publish']);
    assert.equal(harness.record.data.groupScore, 100);
    assert.equal(harness.record.data.lives, 0);
    assert.equal(harness.record.data.gameOverAt, 1000);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 6, unpack: 6 });
});

test('real ObjectSync retries unconfirmed cached GameState after failed, empty, and rejected responses',
    async () => {
        const authoritativeObject = require('./wwwroot/js/authoritative-object.js');
        for (const failure of [null, { versions: {} }, new Error('network failure')]) {
            const handlers = {};
            const batches = [];
            let confirm = false;
            const client = {
                on: (name, handler) => { handlers[name] = handler; },
                getSessionEpoch: () => 1,
                getCurrentMember: () => ({ id: 'member-a' }),
                isInSession: () => true,
                updateObjects: async updates => {
                    batches.push(structuredClone(updates));
                    if (confirm) return { versions: { gs: 2 } };
                    if (failure instanceof Error) throw failure;
                    return failure;
                },
            };
            const objectSync = loadClassicModule('object-sync.js', 'ObjectSync', {
                SessionClient: client,
                AuthoritativeObject: authoritativeObject,
                window: { ASTERVOIDS_DEBUG: false }
            });
            objectSync.init();
            objectSync.configure({ deltaEncoding: true });
            handlers.onSessionJoined({ objects: [
                {
                    id: 'gs', version: 1, ownerMemberId: 'member-a', scope: 'Session',
                    data: {
                        type: 'gameState', lives: 1, groupScore: 90, peakShipCount: 1,
                        state: 'playing', scoreLifeAwardCount: 0,
                        processedHits: codec.packCounterMap({}),
                        processedScores: codec.packCounterMap({}),
                    },
                },
                {
                    id: firstId, version: 1, ownerMemberId: 'member-a', scope: 'Member',
                    data: { type: 'ship', score: 10, hitCount: 2 },
                },
            ] });
            const harness = loadSyncHarness({ objectSync });
            harness.syncGameState();
            const optimistic = { ...objectSync.getObject('gs').data };
            assert.equal(objectSync.isDataConfirmed('gs', optimistic), false);
            await objectSync.flushUpdates();
            assert.equal(objectSync.isDataConfirmed('gs', optimistic), false);
            harness.syncGameState();
            await objectSync.flushUpdates();
            assert.equal(batches.length, 2, 'the failed batch must be enqueued again');
            assert.deepEqual(batches[1], batches[0]);
            assert.equal(objectSync.isDataConfirmed('gs', optimistic), false);
            confirm = true;
            harness.syncGameState();
            await objectSync.flushUpdates();
            assert.equal(batches.length, 3);
            assert.equal(objectSync.isDataConfirmed('gs', optimistic), true);
            harness.syncGameState();
            await objectSync.flushUpdates();
            assert.equal(batches.length, 3, 'confirmed duplicates remain ObjectSync-suppressed');
            assert.deepEqual(harness.counts, { calculate: 1, pack: 3, unpack: 3 });
            assert.equal(harness.terminalCalls.length, 1);
            assert.deepEqual(harness.events, ['award', 'stop', 'clock']);
        }
    });
