import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { loadClassicModule } from './test-support/classic-module.mjs';

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const AstervoidsWireCodec = require('./wwwroot/js/astervoids-wire-codec.js');
const { SCHEMAS, requireCurrentSchemas } = require('./wwwroot/js/game-wire-schemas.js');
const { countExtraLivesForScore } = require('./wwwroot/js/game-config.js');
const id = number => `${number.toString(16).padStart(8, '0')}-1111-2222-3333-aabbccddeeff`;
const participantA = id(1);
const participantB = id(2);
const participantC = id(3);
const tagForParticipant = participantId => `Pilot${parseInt(participantId.slice(0, 8), 16)}`;
const tagsForParticipants = ids => AstervoidsWireCodec.packTagMap(
    Object.fromEntries(ids.map(participantId => [participantId, tagForParticipant(participantId)])));
const shipA = id(101);
const shipB = id(102);
const shipC = id(103);
const ship = (shipId, participantId, score = 0, hitCount = 0) => ({
    id: shipId, ownerMemberId: participantId,
    data: { type: 'ship', participantId, score, hitCount },
});
const { calculateGameState } = loadInlineGameFunctions(['calculateGameState'], {
    GuidUtils, AstervoidsWireCodec, countExtraLivesForScore,
});

function calculate({
    persisted = { lives: 3, groupScore: 0 },
    processedScores = {}, processedHits = {}, countedParticipants = {},
    participantScores = {}, participantNumbers = {}, participantTags, ships = [],
} = {}) {
    return calculateGameState(persisted, {
        processedScores, processedHits, countedParticipants, participantScores, participantNumbers, participantTags,
    }, ships, {
        lives: 3, state: 'playing', observedScoreLifeAwardCount: null,
    }, 1000);
}

function continueFrom(previous, ships) {
    return calculate({
        persisted: previous,
        processedScores: previous.processedScores,
        processedHits: previous.processedHits,
        countedParticipants: previous.countedParticipants,
        participantScores: previous.participantScores,
        participantNumbers: previous.participantNumbers,
        participantTags: previous.participantTags,
        ships,
    });
}

test('personal totals receive exactly the accepted positive per-ship team deltas', () => {
    const result = calculate({
        persisted: { lives: 3, groupScore: 90 },
        processedScores: { [shipA]: 50, [shipB]: 40 },
        participantScores: { [participantA]: 50, [participantB]: 40 },
        participantNumbers: { [participantA]: 1, [participantB]: 2 },
        countedParticipants: { [participantA]: 1, [participantB]: 1 },
        ships: [ship(shipA, participantA.toUpperCase(), 80), ship(shipB, participantB, 65)],
    });
    assert.equal(result.groupScore, 145);
    assert.deepEqual(result.participantScores, { [participantA]: 80, [participantB]: 65 });
    assert.deepEqual(result.participantNumbers, { [participantA]: 1, [participantB]: 2 });
    assert.equal(result.lives, 3, 'score registration is not an entry-life award');
    for (const scores of [[80, 65], [20, 0]]) {
        const repeated = continueFrom(result, [
            ship(shipA, participantA, scores[0]), ship(shipB, participantB, scores[1]),
        ]);
        assert.equal(repeated.groupScore, 145);
        assert.deepEqual(repeated.participantScores, result.participantScores);
    }
});

test('new players register at zero with immutable GUID-sorted numbers, not ship insertion order', () => {
    const ships = [ship(shipC, participantC), ship(shipA, participantA), ship(shipB, participantB)];
    const forward = calculate({ ships });
    const reverse = calculate({ ships: [...ships].reverse() });
    const scores = { [participantA]: 0, [participantB]: 0, [participantC]: 0 };
    const numbers = { [participantA]: 1, [participantB]: 2, [participantC]: 3 };
    assert.deepEqual(forward.participantScores, scores);
    assert.deepEqual(forward.participantNumbers, numbers);
    assert.deepEqual(reverse.participantScores, scores);
    assert.deepEqual(reverse.participantNumbers, numbers);
    assert.equal(forward.lives, 5, 'the existing three-player entry-life semantics remain intact');
});

test('registration includes fatal entrants and terminal zero-score departures without reviving lives', () => {
    for (const lives of [0, 1]) {
        const result = calculate({
            persisted: { lives, groupScore: 0 },
            ships: [ship(shipA, participantA, 0, 1), ship(shipB, participantB)],
        });
        assert.equal(result.lives, 0);
        assert.deepEqual(result.countedParticipants, {}, 'entry lives still follow damage');
        assert.deepEqual(result.participantScores, { [participantA]: 0, [participantB]: 0 });
        assert.deepEqual(result.participantNumbers, { [participantA]: 1, [participantB]: 2 });
    }
});

test('ship recreation and same-tab rejoin add new counters to the same historical player', () => {
    const first = calculate({ ships: [ship(shipA, participantA, 70)] });
    const departed = continueFrom(first, []);
    assert.deepEqual(departed.participantScores, { [participantA]: 70 });
    const rejoined = continueFrom(departed, [ship(shipB, participantA, 0)]);
    assert.equal(rejoined.groupScore, 70);
    assert.deepEqual(rejoined.participantScores, { [participantA]: 70 });
    assert.deepEqual(rejoined.participantNumbers, { [participantA]: 1 });
    const scored = continueFrom(rejoined, [ship(shipB, participantA, 20)]);
    assert.equal(scored.groupScore, 90);
    assert.deepEqual(scored.participantScores, { [participantA]: 90 });
    assert.deepEqual(scored.processedScores, { [shipA]: 70, [shipB]: 20 });
    assert.equal(scored.lives, first.lives, 'a recreated ship does not repay an entry life');
});

test('multiple ships for one participant attribute once per ship and never allocate a new number', () => {
    const result = calculate({
        ships: [ship(shipA, participantA, 20), ship(shipB, participantA, 30)],
    });
    assert.equal(result.groupScore, 50);
    assert.deepEqual(result.participantScores, { [participantA]: 50 });
    assert.deepEqual(result.participantNumbers, { [participantA]: 1 });
    assert.equal(result.lives, 3);
});

test('late terminal awards mirror existing team accounting and leave terminal anchors unchanged', () => {
    const persisted = {
        lives: 0, groupScore: 80, gameOverAt: 1000, terminalAt: 1750, terminalShipId: shipA,
    };
    const result = calculate({
        persisted, processedScores: { [shipA]: 80 },
        participantScores: { [participantA]: 80 }, participantNumbers: { [participantA]: 7 },
        ships: [ship(shipA, participantA, 100), ship(shipB, participantB, 10)],
    });
    assert.equal(result.groupScore, 110);
    assert.equal(result.lives, 0);
    assert.equal(result.scoreLifeAwardCount, 0);
    assert.equal(result.terminalShipId, shipA);
    assert.deepEqual(result.participantScores, { [participantA]: 100, [participantB]: 10 });
    assert.deepEqual(result.participantNumbers, { [participantA]: 7, [participantB]: 8 });
});

test('historical maps remain pure, uncapped, and survive migration with no live ships', () => {
    const scores = Object.freeze(Object.fromEntries(
        Array.from({ length: 260 }, (_, index) => [id(index + 1), index])));
    const numbers = Object.freeze(Object.fromEntries(
        Array.from({ length: 260 }, (_, index) => [id(index + 1), index + 1])));
    const result = calculate({
        participantScores: scores, participantNumbers: numbers,
        ships: [ship(shipA, id(1000))],
    });
    assert.equal(Object.keys(result.participantScores).length, 261,
        'the 255-entry life ledger ceiling must not evict score history');
    assert.equal(result.participantNumbers[id(1000)], 261);
    assert.equal(result.participantScores[id(1000)], 0);
    assert.notEqual(result.participantScores, scores);
    assert.notEqual(result.participantNumbers, numbers);
    assert.deepEqual(continueFrom(result, []).participantScores, result.participantScores);
});

test('missing historical ledgers preserve team calculation without fabricating personal totals', () => {
    const result = calculate({
        participantScores: null, participantNumbers: null,
        persisted: { lives: 3, groupScore: 1000 },
        ships: [ship(shipA, participantA, 30)],
    });
    assert.equal(result.groupScore, 1030);
    assert.equal(result.participantScores, null);
    assert.equal(result.participantNumbers, null);
});

test('missing or malformed participant IDs never create guessed historical players or entry lives', () => {
    const result = calculate({
        ships: [undefined, 'not-a-guid', 15, null].map((participantId, index) =>
            ship(id(100 + index), participantId, 10)),
    });
    assert.equal(result.groupScore, 40, 'existing team delta acceptance does not depend on identity');
    assert.equal(result.lives, 3);
    assert.deepEqual(result.participantScores, {});
    assert.deepEqual(result.participantNumbers, {});
    assert.deepEqual(result.countedParticipants, {});
});

function historyFunctions(extra = {}) {
    return loadInlineGameFunctions([
        'gameStateCounterMapsEqual', 'gameStateLedgerMatches', 'readGameStateLedger',
        'normalizeParticipantLedger', 'readParticipantScoreHistory',
        'projectParticipantScore', 'rankParticipantScores',
    ], { GuidUtils, AstervoidsWireCodec, ...extra });
}

function history(scores, numbers) {
    return historyFunctions().readParticipantScoreHistory({
        participantScores: AstervoidsWireCodec.packCounterMap(scores),
        participantNumbers: AstervoidsWireCodec.packCounterMap(numbers),
        participantTags: tagsForParticipants(Object.keys(numbers)),
    });
}

test('history readers normalize GUIDs, validate scores and numbers, and keep private mutation snapshots', () => {
    const functions = historyFunctions();
    const data = {
        participantScores: AstervoidsWireCodec.packCounterMap({ [participantA.toUpperCase()]: 25 }),
        participantNumbers: AstervoidsWireCodec.packCounterMap({ [participantA.toUpperCase()]: 4 }),
    };
    const first = functions.readParticipantScoreHistory(data);
    assert.deepEqual(first.scores.counters, { [participantA]: 25 });
    assert.deepEqual(first.numbers.counters, { [participantA]: 4 });
    assert.equal(functions.readParticipantScoreHistory(data, first), first);
    data.participantScores[16] = 35;
    const changed = functions.readParticipantScoreHistory(data, first);
    assert.equal(changed.scores.counters[participantA], 35);
    assert.equal(first.scores.counters[participantA], 25);
    assert.equal(changed.numbers, first.numbers);
    assert.equal(functions.readParticipantScoreHistory({}), null);
});

test('malformed, partial, duplicate-GUID, and mismatched history is rejected instead of silently reset', () => {
    const { readParticipantScoreHistory } = historyFunctions();
    const valid = {
        participantScores: { [participantA]: 0 }, participantNumbers: { [participantA]: 1 },
    };
    const repeatedBytes = new Uint8Array(40);
    repeatedBytes.set(AstervoidsWireCodec.packCounterMap({ [participantA]: 10 }), 0);
    repeatedBytes.set(AstervoidsWireCodec.packCounterMap({ [participantA]: 20 }), 20);
    for (const data of [
        { ...valid, participantScores: new Uint8Array([1]) },
        { ...valid, participantNumbers: undefined },
        { ...valid, participantScores: { bad: 1 } },
        { ...valid, participantScores: { [participantA]: -1 } },
        { ...valid, participantScores: { [participantA]: 1.5 } },
        { ...valid, participantScores: { [participantA]: 0x100000000 } },
        { ...valid, participantNumbers: { [participantA]: 0 } },
        { ...valid, participantNumbers: { [participantA]: 1.5 } },
        { ...valid, participantNumbers: { [participantB]: 2 } },
        { ...valid, participantScores: { [participantA]: 1, [participantA.toUpperCase()]: 2 } },
        { ...valid, participantScores: repeatedBytes },
    ]) {
        assert.throws(() => readParticipantScoreHistory(data));
    }
});

test('immediate personal score projects positive unprocessed counters without a local accumulator', () => {
    const { projectParticipantScore } = historyFunctions();
    const ledgers = history({ [participantA]: 100 }, { [participantA]: 4 });
    const records = [ship(shipA, participantA, 45), ship(shipB, participantA, 10),
        ship(shipC, participantB, 500)];
    const processed = { [shipA]: 30, [shipB]: 20 };
    assert.equal(projectParticipantScore(ledgers, processed, records, participantA.toUpperCase()), 115);
    assert.equal(projectParticipantScore(ledgers, processed, records, participantA), 115);
    assert.equal(ledgers.scores.counters[participantA], 100);
    assert.equal(projectParticipantScore(ledgers, processed, [], participantA), 100);
    assert.equal(projectParticipantScore(ledgers, processed, [], participantB), null,
        'a pure spectator has no personal score, rather than an invented zero');
    assert.equal(projectParticipantScore(null, processed, records, participantA), null);
});

test('standings use score descending, immutable number ascending and normalized GUID lexical fallback', () => {
    const { rankParticipantScores } = historyFunctions();
    const ledgers = history(
        { [participantC]: 90, [participantB]: 90, [participantA]: 90, [id(4)]: 0 },
        { [participantC]: 2, [participantB]: 1, [participantA]: 1, [id(4)]: 4 });
    const rows = rankParticipantScores(ledgers, 3);
    assert.deepEqual(rows.map(row => [row.participantId, row.label, row.score]), [
        [participantA, 'Pilot1', 90], [participantB, 'Pilot2', 90],
        [participantC, 'Pilot3', 90], [id(4), 'Pilot4', 0],
    ]);
    assert.deepEqual(rows.map(row => row.rank), [1, 2, 3, 4]);
});

test('topK depends on actual capacity, keeps highest scorers, and never caps the running ledgers', () => {
    const { rankParticipantScores } = historyFunctions();
    const scores = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [id(n + 1), n * 10]));
    const numbers = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [id(n + 1), n + 1]));
    const ledgers = history(scores, numbers);
    for (const [maxMembers, limit] of [[3, 4], [5, 7]]) {
        const rows = rankParticipantScores(ledgers, maxMembers);
        assert.equal(rows.length, limit);
        assert.deepEqual(rows.map(row => row.score), Array.from({ length: limit }, (_, n) => 90 - n * 10));
        assert.equal(rows[0].label, 'Pilot10', 'labels are not assigned from rank');
    }
    for (const capacity of [undefined, null, 0, -1, 3.5, '5']) {
        assert.equal(rankParticipantScores(ledgers, capacity), null);
    }
    assert.equal(Object.keys(ledgers.scores.counters).length, 10);
});

test('score and tag slots are mandatory in the current game session contract', () => {
    requireCurrentSchemas({ schemas: SCHEMAS });
    for (const slots of [16, 18]) {
        assert.throws(() => requireCurrentSchemas({
            schemas: SCHEMAS.map(schema => schema.id === 4
                ? { ...schema, fields: schema.fields.slice(0, slots) } : schema),
        }), /Unsupported Astervoids session schemas/);
    }
});

test('session capacity is taken only from a matching valid active-session advertisement', () => {
    const { getAdvertisedSessionCapacity } = loadInlineGameFunctions(['getAdvertisedSessionCapacity']);
    const sessions = [{ id: participantB, maxMembers: 50 },
        { id: participantA.toUpperCase(), maxMembers: 5 }];
    assert.equal(getAdvertisedSessionCapacity(participantA, sessions), 5);
    assert.equal(getAdvertisedSessionCapacity(participantC, sessions), null);
    for (const maxMembers of [undefined, null, 0, -1, 3.5, '5']) {
        assert.equal(getAdvertisedSessionCapacity(participantA, [{ id: participantA, maxMembers }]), null);
    }
});

function capacityHarness({ sessions = [], lookup = async () => ({ sessions: [] }) } = {}) {
    const game = { mode: 'session', sessionInfo: { id: participantA, maxMembers: null } };
    const sessionPicker = { sessions };
    const controls = { epoch: 1, joined: true, calls: 0 };
    const warnings = [];
    const functions = loadInlineGameFunctions([
        'getAdvertisedSessionCapacity', 'captureSessionCapacity', 'ensureSessionCapacity',
        'applySessionMembership', 'updateSessionList',
    ], {
        game, sessionPicker, sessionCapacityLookup: null,
        isSessionMode: () => game.mode === 'session',
        isSessionPickerActive: () => false,
        adoptSessionConfig() {},
        SessionClient: {
            isInSession: () => controls.joined,
            getSessionEpoch: () => controls.epoch,
            getActiveSessions: async (...args) => {
                assert.deepEqual(args, [], 'query the already joined hub, not another region');
                controls.calls++;
                return lookup();
            },
        },
        _warn: (...args) => warnings.push(args),
    });
    return { ...functions, game, sessionPicker, controls, warnings };
}

test('known advertisement capacity survives same-session reentry without another query', async () => {
    const h = capacityHarness({ sessions: [{ id: participantA, maxMembers: 5 }] });
    await h.ensureSessionCapacity();
    assert.equal(h.game.sessionInfo.maxMembers, 5);
    assert.equal(h.controls.calls, 0);
    h.sessionPicker.sessions = [];
    h.applySessionMembership({
        session: { id: participantA, name: 'Apple', metadata: { schemas: SCHEMAS }, maxMembers: 99 },
        member: { id: participantB, role: 'Client' },
    });
    await h.ensureSessionCapacity();
    assert.equal(h.game.sessionInfo.maxMembers, 5);
    assert.equal(h.controls.calls, 0, 'membership DTO capacity is not substituted for an advertisement');
});

test('missing create capacity performs at most one joined-hub query and can recover from a create refresh', async () => {
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const h = capacityHarness({ lookup: () => pending });
    const first = h.ensureSessionCapacity();
    const second = h.ensureSessionCapacity();
    assert.equal(h.controls.calls, 1);
    assert.equal(h.game.sessionInfo.maxMembers, null);
    complete({ sessions: [{ id: participantA, maxMembers: 3 }] });
    await Promise.all([first, second]);
    assert.equal(h.game.sessionInfo.maxMembers, 3);
    await h.ensureSessionCapacity();
    assert.equal(h.controls.calls, 1);
    h.updateSessionList({ sessions: [{ id: participantA, maxMembers: 5 }] });
    assert.equal(h.game.sessionInfo.maxMembers, 5,
        'capture advertisements even when the picker stopped during entry');
});

test('capacity lookup failure is explicit, never polls, and later advertisements recover it', async () => {
    const h = capacityHarness({ lookup: async () => { throw new Error('unavailable'); } });
    await h.ensureSessionCapacity();
    for (let frame = 0; frame < 20; frame++) await h.ensureSessionCapacity();
    assert.equal(h.controls.calls, 1);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.game.sessionInfo.maxMembers, null);
    h.captureSessionCapacity([{ id: participantA, maxMembers: 5 }]);
    await h.ensureSessionCapacity();
    assert.equal(h.game.sessionInfo.maxMembers, 5);
    assert.equal(h.controls.calls, 1);
});

test('a stale capacity response cannot populate a different session or rejoin epoch', async () => {
    let complete;
    const h = capacityHarness({ lookup: () => new Promise(resolve => { complete = resolve; }) });
    const old = h.ensureSessionCapacity();
    h.controls.epoch++;
    h.game.sessionInfo = { id: participantB, maxMembers: null };
    complete({ sessions: [{ id: participantA, maxMembers: 50 }, { id: participantB, maxMembers: 3 }] });
    await old;
    assert.equal(h.game.sessionInfo.maxMembers, null);
    assert.equal(h.warnings.length, 0);
    h.controls.joined = false;
    await h.ensureSessionCapacity();
    assert.equal(h.controls.calls, 1);
});

function counterHarness({ deltaEncoding = true } = {}) {
    const handlers = {};
    const requests = [];
    const events = [];
    const controls = { accept: true };
    const game = {
        ship: {
            x: 0.5, score: 0, hitCount: 0, syncObjectId: shipA,
            toUpdateData() { return { x: this.x }; },
        },
        multiplayer: { myShipObjectId: shipA },
    };
    const SessionClient = {
        on: (name, handler) => { handlers[name] = handler; },
        getSessionEpoch: () => 1,
        getCurrentMember: () => ({ id: participantA }),
        isInSession: () => true,
        broadcastObjectEvent: async (objectId, kind, payload) => {
            events.push({ objectId, kind, payload });
            return true;
        },
        updateObjects: async updates => {
            requests.push(structuredClone(updates));
            return { versions: controls.accept ? { [shipA]: requests.length + 1 } : {} };
        },
    };
    const ObjectSync = loadClassicModule('object-sync.js', 'ObjectSync', {
        SessionClient, AuthoritativeObject: require('./wwwroot/js/authoritative-object.js'),
        MsgpackCodec: require('./wwwroot/js/msgpack-codec.js'), window: {},
    });
    ObjectSync.init();
    ObjectSync.configure({ deltaEncoding });
    handlers.onSessionJoined({ objects: [{
        id: shipA, data: { type: 'ship', participantId: participantA, score: 0, hitCount: 0 },
        version: 1, ownerMemberId: participantA, creatorMemberId: participantA, scope: 'Member',
    }] });
    const functions = loadInlineGameFunctions([
        'syncLocalShipScore', 'emitShipStateChanged', 'syncLocalShip', 'handleShipStateChangedEvent',
    ], {
        game, ObjectSync, isSessionMode: () => true,
        EVENT_KIND: { SHIP_STATE_CHANGED: 'ship-state-changed' },
        CollisionEffects: { startShipHit() {} },
        CONFIG: { SHIP_EDGE_SEND_ENABLED: true },
        isDeterministicMode: () => true,
        ShipControlGate: { isEdge: () => false },
        ShipSendGate: { shouldSend: () => false },
        _error: (...args) => assert.fail(args.join(' ')),
    });
    ObjectSync.registerEventKind('ship-state-changed', 1);
    ObjectSync.on('objectEvent:ship-state-changed', functions.handleShipStateChangedEvent);
    return { ...functions, game, ObjectSync, requests, events, controls };
}

for (const deltaEncoding of [true, false]) {
    test(`rare score changes persist with fresh motion outside the motion gate (delta=${deltaEncoding})`, async () => {
        const h = counterHarness({ deltaEncoding });
        h.game.ship.score = 30;
        h.emitShipStateChanged();
        await h.ObjectSync.flushUpdates();
        assert.deepEqual(h.requests.map(batch => batch.map(update => update.data)), [[{ x: 0.5, score: 30 }]]);
        assert.equal(h.events.length, 1, 'transient feedback remains available');
        assert.equal(h.ObjectSync.getObject(shipA).data.score, 30);
        for (let frame = 0; frame < 120; frame++) {
            h.game.ship.x += 0.001;
            h.syncLocalShip();
            await h.ObjectSync.flushUpdates();
        }
        assert.equal(h.requests.length, 1, 'confirmed scores add no steady-state traffic');
        h.game.ship.hitCount++;
        h.emitShipStateChanged({ x: 0.2, y: 0.3, angle: 1 });
        await h.ObjectSync.flushUpdates();
        assert.equal(h.requests.length, 1, 'hit-only events do not republish a confirmed score');
        assert.equal(h.events.length, 2);
    });
}

test('rejected score writes retry outside the motion gate until confirmed, including terminal maintenance', async () => {
    const h = counterHarness();
    h.controls.accept = false;
    h.game.ship.score = 40;
    h.emitShipStateChanged();
    await h.ObjectSync.flushUpdates();
    h.game.ship.x = 0.55;
    h.syncLocalShip();
    await h.ObjectSync.flushUpdates();
    h.controls.accept = true;
    h.game.ship.x = 0.6;
    h.syncLocalShipScore();
    await h.ObjectSync.flushUpdates();
    assert.deepEqual(h.requests.map(batch => batch[0].data), [
        { x: 0.5, score: 40 }, { x: 0.55, score: 40 }, { x: 0.6, score: 40 }
    ], 'each unconfirmed score retry captures the current pose');
    h.syncLocalShipScore();
    await h.ObjectSync.flushUpdates();
    assert.equal(h.requests.length, 3);
    const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
    assert.match(source, /if \(!frozenForReconnect && isSessionMode\(\) && isGameOver\(\)\) \{\s*syncLocalShipScore\(\);/);
    assert.match(source, /if \(isGameOver\(\)\) \{\s*syncLocalShipScore\(\);/);
});

function departureHarness({ migrate = false } = {}) {
    const gs = {
        id: id(200), ownerMemberId: migrate ? participantA : participantC, version: 1,
        data: {
            type: 'gameState', lives: 1, groupScore: 0, state: 'playing', wave: 9,
            speedMultiplier: 2, waveDelayTimer: 0,
            participantScores: AstervoidsWireCodec.packCounterMap({}),
            participantNumbers: AstervoidsWireCodec.packCounterMap({}),
        },
    };
    const scorer = ship(shipA, participantA, 30, 1);
    const zero = ship(shipB, participantB);
    const records = new Map([[gs.id, gs], [scorer.id, scorer], [zero.id, zero]]);
    const game = {
        mode: 'session', state: migrate ? 'lobby' : 'playing', wave: migrate ? 0 : 9,
        score: 0, lives: 1, speedMultiplier: migrate ? 1 : 2, waveDelayTimer: 0,
        multiplayer: { gameStateObjectId: null, observedScoreLifeAwardCount: null, isAuthority: false },
    };
    const publications = [];
    let functions;
    const ObjectSync = {
        getObject: objectId => records.get(objectId),
        getObjectByType: type => [...records.values()].find(record => record.data?.type === type),
        getObjectsByType: type => [...records.values()].filter(record => record.data?.type === type),
        trackEventSequence() {},
        handleMemberDeparture: ids => {
            for (const objectId of ids) {
                const record = records.get(objectId);
                records.delete(objectId);
                if (record) functions.handleGameObjectDeleted(record);
            }
        },
        handleOwnershipMigration: migrations => {
            for (const migration of migrations) records.get(migration.objectId).ownerMemberId = migration.newOwnerId;
        },
        updateObject: (objectId, payload, immediate) => {
            publications.push({ objectId, payload, immediate });
            Object.assign(records.get(objectId).data, payload);
            return true;
        },
    };
    functions = loadInlineGameFunctions([
        'handleSessionMemberLeft', 'handleGameObjectDeleted', 'syncGameState',
        'calculateGameState', 'calculateGameStateTerminal', 'applyCalculatedGameState',
        'serializeGameState', 'resetGameStateSyncCache', 'reportMalformedGameStateLedgers',
        'normalizeParticipantLedger', 'readParticipantScoreHistory',
        'gameStateCounterMapsEqual', 'gameStateLedgerMatches', 'readGameStateLedger',
        'packGameStateLedger', 'gameStateCalculationInputs', 'gameStateInputsEqual', 'applyGameStateData',
    ], {
        game, ObjectSync, countExtraLivesForScore, GuidUtils, AstervoidsWireCodec,
        handlingMemberDeparture: false, malformedGameStateLedgerKey: null, gameStateSyncCache: null,
        isSessionMode: () => true,
        isGameStateOwner: () => gs.ownerMemberId === participantC,
        isLobbySpectating: () => true,
        OBJECT_TYPES: { SHIP: 'ship', GAME_STATE: 'gameState' },
        CONFIG: { EXTRA_LIFE_SCORE_THRESHOLD: 1000, DEADRECKON_GAMEOVER_TERMINAL_DELAY_MS: 750 },
        SessionClient: {
            getSessionEpoch: () => 1, getCurrentMember: () => ({ id: participantC, role: 'Client' }),
            getCurrentSession: () => ({ metadata: { schemas: SCHEMAS } }),
        },
        RemoteObjects: { removeMember() {}, remove() {}, serverNowMs: () => 1000 },
        DeadReckon: { remove() {} }, SendGate: { remove() {} },
        replicationRuntime: { handleDeletedObjectIds() {}, handleOwnershipMigrations() {} },
        AudioSystem: { beat: { stop() {} }, thrustSound: { stop() {} }, playNewWave() {} },
        announceExtraLifeAward: () => assert.fail('a terminal newcomer cannot revive lives'),
        updateCurrentSessionStatus() {},
        _error: (...args) => assert.fail(args.join(' ')),
    });
    return { ...functions, game, gs, scorer, zero, records, publications };
}

for (const migrate of [false, true]) {
    test(`member departure captures scorers and zero entrants before cleanup (migration=${migrate})`, () => {
        const h = departureHarness({ migrate });
        h.handleSessionMemberLeft({
            memberId: participantA,
            deletedObjectIds: [shipA, shipB],
            migratedObjects: migrate ? [{ objectId: h.gs.id, newOwnerId: participantC }] : [],
        }, participantA, 3);
        assert.equal(h.publications.length, 1, 'deletion callbacks do not split the ordered calculation');
        assert.equal(h.publications[0].immediate, true);
        assert.equal(h.game.multiplayer.isAuthority, false, 'GameState owner, not Server role, publishes');
        assert.equal(h.game.lives, 0);
        assert.equal(h.game.score, 30);
        assert.equal(h.gs.data.wave, 9, 'a lobby spectator adopts canonical state before migration publication');
        assert.equal(h.gs.data.speedMultiplier, 2);
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(h.gs.data.participantScores),
            { [participantA]: 30, [participantB]: 0 });
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(h.gs.data.participantNumbers),
            { [participantA]: 1, [participantB]: 2 });
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(h.gs.data.countedParticipants), {});
        assert.equal(h.records.has(shipA), false);
        assert.equal(h.gs.data.terminalShipId, shipA);
        h.syncGameState();
        assert.equal(h.game.score, 30, 'later empty membership cannot double-count or erase history');
    });
}

test('manual ship deletion and repeated deletion callbacks retain the same historical score', () => {
    const h = departureHarness();
    h.records.delete(shipA);
    h.handleGameObjectDeleted(h.scorer);
    h.handleGameObjectDeleted(h.scorer);
    assert.equal(h.game.score, 30);
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(h.gs.data.participantScores),
        { [participantA]: 30, [participantB]: 0 });
    assert.equal(h.gs.data.terminalShipId, shipA);
});

test('voluntary leave retains ship inputs for atomic departure while GameState publication is unconfirmed', async () => {
    for (const name of ['handleLeaveLobby', 'returnToStartScreen']) {
        const h = departureHarness({ migrate: true });
        const local = {
            mode: 'session', state: 'playing', ship: {}, score: 30, lives: 1, wave: 9,
            multiplayer: { myShipObjectId: shipA }, connectionLost: false,
        };
        const classes = { classList: { remove() {} } };
        const errors = [];
        let deletedBeforeDeparture = false;
        const { [name]: leave } = loadInlineGameFunctions([name], {
            game: local,
            finishLeaderboardRun: () => null,
            closeLeaderboards() {},
            beginVoluntarySessionLeave() {},
            deleteSyncedShip: async () => {
                deletedBeforeDeparture = true;
                h.records.delete(shipA);
            },
            SessionClient: {
                isConnected: () => true, isInSession: () => true,
                leaveSession: async () => {
                    assert.equal(h.gs.data.groupScore, 0, 'old owner publication has not been accepted');
                    assert.ok(h.records.has(shipA), 'ship inputs must still exist at MemberLeft');
                    h.handleSessionMemberLeft({
                        memberId: participantA, deletedObjectIds: [shipA, shipB],
                        migratedObjects: [{ objectId: h.gs.id, newOwnerId: participantC }],
                    }, participantA, 4);
                },
            },
            resetMultiplayerState: () => { local.ship = null; },
            restoreSoloMode: () => { local.mode = 'solo'; },
            isSessionMode: () => local.mode === 'session',
            sessionPicker: { regions: [], selectedSessionId: participantA },
            leavingSession: true, spawningWave: false,
            resizeCanvas() {}, updateHUD() {}, publishDebugMetrics() {},
            activateSessionPickerUpdates: async () => {},
            resetStartScreenVisuals() {}, setPickerStatus() {},
            CONFIG: { STARTING_LIVES: 3 },
            pauseMenu: classes, reconnectingOverlay: classes, waveOverlay: classes,
            gameoverOverlay: classes, startScreen: classes, overlayCache: {},
            AudioSystem: { beat: { stop() {} }, thrustSound: { stop() {} } },
            _error: (...args) => assert.fail(args.join(' ')),
            console: { error: error => errors.push(error) },
        });
        await leave();
        assert.equal(deletedBeforeDeparture, false, name);
        assert.deepEqual(errors, []);
        assert.equal(h.game.score, 30);
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(h.gs.data.participantScores),
            { [participantA]: 30, [participantB]: 0 });
        assert.equal(local.mode, 'solo');
        assert.equal(local.ship, null);
    }
});

test('session reset retires the local ship without pre-deleting the durable departure input', () => {
    const previousShip = { deathHold: {} };
    const game = {
        mode: 'session', ship: previousShip,
        multiplayer: { remoteShips: new Map(), processedPendingBullets: new Set() },
    };
    let transportClears = 0;
    const clear = { clear() {} };
    const { resetMultiplayerState } = loadInlineGameFunctions(['resetMultiplayerState'], {
        game, gameStateScoreViewCache: null, backgroundInterval: null,
        resetGameStateSyncCache() {}, clearExtraLifeAwardFeedback() {},
        clearDeterministicTerminalState() {},
        CollisionEffects: clear, RemoteObjects: clear, DeadReckon: clear, SendGate: clear,
        ShipSendGate: clear, ShipControlGate: { reset() {} },
        ObjectSync: {
            clear: () => transportClears++,
            deleteObject: () => assert.fail('member departure owns server cleanup'),
        },
        replicationRuntime: { resetSession() {} },
    });
    resetMultiplayerState();
    assert.equal(previousShip.deathHold, null);
    assert.equal(game.ship, null);
    assert.equal(game.multiplayer.myShipObjectId, null);
    assert.equal(transportClears, 1);
    const soloShip = { deathHold: {} };
    game.mode = 'solo';
    game.ship = soloShip;
    resetMultiplayerState();
    assert.equal(game.ship, soloShip, 'solo menu keeps its existing ship presentation');
});

function scoreUiHarness({
    data, maxMembers = 3, ships = [], participantId = participantA, participantTag,
} = {}) {
    const writes = [];
    const identity = { participantId, epoch: 1 };
    function element(tag = 'div') {
        const classes = new Set();
        let text = '';
        let hidden = false;
        return {
            tag, children: [], attributes: {}, style: {},
            classList: {
                toggle: (name, enabled) => { writes.push(['class', name, enabled]); enabled ? classes.add(name) : classes.delete(name); },
                contains: name => classes.has(name),
            },
            set textContent(value) { text = String(value); this.children = []; writes.push(['text', tag, text]); },
            get textContent() { return text + this.children.map(child => child.textContent).join(''); },
            set hidden(value) { hidden = value; writes.push(['hidden', value]); },
            get hidden() { return hidden; },
            setAttribute(name, value) { this.attributes[name] = value; writes.push(['attribute', name, value]); },
            append(...children) { this.children.push(...children); },
            replaceChildren(fragment) { this.children = fragment.children; writes.push(['rows']); },
        };
    }
    const game = {
        mode: 'session', state: 'playing', score: 999, wave: 3, lives: 0,
        sessionInfo: { name: 'Long session name that must ellipsize', maxMembers },
        ship: null,
    };
    const record = {
        id: id(200), version: 1,
        data: data ?? {
            groupScore: 120, processedScores: AstervoidsWireCodec.packCounterMap({}),
            participantScores: AstervoidsWireCodec.packCounterMap({ [participantA]: 100, [participantB]: 20 }),
            participantNumbers: AstervoidsWireCodec.packCounterMap({ [participantA]: 4, [participantB]: 2 }),
        },
    };
    if (record.data.participantTags === undefined
        && record.data.participantNumbers instanceof Uint8Array) {
        record.data.participantTags = tagsForParticipants(
            Object.keys(AstervoidsWireCodec.unpackCounterMap(record.data.participantNumbers)));
    }
    const elements = Object.fromEntries([
        'hudDisplay', 'scoreDisplay', 'yourScoreDisplay', 'teamScoreDisplay', 'playerIndicatorDisplay', 'waveDisplay',
        'livesDisplay', 'waveOverlay', 'waveTextEl', 'gameoverOverlay', 'gameoverPersonalScoreEl', 'gameoverScoreEl',
        'gameoverResultsEl', 'gameoverPromptEl', 'sessionIndicator',
    ].map(name => [name, element()]));
    const errors = [];
    const counts = { unpack: 0, layout: 0 };
    const functions = loadInlineGameFunctions([
        'updateHUD', 'updateGameplayOverlays', 'renderParticipantScoreRows', 'isPersonalScoreScrollTarget',
        'getSessionScoreView', 'normalizeParticipantLedger',
        'readParticipantScoreHistory', 'readGameStateLedger', 'gameStateLedgerMatches',
        'gameStateCounterMapsEqual', 'projectParticipantScore', 'rankParticipantScores',
    ], {
        ...elements, game, GuidUtils, gameStateScoreViewCache: null, hudCache: {}, overlayCache: {},
        AstervoidsWireCodec: {
            ...AstervoidsWireCodec,
            unpackCounterMap: value => { counts.unpack++; return AstervoidsWireCodec.unpackCounterMap(value); },
        },
        OBJECT_TYPES: { GAME_STATE: 'gameState', SHIP: 'ship' },
        isSessionMode: () => game.mode === 'session',
        fitSessionHud: () => counts.layout++,
        isGameOver: () => game.lives === 0,
        isLobbySpectating: () => false,
        SessionClient: {
            getSessionEpoch: () => identity.epoch, getParticipantId: () => identity.participantId,
            getParticipantIdentity: () => participantTag ? { id: identity.participantId, tag: participantTag } : null,
            getCurrentSession: () => ({ metadata: { schemas: SCHEMAS } }),
        },
        ObjectSync: {
            getObjectByType: type => type === 'gameState' ? record : null,
            getObjectsByType: () => ships,
        },
        document: {
            getElementById: name => name === 'session-indicator' ? elements.sessionIndicator : null,
            createDocumentFragment: () => element('fragment'),
            createElement: element,
        },
        _error: (...args) => errors.push(args),
        _warn: (...args) => errors.push(args),
    });
    return { ...functions, ...elements, record, game, ships, writes, errors, counts, identity };
}

function standingsRows(container) {
    const table = container.children.find(element => element.tag === 'table');
    return table?.children.find(element => element.tag === 'tbody').children
        .map(row => row.children.map(cell => cell.textContent)) ?? [];
}

test('durable tags replace placeholders without changing ordinal ranking, totals, or solo identity', () => {
    const h = scoreUiHarness({ participantTag: 'Pilot_1' });
    h.record.data.participantTags = AstervoidsWireCodec.packTagMap({
        [participantA]: 'Pilot_1', [participantB]: 'Nova-2',
    });
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot_1');
    assert.equal(h.yourScoreDisplay.textContent, '100');
    assert.deepEqual(standingsRows(h.gameoverResultsEl).map(row => row[1]), ['Pilot_1', 'Nova-2']);
    const history = h.getSessionScoreView().history;
    for (let frame = 0; frame < 120; frame++) h.updateHUD();
    assert.equal(h.getSessionScoreView().history, history);
    h.game.mode = 'solo';
    h.game.playerIdentity = { id: participantA, tag: 'Pilot_1' };
    h.updateHUD();
    assert.equal(h.scoreDisplay.textContent, 'Score: 999 : Pilot_1');
});

test('missing or malformed tag metadata shows Unknown without hiding valid scores', () => {
    const h = scoreUiHarness();
    h.record.data.participantTags = new Uint8Array([1, 2]);
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.yourScoreDisplay.textContent, '100');
    assert.equal(h.teamScoreDisplay.textContent, '120');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Unknown');
    assert.deepEqual(standingsRows(h.gameoverResultsEl).map(row => row[1]), ['Unknown', 'Unknown']);
    const errors = h.errors.length;
    for (let frame = 0; frame < 120; frame++) h.updateGameplayOverlays();
    assert.equal(h.errors.length, errors, 'unchanged malformed metadata is reported once, not each frame');
    h.record.data.participantTags = AstervoidsWireCodec.packTagMap({ [participantA]: 'Pilot_1' });
    h.updateGameplayOverlays();
    assert.equal(standingsRows(h.gameoverResultsEl)[0][1], 'Pilot_1', 'a tag-only update invalidates rendered rows');
});

test('one durable identity across browsers aggregates ships, retains its tag, and receives one entry life', () => {
    const first = calculate({
        participantTags: {},
        ships: [
            { ...ship(shipA, participantA, 20), data: { ...ship(shipA, participantA, 20).data, participantTag: 'Pilot_1' } },
            { ...ship(shipB, participantA, 30), data: { ...ship(shipB, participantA, 30).data, participantTag: 'Pilot_1' } },
        ],
    });
    assert.deepEqual(first.participantScores, { [participantA]: 50 });
    assert.deepEqual(first.participantTags, { [participantA]: 'Pilot_1' });
    assert.equal(first.lives, 3);
    const departed = continueFrom(first, []);
    assert.deepEqual(departed.participantTags, first.participantTags);
    assert.deepEqual(departed.participantScores, first.participantScores);
});

test('canonical scalar replacements reuse personal history decodes and standings without frame map allocations', () => {
    const h = scoreUiHarness();
    h.updateHUD();
    h.updateGameplayOverlays();
    const history = h.getSessionScoreView().history;
    const decoded = h.counts.unpack;
    const measured = h.counts.layout;
    const writes = h.writes.length;
    for (let frame = 0; frame < 120; frame++) {
        h.record.data = {
            ...h.record.data, waveDelayTimer: frame / 60,
            participantScores: new Uint8Array(h.record.data.participantScores),
            participantNumbers: new Uint8Array(h.record.data.participantNumbers),
            processedScores: new Uint8Array(h.record.data.processedScores),
        };
        h.updateHUD();
        h.updateGameplayOverlays();
        assert.equal(h.getSessionScoreView().history, history);
    }
    assert.equal(h.counts.unpack, decoded);
    assert.equal(h.counts.layout, measured, 'unchanged scalar replacements never remeasure HUD layout');
    assert.equal(h.writes.length, writes);
});

test('multiplayer final standings replace the playing HUD while solo retains Score and Final Score', () => {
    const h = scoreUiHarness();
    h.game.lives = 1;
    h.updateHUD();
    assert.equal(h.hudDisplay.style.display, 'flex');
    h.game.lives = 0;
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.hudDisplay.style.display, 'none');
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: 100');
    assert.equal(h.gameoverPersonalScoreEl.hidden, false);
    assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 120');
    assert.equal(h.gameoverResultsEl.hidden, false);
    h.game.mode = 'solo';
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.hudDisplay.style.display, 'flex');
    assert.equal(h.scoreDisplay.textContent, 'Score: 999');
    assert.equal(h.gameoverScoreEl.textContent, 'Final Score: 999');
    assert.equal(h.gameoverPersonalScoreEl.hidden, true);
});

test('multiplayer HUD projects your lifetime score above team score, and solo keeps Score', () => {
    const h = scoreUiHarness({ ships: [ship(shipA, participantA, 20)] });
    h.game.ship = { syncObjectId: shipA, score: 25 };
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '125');
    assert.equal(h.yourScoreDisplay.attributes['aria-label'], 'Your Score 125');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot1');
    assert.equal(h.sessionIndicator.textContent, h.game.sessionInfo.name);
    assert.equal(h.teamScoreDisplay.textContent, '120');
    assert.equal(h.hudDisplay.classList.contains('multiplayer'), true);
    const writes = h.writes.length;
    const decoded = h.counts.unpack;
    for (let frame = 0; frame < 120; frame++) h.updateHUD();
    assert.equal(h.writes.length, writes);
    assert.equal(h.counts.unpack, decoded, 'HUD never decodes unchanged maps every frame');
    assert.equal(h.counts.layout, 1, 'unchanged HUD contents do not trigger per-frame layout reads');
    h.ships[0].data.score = 30;
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '130', 'same-version score events remain visible');
    h.record.data.groupScore = 130;
    h.record.data.participantScores = AstervoidsWireCodec.packCounterMap({ [participantA]: 130, [participantB]: 0 });
    h.record.data.processedScores = AstervoidsWireCodec.packCounterMap({ [shipA]: 30 });
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '130', 'authoritative credit replaces the projection');
    h.game.mode = 'solo';
    h.game.score = 42;
    h.updateHUD();
    assert.equal(h.scoreDisplay.textContent, 'Score: 42');
    assert.equal(h.hudDisplay.classList.contains('multiplayer'), false);
});

test('HUD player names use participant tags, not rank or the current ship', () => {
    const h = scoreUiHarness({ participantId: participantA.toUpperCase() });
    h.updateHUD();
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot1');
    h.record.data.groupScore = 300;
    h.record.data.participantScores = AstervoidsWireCodec.packCounterMap({
        [participantA]: 0, [participantB]: 300,
    });
    h.ships.push(ship(shipA, participantA, 0));
    h.game.ship = { syncObjectId: shipA, score: 0 };
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '0');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot1');
    assert.equal(h.playerIndicatorDisplay.textContent.includes(participantA), false);
});

test('HUD waits for a valid participant tag instead of inventing one for a new ship', () => {
    const h = scoreUiHarness({
        data: {
            groupScore: 0,
            participantScores: AstervoidsWireCodec.packCounterMap({}),
            participantNumbers: AstervoidsWireCodec.packCounterMap({}),
        },
        ships: [ship(shipA, participantA, 0)],
    });
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '0');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Unknown');
    h.record.data.participantScores = AstervoidsWireCodec.packCounterMap({ [participantA]: 0 });
    h.record.data.participantNumbers = AstervoidsWireCodec.packCounterMap({ [participantA]: 7 });
    h.record.data.participantTags = tagsForParticipants([participantA]);
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '0');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot1');
});

test('HUD refreshes player and session names independently of score and across session transitions', () => {
    const h = scoreUiHarness({ data: {
        groupScore: 20,
        participantScores: AstervoidsWireCodec.packCounterMap({ [participantA]: 10, [participantB]: 10 }),
        participantNumbers: AstervoidsWireCodec.packCounterMap({ [participantA]: 4, [participantB]: 2 }),
    } });
    h.updateHUD();
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot1');
    h.identity.participantId = participantB;
    h.game.sessionInfo.name = 'Another session name';
    h.updateHUD();
    assert.equal(h.yourScoreDisplay.textContent, '10');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Pilot2');
    assert.equal(h.sessionIndicator.textContent, 'Another session name');
    h.game.mode = 'solo';
    h.updateHUD();
    assert.equal(h.sessionIndicator.style.display, 'none');
    h.identity.epoch++;
    h.game.mode = 'session';
    h.game.sessionInfo.name = 'New session';
    h.record.data.participantNumbers = AstervoidsWireCodec.packCounterMap({ [participantA]: 1, [participantB]: 3 });
    h.record.data.participantTags = AstervoidsWireCodec.packTagMap({ [participantA]: 'Pilot1', [participantB]: 'Nova2' });
    h.updateHUD();
    assert.equal(h.playerIndicatorDisplay.textContent, 'Nova2');
    assert.equal(h.sessionIndicator.textContent, 'New session');
    assert.equal(h.sessionIndicator.style.display, '');
});

test('final rows use persisted historical scores, never unprocessed local projections or live membership', () => {
    const h = scoreUiHarness({
        data: {
            groupScore: 100, participantScores: AstervoidsWireCodec.packCounterMap({
                [participantA]: 100, [participantB]: 0, [participantC]: 0,
            }),
            participantNumbers: AstervoidsWireCodec.packCounterMap({
                [participantA]: 8, [participantB]: 4, [participantC]: 2,
            }),
        },
        ships: [ship(shipA, participantA, 999)],
    });
    h.game.ship = { syncObjectId: shipA, score: 999 };
    h.updateGameplayOverlays();
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: 100');
    assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 100');
    assert.deepEqual(standingsRows(h.gameoverResultsEl), [
        ['1', 'Pilot1', '100'], ['2', 'Pilot3', '0'], ['3', 'Pilot2', '0'],
    ]);
    assert.equal(h.gameoverResultsEl.textContent.includes(participantA), false);
    assert.equal(h.gameoverResultsEl.textContent.includes('999'), false);
    const writes = h.writes.length;
    const decoded = h.counts.unpack;
    for (let frame = 0; frame < 120; frame++) h.updateGameplayOverlays();
    assert.equal(h.writes.length, writes);
    assert.equal(h.counts.unpack, decoded);
    h.record.data.groupScore = 130;
    h.record.data.participantScores = AstervoidsWireCodec.packCounterMap({
        [participantA]: 100, [participantB]: 30, [participantC]: 0,
    });
    h.updateGameplayOverlays();
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: 100');
    assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 130');
    assert.deepEqual(standingsRows(h.gameoverResultsEl), [
        ['1', 'Pilot1', '100'], ['2', 'Pilot2', '30'], ['3', 'Pilot3', '0'],
    ]);
    h.record.data.groupScore = 167;
    h.record.data.participantScores = AstervoidsWireCodec.packCounterMap({
        [participantA]: 137, [participantB]: 30, [participantC]: 0,
    });
    h.updateGameplayOverlays();
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: 137',
        'accepted late points update the personal summary, not an unprocessed ship projection');
    assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 167');
});

test('game-over personal totals belong to the viewer even when their row is outside the ranked limit', () => {
    const data = {
        groupScore: 900,
        participantScores: AstervoidsWireCodec.packCounterMap({
            [participantA]: 0, [participantB]: 500, [participantC]: 400,
        }),
        participantNumbers: AstervoidsWireCodec.packCounterMap({
            [participantA]: 3, [participantB]: 1, [participantC]: 2,
        }),
    };
    for (const [participantId, score] of [
        [participantA.toUpperCase(), 0], [participantB, 500], [participantC, 400],
    ]) {
        const h = scoreUiHarness({ data, participantId, maxMembers: 1 });
        h.updateHUD();
        assert.equal(h.playerIndicatorDisplay.textContent, tagForParticipant(participantId));
        h.updateGameplayOverlays();
        assert.equal(h.gameoverPersonalScoreEl.textContent, `Your Score: ${score}`);
        assert.equal(h.gameoverPersonalScoreEl.attributes['aria-label'], `Your Score ${score}`);
        assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 900');
        assert.deepEqual(standingsRows(h.gameoverResultsEl), [['1', 'Pilot2', '500']]);
    }
});

test('missing capacity keeps the full team total visible and defers rows until the advertised cap arrives', () => {
    const scores = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [id(index + 1), index * 100]));
    const numbers = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [id(index + 1), index + 1]));
    const h = scoreUiHarness({
        maxMembers: null,
        data: { groupScore: 4500, participantScores: AstervoidsWireCodec.packCounterMap(scores),
            participantNumbers: AstervoidsWireCodec.packCounterMap(numbers) },
    });
    h.updateGameplayOverlays();
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: 0');
    assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 4500');
    assert.match(h.gameoverResultsEl.textContent, /session capacity unknown/);
    assert.deepEqual(standingsRows(h.gameoverResultsEl), []);
    for (const [maxMembers, rows] of [[3, 4], [5, 7]]) {
        h.game.sessionInfo.maxMembers = maxMembers;
        h.updateGameplayOverlays();
        assert.equal(standingsRows(h.gameoverResultsEl).length, rows);
        assert.deepEqual(standingsRows(h.gameoverResultsEl)[0], ['1', 'Pilot10', '900']);
    }
});

test('missing and malformed score histories are visibly unavailable, not fabricated zeros, and can recover', () => {
    {
        const h = scoreUiHarness({ data: { groupScore: 987654 } });
        h.updateHUD();
        h.updateGameplayOverlays();
        assert.equal(h.yourScoreDisplay.textContent, 'unavailable');
        assert.equal(h.playerIndicatorDisplay.textContent, 'Unknown');
        assert.equal(h.teamScoreDisplay.textContent, '987654');
        assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: unavailable');
        assert.equal(h.gameoverScoreEl.textContent, 'Team Score: 987654');
        assert.match(h.gameoverResultsEl.textContent, /unavailable for this session/);
        assert.deepEqual(standingsRows(h.gameoverResultsEl), []);
    }
    const h = scoreUiHarness({ data: {
        groupScore: 200, participantScores: { [participantA]: -1 },
        participantNumbers: AstervoidsWireCodec.packCounterMap({ [participantA]: 1 }),
    } });
    h.updateHUD();
    h.updateGameplayOverlays();
    h.updateHUD();
    assert.equal(h.errors.length, 1, 'report a malformed version once');
    assert.equal(h.teamScoreDisplay.textContent, '200');
    assert.equal(h.yourScoreDisplay.textContent, 'unavailable');
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: unavailable');
    h.record.data.participantScores = AstervoidsWireCodec.packCounterMap({ [participantA]: 200 });
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.yourScoreDisplay.textContent, '200');
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: 200');
    assert.deepEqual(standingsRows(h.gameoverResultsEl), [['1', 'Pilot1', '200']]);
});

test('inconsistent history is unavailable instead of presenting a live-player subtotal', () => {
    const h = scoreUiHarness({ data: {
        groupScore: 200,
        participantScores: AstervoidsWireCodec.packCounterMap({ [participantA]: 50 }),
        participantNumbers: AstervoidsWireCodec.packCounterMap({ [participantA]: 1 }),
    } });
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.teamScoreDisplay.textContent, '200');
    assert.equal(h.yourScoreDisplay.textContent, 'unavailable');
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: unavailable');
    assert.deepEqual(standingsRows(h.gameoverResultsEl), []);
    assert.equal(AstervoidsWireCodec.unpackCounterMap(h.record.data.participantScores)[participantA], 50,
        'never fabricate the missing historic attribution');
    const decoded = h.counts.unpack;
    for (let frame = 0; frame < 120; frame++) h.updateHUD();
    assert.equal(h.counts.unpack, decoded, 'unchanged partial histories retain their decode cache');
    assert.equal(h.errors.length, 1);
});

test('pure spectators are absent from histories, and solo Final Score hides personal results', () => {
    const h = scoreUiHarness({ data: {
        groupScore: 10, participantScores: AstervoidsWireCodec.packCounterMap({ [participantB]: 10 }),
        participantNumbers: AstervoidsWireCodec.packCounterMap({ [participantB]: 1 }),
    } });
    h.updateHUD();
    h.updateGameplayOverlays();
    assert.equal(h.yourScoreDisplay.textContent, '--');
    assert.equal(h.playerIndicatorDisplay.textContent, 'Unknown', 'unnamed spectators are not assigned a tag');
    assert.equal(h.gameoverPersonalScoreEl.textContent, 'Your Score: --');
    assert.equal(h.gameoverPersonalScoreEl.attributes['aria-label'], 'No personal score: spectating');
    assert.deepEqual(standingsRows(h.gameoverResultsEl), [['1', 'Pilot2', '10']]);
    assert.equal(h.yourScoreDisplay.attributes['aria-label'], 'No personal score: spectating');
    assert.equal(Object.values(h.yourScoreDisplay.attributes).some(value => value.includes(participantA)), false);
    h.game.mode = 'solo';
    h.game.score = 50;
    h.updateGameplayOverlays();
    assert.equal(h.gameoverScoreEl.textContent, 'Final Score: 50');
    assert.equal(h.gameoverPersonalScoreEl.hidden, true);
    assert.equal(h.gameoverResultsEl.hidden, true);
});

test('HUD layout and scroll exceptions stay localized to the score column and visible final results', () => {
    const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
    assert.match(source, /class="score-label">Your Score:<\/span>[\s\S]*id="player-indicator"[\s\S]*class="score-label">Team Score:<\/span>[\s\S]*id="session-indicator"/);
    assert.equal((source.match(/class="score-field-separator" aria-hidden="true">:<\/span>/g) || []).length, 2);
    assert.match(source, /id="gameover-personal-score"[\s\S]*id="gameover-score"/);
    assert.match(source, /#player-indicator,[\s\S]*#session-indicator \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    assert.match(source, /#hud\.multiplayer\.compact #multiplayer-scores \{[^}]*flex-basis: 100%;/);
    assert.match(source, /#hud\.multiplayer #wave,[\s\S]*#hud\.multiplayer #lives \{[^}]*flex-shrink: 0;/);
    assert.match(source, /#gameover-results \{[^}]*width: min\(420px, 90%\);/);
    assert.match(source, /#gameover-results \{[^}]*overflow-y: auto;[^}]*touch-action: pan-y;/);
    assert.match(source, /isPersonalScoreScrollTarget\(e\.target\)[\s\S]*'PageUp', 'PageDown', 'Home', 'End'/);
    const h = scoreUiHarness();
    const row = { closest: selector => selector === '#gameover-results' ? h.gameoverResultsEl : null };
    assert.equal(h.isPersonalScoreScrollTarget(row), false);
    h.updateGameplayOverlays();
    assert.equal(h.isPersonalScoreScrollTarget(row), true);
    assert.equal(h.isPersonalScoreScrollTarget({ closest: () => null }), false);
    h.gameoverResultsEl.hidden = true;
    assert.equal(h.isPersonalScoreScrollTarget(row), false);
});

function scoreLayoutHarness(width, height, aspectRatio, sessionMode = true) {
    const container = { clientWidth: width, clientHeight: height, style: { setProperty() {} } };
    const view = { style: {} };
    const hud = { style: {} };
    const wave = { id: 'wave-overlay', style: {} };
    const over = { id: 'gameover-overlay', style: {} };
    const canvas = { width: 0, height: 0 };
    const metadata = Object.freeze({ aspectRatio });
    const game = { sessionInfo: { metadata }, viewport: {} };
    const { resizeCanvas } = loadInlineGameFunctions(['resizeCanvas'], {
        game, canvas, isSessionMode: () => sessionMode, fitSessionHud() {},
        getEffectiveAsteroidAspectScales: () => null,
        document: {
            getElementById: name => ({
                'game-container': container, 'game-view': view, hud,
            })[name],
            querySelectorAll: () => [wave, over],
        },
    });
    function box(element) {
        const x = parseFloat(view.style.left || 0);
        const y = parseFloat(view.style.top || 0);
        const left = x + parseFloat(element.style.left);
        const top = y + parseFloat(element.style.top);
        return {
            left, top,
            right: element === hud
                ? x + parseFloat(view.style.width || width) - parseFloat(hud.style.right)
                : left + parseFloat(element.style.width),
            bottom: top + parseFloat(element.style.height || 0),
        };
    }
    return { container, view, hud, wave, over, canvas, game, resizeCanvas, box };
}

test('production resize contains the complete HUD in the creator view without altering shared or solo geometry', () => {
    for (const [width, height, aspectRatio, sessionMode] of [
        [640, 360, 0.5, true], [960, 540, 0.45, true],
        [320, 568, 16 / 9, true], [240, 426, 16 / 9, true],
        [320, 2000, 0.16, true], [1280, 720, 16 / 9, true],
        [640, 360, null, false],
    ]) {
        const h = scoreLayoutHarness(width, height, aspectRatio, sessionMode);
        h.resizeCanvas(true);
        const vp = h.game.viewport;
        const expectedWidth = sessionMode ? Math.min(width, height * aspectRatio) : width;
        const expectedHeight = sessionMode ? Math.min(height, width / aspectRatio) : height;
        assert.deepEqual(vp, {
            x: (width - expectedWidth) / 2, y: (height - expectedHeight) / 2,
            width: expectedWidth, height: expectedHeight,
        }, 'layout must not rewrite the creator-established gameplay rectangle');
        assert.equal(h.canvas.width, width);
        assert.equal(h.canvas.height, height);
        assert.equal(h.game.sessionInfo.metadata.aspectRatio, aspectRatio);
        const hud = h.box(h.hud);
        assert.ok(hud.left >= vp.x, `HUD left ${hud.left} escapes creator view left ${vp.x}`);
        assert.ok(hud.right <= vp.x + vp.width,
            `HUD right ${hud.right} escapes creator view right ${vp.x + vp.width}`);
        assert.equal(hud.top, vp.y + Math.round(vp.height * 0.015));
        assert.ok(parseFloat(h.hud.style.fontSize) > 0);
        if (!sessionMode) {
            assert.equal(h.hud.style.left, '5px');
            assert.equal(h.hud.style.right, '5px');
            assert.equal(h.hud.style.fontSize, '13px', 'solo typography remains unchanged');
        }
    }
});

test('short and narrow final overlays use exactly the creator view, including after a peer resize', () => {
    for (const [width, height, aspectRatio, sessionMode] of [
        [320, 568, 8, true], [320, 800, 16 / 9, true],
        [960, 540, 0.45, true], [320, 568, null, false],
    ]) {
        const h = scoreLayoutHarness(width, height, aspectRatio, sessionMode);
        for (const [nextWidth, nextHeight] of [[width, height], [height, width]]) {
            h.container.clientWidth = nextWidth;
            h.container.clientHeight = nextHeight;
            h.resizeCanvas(true);
            const vp = h.game.viewport;
            const expected = {
                left: vp.x, top: vp.y, right: vp.x + vp.width, bottom: vp.y + vp.height,
            };
            assert.deepEqual(h.box(h.wave), expected, 'wave geometry remains the gameplay rectangle');
            assert.deepEqual(h.box(h.over), expected,
                'final standings cannot borrow browser height or horizontal letterboxing');
            assert.equal(h.game.sessionInfo.metadata.aspectRatio, aspectRatio);
            assert.equal(h.canvas.width, nextWidth);
            assert.equal(h.canvas.height, nextHeight);
        }
    }
});
