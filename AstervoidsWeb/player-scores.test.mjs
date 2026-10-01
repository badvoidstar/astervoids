import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { loadClassicModule } from './test-support/classic-module.mjs';
import { loadSessionClient, GuidUtils } from './test-support/session-client-harness.mjs';

const require = createRequire(import.meta.url);
const codec = require('./wwwroot/js/astervoids-wire-codec.js');
const { countExtraLivesForScore } = require('./wwwroot/js/game-config.js');
const id = number => `00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
const shipA = id(1);
const shipB = id(2);
const shipC = id(3);
const playerA = id(101);
const playerB = id(102);
const playerC = id(103);
const { calculateGameState, rankPlayerScores } = loadInlineGameFunctions(
    ['calculateGameState', 'rankPlayerScores'], { countExtraLivesForScore, GuidUtils });

function calculate({ persisted = {}, ships = [], departed = [], ledgers = {} } = {}) {
    return calculateGameState(persisted, {
        processedHits: persisted.processedHits ?? {},
        processedScores: persisted.processedScores ?? {},
        playerScores: persisted.playerScores ?? {},
        countedParticipants: persisted.countedParticipants ?? {},
        ...ledgers
    }, ships, { lives: 3, state: 'playing', observedScoreLifeAwardCount: null },
    10_000, departed);
}

function ship(objectId, participantId, score, hitCount = 0) {
    return { id: objectId, data: { type: 'ship', participantId, score, hitCount } };
}

test('personal totals and team score account for the same deltas without mutating input ledgers', () => {
    const playerScores = Object.freeze({ [playerA]: 50 });
    const processedScores = Object.freeze({ [shipA]: 50 });
    const persisted = Object.freeze({ groupScore: 50, playerScores, processedScores });
    const next = calculate({
        persisted,
        ships: [ship(shipA, playerA.toUpperCase(), 100), ship(shipB, playerB, 30),
            ship(shipC, playerC, 0)]
    });
    assert.equal(next.groupScore, 130);
    assert.deepEqual(next.playerScores, { [playerA]: 100, [playerB]: 30, [playerC]: 0 });
    assert.equal(Object.values(next.playerScores).reduce((sum, score) => sum + score, 0), next.groupScore);
    assert.notEqual(next.playerScores, playerScores);
    assert.deepEqual(playerScores, { [playerA]: 50 });
    assert.deepEqual(processedScores, { [shipA]: 50 });
    const repeated = calculate({ persisted: next,
        ships: [ship(shipA, playerA, 100), ship(shipB, playerB, 30), ship(shipC, playerC, 0)] });
    assert.deepEqual(repeated.playerScores, next.playerScores);
    assert.equal(repeated.groupScore, next.groupScore);
});

test('departed players keep their totals and a fresh rejoin ship contributes to the same player', () => {
    const original = calculate({
        ships: [ship(shipA, playerA, 100), ship(shipB, playerB, 50)]
    });
    const departed = calculate({ persisted: original, ships: [ship(shipA, playerA, 100)] });
    assert.deepEqual(departed.playerScores, original.playerScores);
    assert.equal(departed.groupScore, 150);
    const rejoined = calculate({ persisted: departed,
        ships: [ship(shipA, playerA, 100), ship(shipC, playerB, 70)] });
    assert.deepEqual(rejoined.playerScores, { [playerA]: 100, [playerB]: 120 });
    assert.equal(rejoined.groupScore, 220);
    const migrated = calculate({ persisted: rejoined,
        ships: [ship(shipC, playerB, 70), ship(shipA, playerA, 90)] });
    assert.deepEqual(migrated.playerScores, rejoined.playerScores);
    assert.equal(migrated.groupScore, 220, 'stale ship counters never subtract or re-award points');
});

test('departure between game steps retains final scores without applying departed damage or life bonuses', () => {
    const ships = [ship(shipA, playerA, 20)];
    const departed = [ship(shipB, playerB, 65, 999), ship(shipC, playerC, 0, 999)];
    const next = calculate({
        persisted: { lives: 3, peakShipCount: 1, countedParticipants: { [playerA]: 1 } },
        ships, departed
    });
    assert.equal(next.groupScore, 85);
    assert.deepEqual(next.playerScores, { [playerA]: 20, [playerB]: 65, [playerC]: 0 });
    assert.equal(next.lives, 3);
    assert.deepEqual(next.processedHits, {});
    assert.deepEqual(next.countedParticipants, { [playerA]: 1 });
    const migrated = calculate({ persisted: next, ships, departed });
    assert.equal(migrated.groupScore, 85);
    assert.deepEqual(migrated.playerScores, next.playerScores);
});

test('a zero-point player is retained even if their first observed hit ends the game', () => {
    const next = calculate({ persisted: { lives: 1 }, ships: [ship(shipA, playerA, 0, 1)] });
    assert.equal(next.lives, 0);
    assert.deepEqual(next.playerScores, { [playerA]: 0 });
    assert.deepEqual(next.countedParticipants, {}, 'scoring does not change terminal entry-life rules');
});

test('an invalid participant identity cannot reach the GUID-keyed personal ledger', () => {
    const next = calculate({ ships: [ship(shipA, 'not-a-guid', 50)] });
    assert.equal(next.groupScore, 50, 'preserve the existing team-score behavior');
    assert.deepEqual(next.playerScores, {});
    assert.deepEqual(codec.unpackCounterMap(codec.packCounterMap(next.playerScores)), {});
});

test('ranking keeps the highest scores, including departed players, with deterministic labels and ties', () => {
    const scores = Object.fromEntries([0, 400, 200, 200, 30, 10, 1000]
        .map((score, index) => [id(101 + index), score]));
    const ranked = rankPlayerScores(scores, 4);
    assert.equal(ranked.length, 6);
    assert.deepEqual(ranked.map(entry => entry.score), [1000, 400, 200, 200, 30, 10]);
    assert.equal(ranked[0].label, 'Player 7', 'placeholder labels are independent of score rank');
    assert.deepEqual(ranked.slice(2, 4).map(entry => entry.participantId), [id(103), id(104)]);
    assert.deepEqual(rankPlayerScores(Object.fromEntries(Object.entries(scores).reverse()), 4), ranked);
    assert.equal(Object.keys(scores).length, 7, 'the presentation cap does not discard personal totals');
    assert.equal(rankPlayerScores(scores, 3).length, 4, 'an odd member limit rounds down');
    assert.equal(rankPlayerScores(scores, 1).length, 1);
    assert.equal(rankPlayerScores(scores, 8).length, 7, 'small rosters are not padded');
    assert.deepEqual(rankPlayerScores({ [playerA]: 0, [playerB]: 0 }, 4)
        .map(entry => entry.score), [0, 0], 'zero scores are eligible');
});

function element() {
    const writes = [];
    let text = '';
    let display = '';
    return {
        writes,
        classList: { toggle: (...args) => writes.push(['class', ...args]) },
        get textContent() { return text; },
        set textContent(value) { text = value; writes.push(['text', value]); },
        style: {
            get display() { return display; },
            set display(value) { display = value; writes.push(['display', value]); }
        }
    };
}

function displayHarness() {
    const state = {
        epoch: 1, maxMembers: 4, inSession: true, errors: [], unpacks: 0,
        record: {
            id: 'gs', version: 1,
            data: {
                playerScores: codec.packCounterMap({ [playerA]: 100, [playerB]: 200 }),
                processedScores: codec.packCounterMap({ [shipA]: 50 })
            }
        },
        game: {
            mode: 'session', state: 'playing', score: 300, wave: 1, lives: 3,
            ship: { participantId: playerA, score: 50 },
            multiplayer: { myShipObjectId: shipA, departedScoreShips: new Map() }
        }
    };
    const elements = Object.fromEntries([
        'hudDisplay', 'scoreDisplay', 'personalScoreDisplay', 'waveDisplay', 'livesDisplay',
        'waveOverlay', 'waveTextEl', 'gameoverOverlay', 'gameoverScoreEl',
        'gameoverPlayersEl', 'gameoverPromptEl'
    ].map(name => [name, element()]));
    const functions = loadInlineGameFunctions([
        'updateHUD', 'updateGameplayOverlays', 'readSessionScoreSnapshot', 'getPersonalScore',
        'rankPlayerScores', 'readGameStateLedger', 'gameStateLedgerMatches',
        'gameStateCounterMapsEqual', 'rememberDepartedShipScore'
    ], {
        ...elements, game: state.game, sessionScoreCache: null, hudCache: {}, overlayCache: {},
        OBJECT_TYPES: { GAME_STATE: 'gameState', SHIP: 'ship' },
        ObjectSync: { getObjectByType: () => state.record },
        SessionClient: {
            getSessionEpoch: () => state.epoch,
            getCurrentSession: () => state.inSession
                ? { maxMembers: state.maxMembers, members: [{}] } : null
        },
        AstervoidsWireCodec: { ...codec, unpackCounterMap: value => {
            state.unpacks++;
            return codec.unpackCounterMap(value);
        } },
        isSessionMode: () => state.game.mode === 'session',
        isGameOver: () => state.game.state === 'gameover',
        isLobbySpectating: () => !state.game.ship,
        document: { getElementById: () => null },
        _error: (...args) => state.errors.push(args)
    });
    return { ...functions, state, elements,
        countWrites: () => Object.values(elements).reduce((sum, el) => sum + el.writes.length, 0) };
}

test('session HUD shows personal above team totals and acknowledges local awards exactly once', () => {
    const h = displayHarness();
    h.updateHUD();
    assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: 100');
    assert.equal(h.elements.scoreDisplay.textContent, 'team score: 300');
    h.state.game.ship.score += 25;
    h.updateHUD();
    assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: 125');
    h.state.record.data.playerScores = codec.packCounterMap({ [playerA]: 125, [playerB]: 200 });
    h.state.record.data.processedScores = codec.packCounterMap({ [shipA]: 75 });
    h.state.game.score = 325;
    h.updateHUD();
    assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: 125');
    assert.equal(h.elements.scoreDisplay.textContent, 'team score: 325');
    const writes = h.countWrites();
    const unpacks = h.state.unpacks;
    for (let i = 0; i < 120; i++) h.updateHUD();
    assert.equal(h.countWrites(), writes);
    assert.equal(h.state.unpacks, unpacks);
});

test('HUD mode changes preserve solo text and spectators do not show a fictitious personal score', () => {
    const h = displayHarness();
    h.updateHUD();
    h.state.game.ship = null;
    h.updateHUD();
    assert.equal(h.elements.personalScoreDisplay.style.display, 'none');
    assert.equal(h.elements.scoreDisplay.textContent, 'team score: 300');
    h.state.game.mode = 'solo';
    h.updateHUD();
    assert.equal(h.elements.scoreDisplay.textContent, 'Score: 300');
    assert.deepEqual(h.elements.hudDisplay.writes.filter(write => write[0] === 'class'),
        [['class', 'session-scoreboard', true], ['class', 'session-scoreboard', false]]);
});

test('a fresh rejoin ship shows the persisted personal total, not a reset ship score', () => {
    const h = displayHarness();
    h.state.game.multiplayer.myShipObjectId = shipC;
    h.state.game.ship.score = 0;
    h.updateHUD();
    assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: 100');
    h.state.game.ship.score = 10;
    h.updateHUD();
    assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: 110');
});

test('game-over results use the shared ledger, configured capacity and fixed ties, not local predictions', () => {
    const h = displayHarness();
    h.state.record.data.playerScores = codec.packCounterMap(Object.fromEntries(
        [0, 400, 200, 200, 30, 10, 1000].map((score, index) => [id(101 + index), score])));
    h.state.game.score = 1840;
    h.state.game.ship.score = 999_999;
    h.state.game.state = 'gameover';
    h.updateGameplayOverlays();
    assert.equal(h.elements.gameoverScoreEl.textContent, 'team score: 1840');
    assert.equal(h.elements.gameoverPlayersEl.textContent,
        '1. Player 7: 1000\n2. Player 2: 400\n3. Player 3: 200\n4. Player 4: 200\n5. Player 5: 30\n6. Player 6: 10');
    const writes = h.countWrites();
    for (let i = 0; i < 120; i++) h.updateGameplayOverlays();
    assert.equal(h.countWrites(), writes);
    h.state.game.ship = null;
    h.updateGameplayOverlays();
    assert.equal(h.elements.gameoverPlayersEl.textContent.split('\n').length, 6,
        'a spectator sees the same ranked results');
    assert.equal(h.elements.gameoverPromptEl.style.display, 'none');
});

test('score reads invalidate on same-version byte edits, equivalent views, recovery and session changes', () => {
    const h = displayHarness();
    const original = h.readSessionScoreSnapshot().players;
    h.state.record.data.playerScores = new Uint8Array(h.state.record.data.playerScores);
    assert.equal(h.readSessionScoreSnapshot().players, original);
    assert.equal(h.state.unpacks, 2);
    h.state.record.data.playerScores[16] = 125;
    const edited = h.readSessionScoreSnapshot().players;
    assert.notEqual(edited, original);
    assert.equal(edited.counters[playerA], 125);
    h.state.record.data = {
        playerScores: codec.packCounterMap({ [playerA]: 5 }),
        processedScores: codec.packCounterMap({})
    };
    assert.deepEqual(h.readSessionScoreSnapshot().players.counters, { [playerA]: 5 });
    h.state.epoch++;
    assert.notEqual(h.readSessionScoreSnapshot().players, edited);
    h.state.record = null;
    assert.equal(h.readSessionScoreSnapshot(), null);
});

test('malformed scores or missing capacity are reported once and do not display success-shaped zeroes', () => {
    for (const corrupt of [
        h => { h.state.record.data.playerScores = new Uint8Array([1]); },
        h => { h.state.record.data.processedScores = new Uint8Array([1]); },
        h => { delete h.state.record.data.playerScores; },
        h => { h.state.maxMembers = undefined; }
    ]) {
        const h = displayHarness();
        corrupt(h);
        h.updateHUD();
        h.state.game.state = 'gameover';
        h.updateGameplayOverlays();
        h.updateHUD();
        assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: unavailable');
        assert.equal(h.elements.gameoverPlayersEl.textContent, 'Player scores unavailable');
        assert.equal(h.state.errors.length, 1);
        h.state.record.version++;
        h.updateHUD();
        assert.equal(h.state.errors.length, 2);
        h.state.maxMembers = 4;
        h.state.record.data = {
            playerScores: codec.packCounterMap({ [playerA]: 100 }),
            processedScores: codec.packCounterMap({ [shipA]: 50 })
        };
        h.updateHUD();
        assert.equal(h.elements.personalScoreDisplay.textContent, 'your score: 100');
    }
});

test('leaving or reconnecting cannot reuse old score records outside active membership', () => {
    const h = displayHarness();
    h.readSessionScoreSnapshot();
    h.state.inSession = false;
    assert.equal(h.readSessionScoreSnapshot(), null);
    assert.equal(h.state.errors.length, 0, 'an ordinary membership transition is not a malformed session');
    h.state.inSession = true;
    h.state.record.data.playerScores = codec.packCounterMap({ [playerA]: 5 });
    assert.deepEqual(h.readSessionScoreSnapshot().players.counters, { [playerA]: 5 });
});

test('real ObjectSync departure callbacks retain detached final score counters for the next owner', () => {
    const h = displayHarness();
    const handlers = {};
    const objectSync = loadClassicModule('object-sync.js', 'ObjectSync', {
        AuthoritativeObject: require('./wwwroot/js/authoritative-object.js'),
        SessionClient: {
            on: (name, callback) => { handlers[name] = callback; },
            getSessionEpoch: () => 1,
            getCurrentMember: () => ({ id: 'me' }),
            isInSession: () => true
        },
        window: { ASTERVOIDS_DEBUG: false }
    });
    objectSync.init();
    objectSync.on('onObjectDeleted', h.rememberDepartedShipScore);
    handlers.onSessionJoined({ objects: [{
        ...ship(shipB, playerB, 65), version: 1, ownerMemberId: 'other', scope: 'Member'
    }] });
    const original = objectSync.getObject(shipB);
    objectSync.handleMemberDeparture([shipB]);
    assert.equal(objectSync.getObject(shipB), undefined);
    original.data.score = 999;
    const departed = [...h.state.game.multiplayer.departedScoreShips.values()];
    assert.deepEqual(departed, [{ id: shipB, data: { participantId: playerB, score: 65 } }]);
    assert.equal(calculate({ departed }).groupScore, 65);
    h.rememberDepartedShipScore({ id: shipC, data: { type: 'asteroid', score: 10 } });
    assert.equal(h.state.game.multiplayer.departedScoreShips.size, 1);
});

test('local ship deletion captures scores before the local-first transport removes its record', async () => {
    const h = displayHarness();
    const record = ship(shipA, playerA, 65);
    const { deleteSyncedShip } = loadInlineGameFunctions(['deleteSyncedShip'], {
        game: h.state.game,
        ObjectSync: { getObject: objectId => {
            assert.equal(objectId, shipA);
            return record;
        } },
        rememberDepartedShipScore: h.rememberDepartedShipScore,
        deleteSyncedObject: async () => {
            assert.equal(h.state.game.multiplayer.departedScoreShips.get(shipA).data.score, 65);
        }
    });
    await deleteSyncedShip();
    assert.equal(h.state.game.ship, null);
    assert.equal(h.state.game.multiplayer.myShipObjectId, null);
    assert.equal(calculate({ departed: [...h.state.game.multiplayer.departedScoreShips.values()] }).groupScore, 65);
});

test('session capacity is preserved on create, plain join and authenticated rejoin', async () => {
    const sessionId = id(999);
    let serial = 200;
    const { client, calls } = await loadSessionClient({
        reply: method => {
            if (method === 'LeaveSession') return true;
            const memberId = GuidUtils.guidToBytes(id(++serial));
            return {
                sessionId: GuidUtils.guidToBytes(sessionId), sessionName: 'fruit',
                memberId, role: 1, reconnectToken: 'test-token',
                maxMembers: 3, members: [{ id: memberId, role: 1 }],
                objects: [], validAts: [], metadata: {}
            };
        }
    });
    assert.equal((await client.createSession()).session.maxMembers, 3);
    client.clearSessionState();
    assert.equal((await client.joinSession(sessionId)).session.maxMembers, 3);
    assert.ok(calls.some(call => call.method === 'RejoinSession'));
    await client.leaveSession();
    assert.equal((await client.joinSession(sessionId)).session.maxMembers, 3);
    assert.ok(calls.some(call => call.method === 'JoinSession'));
    assert.equal(client.getCurrentSession().maxMembers, 3);
});
