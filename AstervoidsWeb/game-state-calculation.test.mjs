import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadInlineGameConstants, loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { loadClassicModule } from './test-support/classic-module.mjs';

const require = createRequire(import.meta.url);
const { countExtraLivesForScore } = require('./wwwroot/js/game-config.js');
const codec = require('./wwwroot/js/astervoids-wire-codec.js');
const progressionConstants = loadInlineGameConstants(['PROGRESSION', 'PAYLOAD_KIND', 'GAME_EFFECT_KIND']);
const progressionFunctions = loadInlineGameFunctions(
    ['getLevelXpThreshold', 'getLevelForXp', 'getProgressionForXp',
        'getParticipatingParticipantIds', 'awardBreakXp'], {
        ...progressionConstants, GuidUtils: require('./wwwroot/js/guid-utils.js'),
        AstervoidsWireCodec: codec,
    });
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
    { ...progressionConstants, ...progressionFunctions, countExtraLivesForScore,
        GuidUtils: require('./wwwroot/js/guid-utils.js'), AstervoidsWireCodec: codec });

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
        { processedHits: hits, processedScores: scores, countedParticipants: counted,
            participantScores: {}, participantNumbers: {}, participantTags: {},
            participantXp: {}, processedEffects: {}, participantModifiers: {} },
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

test('only the ship crossing zero lives becomes the immutable terminal ship', () => {
    const ships = [
        { id: firstId, data: { hitCount: 1 } },
        { id: secondId.toUpperCase(), data: { hitCount: 1 } },
        { id: thirdId, data: { hitCount: 1 } },
    ];
    const result = calculate({ persisted: { lives: 2 }, ships });
    assert.equal(result.lives, 0);
    assert.equal(result.terminalShipId, secondId);
    const migrated = calculate({
        persisted: result, hits: result.processedHits,
        ships: [{ id: thirdId, data: { hitCount: 2 } }],
    });
    assert.equal(migrated.terminalShipId, secondId,
        'later hits and departure of the wreck must not select another ship');
});

test('survival and partial terminal records do not invent a terminal ship', () => {
    const ships = [{ id: firstId, data: { hitCount: 1, score: 100 } }];
    assert.equal(calculate({ persisted: { lives: 1 }, ships }).terminalShipId, null,
        'score life is awarded before damage');
    assert.equal(calculate({ persisted: { lives: 0 }, ships }).terminalShipId, null,
        'a terminal session without identity cannot be reconstructed from hit totals');
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

function completeGameStateData(data = {}) {
    return {
        processedHits: codec.packCounterMap({}),
        processedScores: codec.packCounterMap({}),
        countedParticipants: codec.packCounterMap(Object.fromEntries(
            [participantA, participantB, participantC].slice(0, data.peakShipCount ?? 0).map(id => [id, 1]))),
        participantScores: codec.packCounterMap({}),
        participantNumbers: codec.packCounterMap({}),
        participantTags: codec.packTagMap({}),
        participantXp: codec.packXpMap({}),
        processedEffects: codec.packCounterMap({}),
        participantModifiers: codec.packParticipantModifiers({}),
        ...data,
    };
}

function loadSyncHarness({
    data = {}, ships = [], effects = [], sessionMode = true, owner = true, optimistic = true,
    objectSync = null,
} = {}) {
    const events = [];
    const publications = [];
    const awardStates = [];
    const counts = { calculate: 0, pack: 0, unpack: 0 };
    const xpCounts = { pack: 0, unpack: 0 };
    const terminalCalls = [];
    const record = { id: 'gs', data: completeGameStateData(data), version: 1, ownerMemberId: 'member-a' };
    const controls = {
        sessionMode, owner, epoch: 1, memberId: 'member-a', record,
        members: [],
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
    const { syncGameState, resetGameStateSyncCache, handleShipStateChangedEvent } = loadInlineGameFunctions([
        'calculateGameState',
        'applyCalculatedGameState', 'serializeGameState', 'syncGameState',
        'resetGameStateSyncCache', 'gameStateCounterMapsEqual', 'gameStateLedgerMatches',
        'readGameStateLedger', 'packGameStateLedger', 'gameStateCalculationInputs',
        'gameStateInputsEqual', 'normalizeParticipantLedger',
        'readParticipantScoreHistory', 'reportMalformedGameStateLedgers',
        'handleShipStateChangedEvent', 'isGameEffectReady', 'getGameEffectTimerData',
    ], {
        game, ...progressionConstants, ...progressionFunctions,
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
        OBJECT_TYPES: { SHIP: 'ship', GAME_STATE: 'gameState', GAME_EFFECT: 'gameEffect' },
        isSessionMode: () => controls.sessionMode,
        isGameStateOwner: () => controls.owner,
        SessionClient: {
            getSessionEpoch: () => controls.epoch,
            getCurrentMember: () => ({ id: controls.memberId }),
            getCurrentSession: () => ({
                metadata: { schemas: require('./wwwroot/js/game-wire-schemas.js').SCHEMAS },
                members: controls.members.map(id => ({ id })),
            }),
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
            packXpMap: (...args) => {
                xpCounts.pack++;
                return codec.packXpMap(...args);
            },
            unpackXpMap: (...args) => {
                xpCounts.unpack++;
                return codec.unpackXpMap(...args);
            },
        },
        announceExtraLifeAward: () => {
            awardStates.push({ score: game.score, lives: game.lives });
            events.push('award');
        },
        AudioSystem: { beat: { stop: () => events.push('stop') } },
        CollisionEffects: { startShipHit() {} },
        RemoteObjects: { serverNowMs: () => {
            assert.equal(game.lives, 0);
            events.push('clock');
            return controls.clock;
        } },
        _error: () => events.push('error'),
        ObjectSync: objectSync ?? {
            isDataConfirmed: () => false,
            isObjectConfirmedAbsent: () => false,
            getSnapshotObject: () => null,
            getObject: id => id === game.multiplayer.gameStateObjectId
                ? controls.record : ships.find(ship => ship.id === id),
            getObjectsByType: type => type === 'ship' ? ships : type === 'gameEffect' ? effects : [],
            getObjectByType: type => type === 'gameState'
                ? controls.record : ships.find(ship => ship.data?.type === type),
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
        counts, xpCounts, config, controls, ships, effects, awardStates, terminalCalls, handleShipStateChangedEvent,
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
        countedParticipants: codec.packCounterMap({ [participantA]: 1 }),
        participantScores: codec.packCounterMap({}),
        participantNumbers: codec.packCounterMap({}),
        participantTags: codec.packTagMap({}),
        participantXp: codec.packXpMap({}),
        processedEffects: codec.packCounterMap({}),
        participantModifiers: codec.packParticipantModifiers({}),
        peakShipCount: 1, gameOverAt: 1000, terminalAt: 1750, scoreLifeAwardCount: 1,
        terminalShipId: firstId,
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
        harness.record.data = completeGameStateData({ lives: 2, peakShipCount: 0 });
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
    assert.deepEqual(initial, { calculate: 1, pack: 6, unpack: 6 });
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
    assert.deepEqual(harness.counts, { calculate: 2, pack: 7, unpack: 6 });
    harness.ships[0].data.hitCount = 1;
    harness.syncGameState();
    assert.equal(harness.game.lives, 2);
    assert.deepEqual(harness.counts, { calculate: 3, pack: 8, unpack: 6 });
    assert.equal(harness.record.version, 1);
    assert.equal(harness.ships[0].version, 7);

    harness.ships[0].data.score = 1;
    harness.ships[0].data.hitCount = 0;
    harness.syncGameState();
    assert.equal(harness.game.score, 35);
    assert.equal(harness.game.lives, 2);
    assert.deepEqual(harness.counts, { calculate: 4, pack: 8, unpack: 6 });
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
    assert.deepEqual(harness.counts, { calculate: 5, pack: 10, unpack: 6 });
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
    assert.deepEqual(harness.counts, { calculate: 6, pack: 6, unpack: 6 });
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
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
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
        assert.deepEqual(harness.counts, { calculate: 2, pack: 7, unpack: 7 });

        harness.record.data.lives = 7;
        harness.record.data.groupScore = 90;
        harness.syncGameState();
        assert.equal(harness.game.lives, 7);
        assert.equal(harness.game.score, 90);
        assert.deepEqual(harness.counts, { calculate: 3, pack: 7, unpack: 7 });
    }
});

test('packed counter maps invalidate on in-place edits, added entries, and removed entries', () => {
    const harness = loadSyncHarness({
        optimistic: false,
        data: {
            lives: 3, groupScore: 10, peakShipCount: 1,
            processedHits: codec.packCounterMap({}), processedScores: codec.packCounterMap({ [firstId]: 10 }),
        },
        ships: [{ id: firstId, data: { score: 10 } }],
    });
    harness.syncGameState();
    harness.record.data.processedScores[16] = 5;
    harness.syncGameState();
    assert.equal(harness.game.score, 15);
    harness.record.data.processedScores = codec.packCounterMap({ [firstId]: 5, [secondId]: 25 });
    harness.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(harness.publications.at(-1).payload.processedScores),
        { [firstId]: 10, [secondId]: 25 });
    harness.record.data.processedScores = codec.packCounterMap({ [firstId]: 5 });
    harness.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(harness.publications.at(-1).payload.processedScores),
        { [firstId]: 10 });
    assert.deepEqual(harness.counts, { calculate: 4, pack: 8, unpack: 9 });
});

test('canonical replacement and ownership/session identity changes discard cached state', () => {
    const changes = [
        harness => { harness.controls.record = { ...harness.record }; },
        harness => { harness.record.data = structuredClone(harness.record.data); },
        harness => {
            harness.record.ownerMemberId = 'member-b';
            harness.controls.memberId = 'member-b';
        },
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
        assert.deepEqual(harness.counts, { calculate: 2, pack: 12, unpack: 12 },
            change.toString());
        harness.syncGameState();
        assert.deepEqual(harness.counts, { calculate: 2, pack: 12, unpack: 12 });
    }
    const { resetMultiplayerState } = loadInlineGameFunctions(['resetMultiplayerState']);
    assert.match(resetMultiplayerState.toString(), /resetGameStateSyncCache\(\)/);
});

test('a changed caller identity cannot publish the former owners cached result before authoritative migration', () => {
    const harness = loadSyncHarness({ data: { lives: 3, peakShipCount: 0 } });
    harness.syncGameState();
    harness.controls.memberId = 'member-b';
    harness.syncGameState();
    assert.equal(harness.publications.length, 1, 'the real object owner check overrides a stale owner-role hint');
    assert.equal(harness.counts.calculate, 1);
    harness.record.ownerMemberId = 'member-b';
    harness.syncGameState();
    assert.equal(harness.publications.length, 2);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 12, unpack: 12 },
        'the new authoritative member starts a fresh calculation cache');
});

test('a same-version recovery snapshot replaces optimistic scores and lives', () => {
    const harness = loadSyncHarness({
        data: { lives: 3, peakShipCount: 1 },
        ships: [{ id: firstId, data: { score: 25, hitCount: 1 } }],
    });
    harness.syncGameState();
    harness.record.data = completeGameStateData({
        lives: 8, groupScore: 40, peakShipCount: 1, scoreLifeAwardCount: 0,
        processedHits: codec.packCounterMap({ [firstId]: 1 }),
        processedScores: codec.packCounterMap({ [firstId]: 20 }),
    });
    harness.syncGameState();
    assert.equal(harness.game.lives, 8);
    assert.equal(harness.game.score, 45);
    assert.equal(harness.record.version, 1);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 12, unpack: 12 });
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
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
    harness.controls.writeResult = true;
    harness.syncGameState();
    harness.syncGameState();
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
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
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
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
    assert.deepEqual(harness.counts, { calculate: 2, pack: 6, unpack: 6 });

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
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
    harness.record.data.processedScores = storage.subarray(7, 27);
    storage[7 + 16] = 5;
    harness.syncGameState();
    assert.equal(harness.game.score, 15);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 6, unpack: 7 });
});

test('recovery snapshots invalidate aggregation without replaying already-consumed effects', () => {
    const data = { lives: 1, groupScore: 90, peakShipCount: 1, state: 'playing' };
    const harness = loadSyncHarness({
        data: { ...data },
        ships: [{ id: firstId, data: { score: 10, hitCount: 2 } }],
    });
    harness.syncGameState();
    harness.record.data = completeGameStateData(data);
    harness.controls.clock = 9000;
    harness.syncGameState();
    assert.deepEqual(harness.events, ['award', 'stop', 'clock', 'publish', 'publish']);
    assert.equal(harness.record.data.groupScore, 100);
    assert.equal(harness.record.data.lives, 0);
    assert.equal(harness.record.data.gameOverAt, 1000);
    assert.deepEqual(harness.counts, { calculate: 2, pack: 12, unpack: 12 });
});

test('real ObjectSync retries current GameState after failed, empty, and rejected responses',
    async () => {
        const authoritativeObject = require('./wwwroot/js/authoritative-object.js');
        const scenarios = [null, { versions: {} }, new Error('network failure')];
        for (const failure of scenarios) {
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
                    data: completeGameStateData({
                        type: 'gameState', lives: 1, groupScore: 90, peakShipCount: 1,
                        state: 'playing', scoreLifeAwardCount: 0,
                        processedHits: codec.packCounterMap({}),
                        processedScores: codec.packCounterMap({}),
                    }),
                },
                {
                    id: firstId, version: 1, ownerMemberId: 'member-a', scope: 'Member',
                    data: { type: 'ship', score: 10, hitCount: 2, participantId: participantA },
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
            assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
            assert.equal(harness.terminalCalls.length, 1);
            assert.deepEqual(harness.events, ['award', 'stop', 'clock']);
        }
    });

function personalGameStateData(extra = {}) {
    return completeGameStateData({
        lives: 3, groupScore: 0, peakShipCount: 0, state: 'playing',
        participantScores: codec.packCounterMap({}),
        participantNumbers: codec.packCounterMap({}),
        ...extra,
    });
}

function receiptSyncHarness(data = personalGameStateData(), receipts = []) {
    const handlers = {};
    const server = new Map([{
        id: 'gs', version: 1, ownerMemberId: 'member-a', scope: 'Session',
        data: { type: 'gameState', ...data },
    }, ...receipts].map(record => [record.id, structuredClone(record)]));
    const transport = { acknowledge: true, delete: null, sequence: 0, epoch: 1 };
    const batches = [];
    const client = {
        on: (name, handler) => { handlers[name] = handler; },
        getSessionEpoch: () => transport.epoch,
        getCurrentMember: () => ({ id: 'member-a' }),
        isInSession: () => true,
        getSessionState: async () => ({
            objects: [...server.values()].map(record => structuredClone(record)),
            validAts: {}, memberSequences: {},
        }),
        updateObjects: async updates => {
            batches.push(structuredClone(updates));
            const versions = {};
            if (transport.acknowledge) {
                for (const update of updates) {
                    const record = server.get(update.objectId);
                    Object.assign(record.data, structuredClone(update.data));
                    versions[record.id] = ++record.version;
                }
            }
            return { versions, memberSequence: ++transport.sequence };
        },
        deleteObject: async objectId => {
            if (transport.delete) return transport.delete;
            return { success: server.delete(objectId), memberSequence: ++transport.sequence };
        },
    };
    const objectSync = loadClassicModule('object-sync.js', 'ObjectSync', {
        SessionClient: client, window: { ASTERVOIDS_DEBUG: false },
        AuthoritativeObject: require('./wwwroot/js/authoritative-object.js'),
    });
    objectSync.init();
    objectSync.configure({ deltaEncoding: true });
    handlers.onSessionJoined({ objects: [...server.values()].map(record => structuredClone(record)) });
    const harness = loadSyncHarness({ objectSync });
    return { ...harness, objectSync, client, server, transport, handlers, batches };
}

test('real ObjectSync receipt compaction preserves once-only awards across rejected deletes and rejected writes', async () => {
    const receipt = {
        id: thirdId, version: 1, ownerMemberId: 'member-a', scope: 'Session',
        data: {
            type: 'gameEffect', kind: progressionConstants.GAME_EFFECT_KIND.BREAK_RECEIPT,
            payloadKind: progressionConstants.PAYLOAD_KIND.NONE, participantId: participantA,
            participantTag: 'Pilot_A', shipId: firstId, points: 100,
            startedAt: 1000, armedAt: 1000, expiresAt: 1000,
            contributors: codec.packContributors({ [participantA]: 1 }),
            shipLifeId: null,
        },
    };
    const h = receiptSyncHarness(personalGameStateData(), [receipt]);
    const state = () => h.objectSync.getObject('gs').data;
    const awards = () => [state().groupScore, state().lives,
        codec.unpackXpMap(state().participantXp)[participantA]];
    h.syncGameState();
    await h.objectSync.flushUpdates();
    assert.deepEqual(awards(), [100, 4, 10]);
    let rejectDelete;
    h.transport.delete = new Promise(resolve => { rejectDelete = resolve; });
    const deleting = h.objectSync.deleteObject(receipt.id);
    h.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(state().processedEffects), { [receipt.id]: 1 });
    await h.objectSync.triggerReconciliation();
    rejectDelete({ success: false });
    assert.equal(await deleting, false);
    h.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(state().processedEffects), { [receipt.id]: 1 },
        'local absence and delete rejection cannot remove the exactly-once guard');
    await h.objectSync.triggerReconciliation();
    assert.ok(h.objectSync.getObject(receipt.id));
    h.syncGameState();
    assert.deepEqual(awards(), [100, 4, 10], 'restoring a rejected receipt cannot pay it again');

    h.transport.delete = null;
    assert.equal(await h.objectSync.deleteObject(receipt.id), true);
    h.transport.acknowledge = false;
    h.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(state().processedEffects), {});
    await h.objectSync.flushUpdates();
    assert.deepEqual(codec.unpackCounterMap(h.server.get('gs').data.processedEffects), { [receipt.id]: 1 });
    assert.equal(h.objectSync.isDataConfirmed('gs', { processedEffects: state().processedEffects }), false);
    h.syncGameState();
    await h.objectSync.flushUpdates();
    assert.deepEqual(awards(), [100, 4, 10]);
    h.transport.acknowledge = true;
    h.syncGameState();
    await h.objectSync.flushUpdates();
    assert.equal(h.objectSync.isDataConfirmed('gs', { processedEffects: state().processedEffects }), true);
    assert.deepEqual(codec.unpackCounterMap(h.server.get('gs').data.processedEffects), {});
    h.handlers.onObjectCreated(receipt, 'remote', 1, 1000);
    h.handlers.onObjectsUpdated(
        [{ id: receipt.id, version: 2, data: receipt.data }], 1000, 'remote', 2, 2, 50, 1000);
    assert.equal(h.objectSync.getObject(receipt.id), undefined, 'delayed receipt replay hits a tombstone');
    h.syncGameState();
    assert.deepEqual(awards(), [100, 4, 10]);
});

test('late-join and migration compact legacy receipt history using the exact authoritative snapshot, not newer references', async () => {
    const retired = Object.fromEntries(Array.from({ length: 2000 }, (_, index) =>
        [`${index.toString(16).padStart(8, '0')}-3333-3333-3333-333333333333`, 1]));
    const data = personalGameStateData({
        groupScore: 200_000, lives: 4, scoreLifeAwardCount: 2000,
        participantScores: codec.packCounterMap({ [participantA]: 200_000 }),
        participantNumbers: codec.packCounterMap({ [participantA]: 1 }),
        participantTags: codec.packTagMap({ [participantA]: 'Pilot_A' }),
        participantXp: codec.packXpMap({ [participantA]: 20_000 }),
        processedEffects: codec.packCounterMap(retired),
    });
    const h = receiptSyncHarness(data);
    h.objectSync.handleOwnershipMigration([{ objectId: 'gs', newOwnerId: 'member-a', newVersion: 2 }]);
    h.server.get('gs').version = 2;
    h.syncGameState();
    let state = h.objectSync.getObject('gs').data;
    assert.equal(state.processedEffects.length, 0, 'old history is compacted before its first oversized publish');
    assert.equal(state.groupScore, 200_000);
    assert.equal(state.lives, 4);
    assert.deepEqual(codec.unpackXpMap(state.participantXp), { [participantA]: 20_000 });
    await h.objectSync.flushUpdates();
    const replayId = Object.keys(retired)[0];
    h.handlers.onObjectCreated({
        id: replayId, version: 1, data: { type: 'gameEffect' }, ownerMemberId: 'member-a',
    }, 'remote', 1, 1000);
    assert.equal(h.objectSync.getObject(replayId), undefined,
        'snapshot-proven retired IDs are tombstoned even when never previously observed');

    h.transport.epoch++;
    h.controls.epoch++;
    h.handlers.onSessionTransition();
    h.handlers.onSessionJoined(await h.client.getSessionState());
    h.syncGameState();
    state = h.objectSync.getObject('gs').data;
    assert.equal(state.processedEffects.length, 0);
    assert.equal(state.groupScore, 200_000);
    assert.deepEqual(codec.unpackXpMap(state.participantXp), { [participantA]: 20_000 });
});

test('a newer GameState acknowledgement cannot use an older snapshot to discard an unseen receipt', () => {
    const h = receiptSyncHarness();
    h.handlers.onObjectsUpdated([{
        id: 'gs', version: 2, data: {
            groupScore: 100, scoreLifeAwardCount: 1, lives: 4,
            participantScores: codec.packCounterMap({ [participantA]: 100 }),
            participantNumbers: codec.packCounterMap({ [participantA]: 1 }),
            participantTags: codec.packTagMap({ [participantA]: 'Pilot_A' }),
            participantXp: codec.packXpMap({ [participantA]: 10 }),
            processedEffects: codec.packCounterMap({ [thirdId]: 1 }),
        },
    }], 1000, 'remote', 1, 1, 50, 1000);
    h.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(h.objectSync.getObject('gs').data.processedEffects), { [thirdId]: 1 });
    h.handlers.onObjectCreated({
        id: thirdId, version: 1, ownerMemberId: 'member-a', scope: 'Session',
        data: {
            type: 'gameEffect', kind: progressionConstants.GAME_EFFECT_KIND.BREAK_RECEIPT,
            payloadKind: progressionConstants.PAYLOAD_KIND.NONE, participantId: participantA,
            participantTag: 'Pilot_A', points: 100, startedAt: 1000, armedAt: 1000, expiresAt: 1000,
        },
    }, 'remote', 2, 1000);
    h.syncGameState();
    const state = h.objectSync.getObject('gs').data;
    assert.equal(state.groupScore, 100);
    assert.equal(codec.unpackXpMap(state.participantXp)[participantA], 10,
        'late delivery of the acknowledged receipt does not award a second break');
});

test('personal ledgers reuse decoded maps and packed bytes across motion-only and unchanged ticks', () => {
    const harness = loadSyncHarness({
        data: personalGameStateData(),
        ships: [{
            id: firstId, version: 7, data: { participantId: participantA, score: 20, hitCount: 0 },
        }],
    });
    harness.syncGameState();
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
    const scores = harness.record.data.participantScores;
    const numbers = harness.record.data.participantNumbers;
    const xp = harness.record.data.participantXp;
    const receipts = harness.record.data.processedEffects;
    assert.deepEqual(harness.xpCounts, { pack: 1, unpack: 1 });
    for (let frame = 0; frame < 120; frame++) {
        harness.ships[0].data.x = frame / 1000;
        harness.ships[0].version++;
        harness.syncGameState();
    }
    assert.deepEqual(harness.counts, { calculate: 1, pack: 6, unpack: 6 });
    assert.equal(harness.record.data.participantScores, scores);
    assert.equal(harness.record.data.participantNumbers, numbers);
    assert.equal(harness.record.data.participantXp, xp);
    assert.equal(harness.record.data.processedEffects, receipts);
    assert.deepEqual(harness.xpCounts, { pack: 1, unpack: 1 });
    assert.deepEqual(codec.unpackCounterMap(scores), { [participantA]: 20 });
    assert.deepEqual(codec.unpackCounterMap(numbers), { [participantA]: 1 });

    const version = harness.ships[0].version;
    harness.handleShipStateChangedEvent(firstId, { score: 35, hitCount: 0 });
    harness.syncGameState();
    assert.equal(harness.ships[0].version, version, 'counter events do not advance versions');
    assert.equal(harness.game.score, 35);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores), { [participantA]: 35 });
    assert.deepEqual(harness.counts, { calculate: 2, pack: 8, unpack: 6 });
    assert.equal(harness.record.data.participantNumbers, numbers);

    harness.handleShipStateChangedEvent(firstId, { score: 35, hitCount: 1 });
    harness.syncGameState();
    assert.equal(harness.game.lives, 2);
    assert.deepEqual(harness.counts, { calculate: 3, pack: 9, unpack: 6 });
    harness.handleShipStateChangedEvent(firstId, { score: 1, hitCount: 0 });
    harness.syncGameState();
    assert.equal(harness.game.score, 35);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores), { [participantA]: 35 });
    assert.deepEqual(harness.counts, { calculate: 4, pack: 9, unpack: 6 });
    assert.deepEqual(harness.xpCounts, { pack: 1, unpack: 1 },
        'score, damage and motion never repack an unchanged personal XP map');
});

test('accepted break receipts invalidate cached GameState once and preserve large personal XP through packed publication', () => {
    const largeXp = 0x100000001;
    const harness = loadSyncHarness({
        data: personalGameStateData({
            participantScores: codec.packCounterMap({ [participantA]: 0 }),
            participantNumbers: codec.packCounterMap({ [participantA]: 1 }),
            participantXp: codec.packXpMap({ [participantA]: largeXp }),
        }),
    });
    harness.syncGameState();
    const counterBytes = harness.record.data.processedScores;
    const previousXp = harness.record.data.participantXp;
    harness.effects.push({
        id: thirdId, ownerMemberId: 'member-b', version: 1, scope: 'Session',
        data: {
            type: 'gameEffect', kind: progressionConstants.GAME_EFFECT_KIND.BREAK_RECEIPT,
            payloadKind: progressionConstants.PAYLOAD_KIND.NONE, participantId: participantA,
            participantTag: 'Pilot_A', shipId: firstId, points: 20,
            startedAt: 1000, armedAt: 1000, expiresAt: 1000,
            contributors: codec.packContributors({ [participantA]: 1 }), shipLifeId: null,
        },
    });
    harness.syncGameState();
    assert.equal(harness.game.score, 20);
    assert.equal(codec.unpackXpMap(harness.record.data.participantXp)[participantA], largeXp + 10);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.processedEffects), { [thirdId]: 1 });
    assert.equal(harness.record.data.processedScores, counterBytes,
        'a durable winner does not fabricate a disposable-ship score counter');
    assert.notEqual(harness.record.data.participantXp, previousXp);
    const xpBytes = harness.record.data.participantXp;
    const effectsBytes = harness.record.data.processedEffects;
    assert.deepEqual(harness.xpCounts, { pack: 2, unpack: 1 });
    for (let frame = 0; frame < 20; frame++) {
        harness.record.version++;
        harness.syncGameState();
    }
    assert.equal(harness.game.score, 20);
    assert.equal(harness.record.data.participantXp, xpBytes);
    assert.equal(harness.record.data.processedEffects, effectsBytes);
    assert.deepEqual(harness.xpCounts, { pack: 2, unpack: 1 });
    new DataView(xpBytes.buffer, xpBytes.byteOffset, xpBytes.byteLength)
        .setFloat64(16, largeXp + 20, true);
    harness.syncGameState();
    assert.equal(codec.unpackXpMap(harness.record.data.participantXp)[participantA], largeXp + 20);
    assert.deepEqual(harness.xpCounts, { pack: 3, unpack: 2 });
});

test('missing or malformed progression and receipt ledgers refuse all effects until a same-version repair', () => {
    for (const field of ['participantXp', 'processedEffects']) {
        for (const invalid of [undefined, null, new Uint8Array([1])]) {
            const harness = loadSyncHarness({
                data: personalGameStateData({ [field]: invalid }),
                ships: [{ id: firstId, data: { participantId: participantA, score: 200, hitCount: 1 } }],
            });

            test('same-version modifier requests and in-place modifier/contributor bytes invalidate aggregation without replaying awards', () => {
                const ships = [{
                    id: firstId, ownerMemberId: memberA, version: 1,
                    data: { type: 'ship', memberId: memberA, participantId: participantA,
                        participantTag: 'Pilot_A', score: 0, hitCount: 0,
                        modifierRequestMilestone: 0, modifierRequestKind: 0 },
                }];
                const h = loadSyncHarness({
                    ships, data: personalGameStateData({
                        participantXp: codec.packXpMap({ [participantA]: 120, [participantB]: 0 }),
                    }),
                });
                h.controls.members = [memberA];
                h.syncGameState();
                h.syncGameState();
                assert.equal(h.counts.calculate, 1);
                ships[0].data.modifierRequestMilestone = 4;
                ships[0].data.modifierRequestKind = 1;
                h.syncGameState();
                assert.equal(h.counts.calculate, 2);
                assert.deepEqual(codec.unpackParticipantModifiers(h.record.data.participantModifiers), {
                    [participantA]: { consumedMilestone: 4, modifierKind: 1 },
                });
                ships[0].data.modifierRequestKind = 2;
                h.syncGameState();
                assert.equal(h.counts.calculate, 3);
                assert.equal(codec.unpackParticipantModifiers(h.record.data.participantModifiers)[participantA].modifierKind, 1,
                    'a competing same-milestone request cannot overwrite an already accepted choice');
                h.record.data.participantModifiers[20] = 2;
                h.syncGameState();
                assert.equal(h.counts.calculate, 4);
                assert.equal(codec.unpackParticipantModifiers(h.record.data.participantModifiers)[participantA].modifierKind, 2);
                const receipt = {
                    id: thirdId, ownerMemberId: memberA, version: 1, data: {
                        type: 'gameEffect', kind: progressionConstants.GAME_EFFECT_KIND.BREAK_RECEIPT,
                        payloadKind: progressionConstants.PAYLOAD_KIND.NONE,
                        participantId: participantA, participantTag: 'Pilot_A', points: 20,
                        contributors: codec.packContributors({ [participantA]: 1, [participantB]: 2 }),
                        startedAt: 1000, armedAt: 1000, expiresAt: 1000, shipLifeId: null,
                    },
                };
                h.effects.push(receipt);
                h.syncGameState();
                assert.equal(h.counts.calculate, 5);
                const awarded = codec.unpackXpMap(h.record.data.participantXp);
                assert.deepEqual(awarded, { [participantA]: 130, [participantB]: 7 });
                h.syncGameState();
                assert.equal(h.counts.calculate, 5);
                const contributors = new DataView(receipt.data.contributors.buffer);
                contributors.setUint32(16, 2, true);
                contributors.setUint32(36, 1, true);
                h.syncGameState();
                assert.equal(h.counts.calculate, 6);
                assert.deepEqual(codec.unpackXpMap(h.record.data.participantXp), awarded,
                    'changing a consumed receipt cannot duplicate either personal XP or score');
                assert.equal(h.record.data.groupScore, 20);
                assert.equal(ships[0].version, 1);
                assert.equal(receipt.version, 1);
            });

            test('a pure spectator GameState owner invalidates cached catch-up when current participation changes without versions', () => {
                const ships = [
                    { id: firstId, ownerMemberId: memberA, version: 1,
                        data: { memberId: memberA, participantId: participantA, participantTag: 'Pilot_A' } },
                    { id: secondId, ownerMemberId: memberB, version: 1,
                        data: { memberId: memberB, participantId: participantB, participantTag: 'Pilot_B' } },
                ];
                const h = loadSyncHarness({
                    ships, data: personalGameStateData({
                        participantXp: codec.packXpMap({ [participantA]: 10, [participantB]: 120 }),
                    }),
                });
                h.controls.memberId = memberC;
                h.record.ownerMemberId = memberC;
                h.controls.members = [memberA, memberB, memberC];
                h.syncGameState();
                h.controls.members = [memberA, memberC];
                h.syncGameState();
                assert.equal(h.counts.calculate, 2, 'member departure alone invalidates the cached reference set');
                const receipt = id => ({
                    id, ownerMemberId: memberA, version: 1, data: {
                        type: 'gameEffect', kind: progressionConstants.GAME_EFFECT_KIND.BREAK_RECEIPT,
                        payloadKind: progressionConstants.PAYLOAD_KIND.NONE,
                        participantId: participantA, participantTag: 'Pilot_A', points: 20,
                        contributors: codec.packContributors({ [participantA]: 1 }),
                        startedAt: 1000, armedAt: 1000, expiresAt: 1000, shipLifeId: null,
                    },
                });
                h.effects.push(receipt(thirdId));
                h.syncGameState();
                assert.equal(codec.unpackXpMap(h.record.data.participantXp)[participantA], 20,
                    'the retained L4 history and departed member-owned Ship are not a current catch-up leader');
                h.controls.members = [memberA, memberB, memberC];
                h.syncGameState();
                assert.equal(h.counts.calculate, 4);
                h.effects.push(receipt('dddddddd-0000-0000-0000-000000000004'));
                h.syncGameState();
                assert.equal(codec.unpackXpMap(h.record.data.participantXp)[participantA], 32,
                    'the re-participating L4 identity gives an L2 finisher exactly the inclusive +2 bonus');
                assert.equal(codec.unpackXpMap(h.record.data.participantXp)[participantB], 120);
                assert.equal(ships[0].version, 1);
                assert.equal(ships[1].version, 1);
            });
            const before = structuredClone(harness.game);
            harness.syncGameState();
            harness.syncGameState();
            assert.deepEqual(harness.game, before);
            assert.deepEqual(harness.events, ['error']);
            assert.equal(harness.publications.length, 0);
            harness.record.data.participantXp = codec.packXpMap({ [participantA]: 70 });
            harness.record.data.processedEffects = codec.packCounterMap({});
            harness.syncGameState();
            assert.equal(harness.record.version, 1);
            assert.equal(harness.game.score, 200);
            assert.equal(codec.unpackXpMap(harness.record.data.participantXp)[participantA], 70,
                'recovery and historical score never fabricate per-break XP');
            assert.equal(harness.publications.length, 1);
        }
    }
});

test('pre-departure ship inputs register zero players and credit departed scorers through the same calculator', () => {
    const harness = loadSyncHarness({ data: personalGameStateData() });
    const departing = [
        { id: secondId, data: { participantId: participantB, score: 0 } },
        { id: firstId, data: { participantId: participantA, score: 30 } },
    ];
    harness.game.multiplayer.gameStateObjectId = null;
    harness.syncGameState(true, departing);
    assert.equal(harness.game.multiplayer.gameStateObjectId, 'gs',
        'a departure before descriptor binding still uses the canonical GameState');
    harness.syncGameState();
    assert.equal(harness.game.score, 30);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores),
        { [participantA]: 30, [participantB]: 0 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantNumbers),
        { [participantA]: 1, [participantB]: 2 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.processedScores), { [firstId]: 30 });

    harness.ships.push({
        id: thirdId, data: { participantId: participantA, score: 0 },
    });
    harness.syncGameState();
    harness.handleShipStateChangedEvent(thirdId, { score: 15 });
    harness.syncGameState();
    assert.equal(harness.game.score, 45);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores),
        { [participantA]: 45, [participantB]: 0 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantNumbers),
        { [participantA]: 1, [participantB]: 2 });
    assert.equal(harness.game.lives, 4, 'rejoin must not repay the participant entry life');
});

test('fatal zero-score entrants persist, and accepted late score deltas do not freeze at game over', () => {
    const harness = loadSyncHarness({
        data: personalGameStateData({ lives: 1 }),
        ships: [{ id: firstId, data: { participantId: participantA, score: 0, hitCount: 1 } }],
    });
    harness.syncGameState();
    assert.equal(harness.game.lives, 0);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.countedParticipants), {});
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores), { [participantA]: 0 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantNumbers), { [participantA]: 1 });
    assert.equal(harness.record.data.terminalShipId, firstId);
    harness.handleShipStateChangedEvent(firstId, { score: 150, hitCount: 1 });
    harness.syncGameState();
    assert.equal(harness.game.score, 150);
    assert.equal(harness.game.lives, 0);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores), { [participantA]: 150 });
    assert.equal(harness.record.data.gameOverAt, 1000);
    assert.equal(harness.record.data.terminalAt, 1750);
    assert.equal(harness.record.data.scoreLifeAwardCount, 0);
});

test('missing current histories refuse publication and effects instead of silently producing team-only state', () => {
    for (const participantScores of [undefined, null]) {
        const harness = loadSyncHarness({
            data: { lives: 3, groupScore: 90, peakShipCount: 1, state: 'playing',
                participantScores, participantNumbers: undefined },
            ships: [{ id: firstId, data: { participantId: participantA, score: 20 } }],
        });
        const before = structuredClone(harness.game);
        harness.syncGameState();
        assert.deepEqual(harness.game, before);
        assert.deepEqual(harness.publications, []);
        assert.deepEqual(harness.events, ['error']);
    }
});

test('malformed personal history refuses publication and recovers after a same-version repair', () => {
    for (const extra of [
        { participantScores: new Uint8Array([1]) },
        { participantNumbers: undefined },
        { participantScores: { bad: 1 }, participantNumbers: { bad: 1 } },
        { participantScores: { [participantA]: 0 }, participantNumbers: { [participantA]: 0 } },
        { participantScores: { [participantA]: -1 }, participantNumbers: { [participantA]: 1 } },
        { participantScores: { [participantA]: 0 }, participantNumbers: { [participantB]: 1 } },
    ]) {
        const harness = loadSyncHarness({
            data: personalGameStateData(extra),
            ships: [{ id: firstId, data: { participantId: participantA, score: 20 } }],
        });
        harness.syncGameState();
        harness.syncGameState();
        assert.deepEqual(harness.events, ['error']);
        assert.equal(harness.publications.length, 0);
        assert.equal(harness.game.score, 0);
        harness.record.data.participantScores = codec.packCounterMap({});
        harness.record.data.participantNumbers = codec.packCounterMap({});
        harness.syncGameState();
        assert.equal(harness.record.version, 1);
        assert.equal(harness.game.score, 20);
        assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores), { [participantA]: 20 });
        assert.equal(harness.publications.length, 1);
    }
});

test('personal wire-range errors are reported rather than thrown after applying score or life effects', () => {
    const harness = loadSyncHarness({
        data: personalGameStateData({
            participantScores: codec.packCounterMap({ [participantA]: 0xffffffff }),
            participantNumbers: codec.packCounterMap({ [participantA]: 1 }),
        }),
        ships: [{ id: firstId, data: { participantId: participantA, score: 10 } }],
    });
    harness.syncGameState();
    harness.syncGameState();
    assert.deepEqual(harness.events, ['error']);
    assert.equal(harness.game.score, 0);
    assert.equal(harness.game.lives, 99);
    assert.equal(harness.publications.length, 0);
});

test('history mutations, authoritative recovery, and a new GameState owner invalidate caches without losing players', () => {
    const harness = loadSyncHarness({
        data: personalGameStateData(),
        ships: [{ id: firstId, data: { participantId: participantA, score: 25 } }],
    });
    harness.syncGameState();
    harness.record.data = personalGameStateData({
        groupScore: 40,
        processedScores: codec.packCounterMap({ [firstId]: 20 }),
        participantScores: codec.packCounterMap({ [participantA]: 40, [participantB]: 0 }),
        participantNumbers: codec.packCounterMap({ [participantA]: 4, [participantB]: 2 }),
    });
    harness.syncGameState();
    assert.equal(harness.record.version, 1, 'recovery need not advance the consumed version');
    assert.equal(harness.game.score, 45);
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores),
        { [participantA]: 45, [participantB]: 0 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantNumbers),
        { [participantA]: 4, [participantB]: 2 });

    const mutated = harness.record.data.participantScores;
    mutated[16] = 50;
    harness.syncGameState();
    assert.equal(codec.unpackCounterMap(harness.record.data.participantScores)[participantA], 50);
    harness.ships.length = 0;
    harness.controls.owner = false;
    harness.syncGameState();
    harness.controls.memberId = 'new-owner';
    harness.record.ownerMemberId = 'new-owner';
    harness.controls.owner = true;
    harness.syncGameState();
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantScores),
        { [participantA]: 50, [participantB]: 0 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.participantNumbers),
        { [participantA]: 4, [participantB]: 2 });
    assert.deepEqual(codec.unpackCounterMap(harness.record.data.processedScores), { [firstId]: 25 });
});
