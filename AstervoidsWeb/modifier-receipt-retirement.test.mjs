import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadInlineGameConstants, loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { attachGameplaySync } from './test-support/gameplay-sync.mjs';

const require = createRequire(import.meta.url);
const Wire = require('./wwwroot/js/astervoids-wire-codec.js');
const Config = require('./wwwroot/js/game-config.js');
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const constants = loadInlineGameConstants([
    'PROGRESSION', 'PAYLOAD_KIND', 'MODIFIER_KIND', 'GAME_EFFECT_KIND', 'OBJECT_TYPES',
    'TURN_CONTROL_MODE', 'CONFIG',
], { SHARED_CONFIG_DEFAULTS: Config.SHARED_DEFAULTS });
const { PAYLOAD_KIND, MODIFIER_KIND, GAME_EFFECT_KIND, OBJECT_TYPES } = constants;
const id = number => `${number.toString(16).padStart(8, '0')}-1111-2222-3333-aabbccddeeff`;
const participantId = id(1), memberId = id(11), otherMemberId = id(12);
const shipId = id(21), stateId = id(31), receiptId = id(41), targetId = id(51);
const turn = () => new Promise(resolve => setImmediate(resolve));
const rewardFields = ['processedEffects', 'participantXp', 'participantScores', 'groupScore', 'lives'];
const select = (data, keys) => Object.fromEntries(keys.map(key => [key, data[key]]));
const cases = [
    { name: 'break', kind: GAME_EFFECT_KIND.BREAK_RECEIPT, payload: PAYLOAD_KIND.NONE },
    { name: 'extra-life activation', payload: PAYLOAD_KIND.EXTRA_LIFE },
    { name: 'level-up activation', payload: PAYLOAD_KIND.LEVELUP },
    { name: 'shield activation', payload: PAYLOAD_KIND.SHIELD },
    { name: 'rapid-fire activation', payload: PAYLOAD_KIND.RAPID_FIRE },
    { name: 'nuke activation', payload: PAYLOAD_KIND.NUKE },
    { name: 'smart-bomb activation', payload: PAYLOAD_KIND.SMART_BOMB },
];

function harness(scenario = cases[0], { blastTarget = false } = {}) {
    const game = {
        mode: 'session', state: 'playing', score: 90, lives: 3, wave: 1,
        speedMultiplier: 1, waveDelayTimer: 0, astervoids: [], effects: [],
        multiplayer: {
            myShipObjectId: shipId, gameStateObjectId: stateId, observedScoreLifeAwardCount: 0,
            contactClaims: new Map(), effectMutations: new Set(), effectAnchors: new Map(),
        },
    };
    const clock = { server: 1000 };
    const sessionClient = {
        getCurrentMember: () => ({ id: memberId }),
        getCurrentSession: () => ({ id: id(30), members: [{ id: memberId }, { id: otherMemberId }] }),
        getParticipantId: () => participantId,
        getSessionEpoch: () => 1,
    };
    const objectSync = {};
    const production = loadInlineGameFunctions([
        'ShipInvulnerability', 'Ship', 'isGameStateOwner', 'syncLocalShipBoosts',
        'getLevelXpThreshold', 'getLevelForXp', 'getProgressionForXp',
        'getSessionModifierLedger', 'getLocalModifier',
        'getGameEffectNow', 'getGameEffectObjects', 'createGameEffectData',
        'getGameEffectTiming', 'anchorGameEffectData', 'getGameEffectTimerData',
        'isGameEffectReady', 'ensureOwnedGameEffectAnchor', 'getProcessedGameEffects',
        'isTimedBoostPayload', 'applyBoostReceipt', 'isBoostReceiptHandled',
        'applyHazardReceipt', 'isHazardReceiptHandled', 'isHostileGameEffect',
        'applyOwnedBlastCommand', 'isBlastCommandComplete', 'replaceGameEffect',
        'cleanupGameContactClaims', 'updateGameEffects',
        'getParticipatingParticipantIds', 'awardBreakXp', 'calculateGameState',
        'calculateGameStateTerminal', 'applyCalculatedGameState', 'serializeGameState',
        'resetGameStateSyncCache', 'reportMalformedGameStateLedgers',
        'gameStateCounterMapsEqual', 'gameStateLedgerMatches', 'normalizeParticipantLedger',
        'readGameStateLedger', 'readParticipantScoreHistory', 'packGameStateLedger',
        'gameStateCalculationInputs', 'gameStateInputsEqual', 'syncGameState',
    ], {
        ...constants, CONFIG: { ...constants.CONFIG, EXTRA_LIFE_SCORE_THRESHOLD: 100 },
        game, GuidUtils, AstervoidsWireCodec: Wire, crypto: { randomUUID },
        SessionClient: sessionClient, ObjectSync: objectSync,
        RemoteObjects: { isClockOffsetInitialized: () => true, serverNowMs: () => clock.server },
        isSessionMode: () => true, isDeterministicMode: () => true,
        isGameOver: () => game.lives <= 0 || game.state === 'gameover',
        countExtraLivesForScore: Config.countExtraLivesForScore,
        gameStateSyncCache: null, malformedGameStateLedgerKey: null, sessionModifierViewCache: null,
        AudioSystem: { beat: { stop() {} } }, announceExtraLifeAward() {},
        _error: () => assert.fail('Unexpected production error'),
        _warn: () => assert.fail('Unexpected production warning'),
    });
    game.ship = new production.Ship(0.4, 0.5);
    Object.assign(game.ship, {
        syncObjectId: shipId, memberId, participantId, participantTag: 'Pilot_1',
    });
    const h = { ...production, game, clock, sessionClient, objectSync };
    const network = attachGameplaySync(h, memberId);
    const broken = scenario.kind === GAME_EFFECT_KIND.BREAK_RECEIPT;
    const initialXp = broken || scenario.payload === PAYLOAD_KIND.LEVELUP ? 110 : 120;
    const data = production.anchorGameEffectData(production.createGameEffectData(
        scenario.kind ?? GAME_EFFECT_KIND.ACTIVATION_RECEIPT, scenario.payload, id(101), {
            participantId, participantTag: 'Pilot_1', shipId,
            shipLifeId: game.ship.boostState.lifeId, damageId: id(102),
        }, 0.4, 0.5), clock.server);
    data.points = broken ? 20 : 0;
    if (broken) data.contributors = Wire.packContributors({ [participantId]: 1 });
    if (blastTarget) data.asteroidTargets = Wire.packCounterMap({ [targetId]: 1 });
    const record = (objectId, schemaId, objectData, ownerMemberId = memberId) => ({
        id: objectId, schemaId, data: objectData, ownerMemberId, creatorMemberId: ownerMemberId,
        scope: schemaId === 1 ? 'Member' : 'Session', version: 1, validAt: clock.server,
    });
    network.seed([
        record(shipId, 1, game.ship.toSyncData()),
        record(stateId, 4, {
            type: OBJECT_TYPES.GAME_STATE, gameStarted: true, wave: 1, state: 'playing',
            lives: 3, groupScore: 90, speedMultiplier: 1, waveDelayTimer: 0,
            processedHits: Wire.packCounterMap({}), processedScores: Wire.packCounterMap({}),
            countedParticipants: Wire.packCounterMap({ [participantId]: 1 }), peakShipCount: 1,
            participantScores: Wire.packCounterMap({ [participantId]: 90 }),
            participantNumbers: Wire.packCounterMap({ [participantId]: 1 }),
            participantTags: Wire.packTagMap({ [participantId]: 'Pilot_1' }),
            participantXp: Wire.packXpMap({ [participantId]: initialXp }),
            processedEffects: Wire.packCounterMap({}), participantModifiers: Wire.packParticipantModifiers({}),
            scoreLifeAwardCount: 0, gameOverAt: null, terminalAt: null,
        }),
        record(receiptId, 5, data),
        ...(blastTarget ? [record(targetId, 2, {
            type: OBJECT_TYPES.ASTEROID, hitsRemaining: 2,
            processedDamage: Wire.packCounterMap({}), contributors: Wire.packContributors({}),
        }, otherMemberId)] : []),
    ]);
    return {
        ...h, network, receipt: data,
        expected: {
            xp: 120, score: broken ? 110 : 90,
            lives: broken || scenario.payload === PAYLOAD_KIND.EXTRA_LIFE ? 4 : 3,
        },
    };
}

function assertRewards(h, data = h.network.server.get(stateId).data) {
    assert.deepEqual(Wire.unpackXpMap(data.participantXp), { [participantId]: h.expected.xp });
    assert.deepEqual(Wire.unpackCounterMap(data.participantScores), { [participantId]: h.expected.score });
    assert.equal(data.groupScore, h.expected.score);
    assert.equal(data.lives, h.expected.lives);
}

async function confirmRewards(h) {
    h.syncGameState();
    await h.network.sync.flushUpdates();
    assertRewards(h);
    assert.deepEqual(Wire.unpackCounterMap(h.network.server.get(stateId).data.processedEffects),
        { [receiptId]: 1 });
    assert.equal(h.network.sync.isDataConfirmed(stateId,
        select(h.network.sync.getObject(stateId).data, rewardFields)), true);
}

async function confirmBoost(h) {
    if (!h.isTimedBoostPayload(h.receipt.payloadKind)) return;
    h.updateGameEffects(0);
    await turn();
    await h.network.sync.flushUpdates();
    assert.equal(h.network.sync.isDataConfirmed(shipId, h.game.ship.boostData()), true);
    const deadline = h.receipt.payloadKind === PAYLOAD_KIND.NUKE ? 2000 : 7000;
    const field = h.receipt.payloadKind === PAYLOAD_KIND.RAPID_FIRE ? 'rapidFireUntil' : 'shieldUntil';
    assert.equal(h.game.ship.boostState[field], deadline);
    assert.ok(h.network.server.has(receiptId), 'feedback has not elapsed while the boost is confirmed');
}

async function unconfirmedModifier(h, mode) {
    h.game.ship.modifierRequestMilestone = 4;
    h.game.ship.modifierRequestKind = MODIFIER_KIND.FOCUS;
    h.syncLocalShipBoosts();
    await h.network.sync.flushUpdates();
    assert.equal(h.network.sync.isDataConfirmed(shipId, {
        modifierRequestMilestone: 4, modifierRequestKind: MODIFIER_KIND.FOCUS,
    }), true);
    assert.equal(h.getLocalModifier(), MODIFIER_KIND.NONE, 'the accepted Ship request is not selection acceptance');

    const update = h.network.client.updateObjects;
    let release, sent;
    const gate = new Promise(resolve => { release = resolve; });
    h.network.transport.acknowledge = false;
    h.network.client.updateObjects = async updates => {
        sent = structuredClone(updates);
        if (mode === 'pending') await gate;
        return update(updates);
    };
    h.syncGameState();
    const writing = h.network.sync.flushUpdates();
    if (mode === 'rejected') await writing;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].objectId, stateId);
    assert.deepEqual(Object.keys(sent[0].data), ['participantModifiers'],
        'the controlled write changes only the unrelated optional selection');
    assert.equal(h.network.sync.isDataConfirmed(stateId,
        select(h.network.sync.getObject(stateId).data, rewardFields)), true);
    assert.equal(h.getLocalModifier(), MODIFIER_KIND.NONE, 'optimistic selection still cannot affect firing');
    return async () => { release(); await writing; };
}

for (const scenario of cases) for (const mode of ['pending', 'rejected']) {
    test(`${mode} modifier-only selection cannot pin an acknowledged ${scenario.name} receipt`, async t => {
        const h = harness(scenario);
        await confirmRewards(h);
        await confirmBoost(h);
        const settle = await unconfirmedModifier(h, mode);
        t.after(settle);
        h.clock.server = 2000;
        h.updateGameEffects(0);
        await turn();
        assert.equal(h.network.sync.getObject(receiptId), undefined,
            'production maintenance must retire the acknowledged receipt without a modifier ACK');
        assert.equal(h.network.server.has(receiptId), false);
        assert.equal(h.network.sync.isDataConfirmed(stateId, {
            participantModifiers: h.network.sync.getObject(stateId).data.participantModifiers,
        }), false);
        assert.equal(h.getLocalModifier(), MODIFIER_KIND.NONE);
        assertRewards(h);

        await settle();
        h.syncGameState();
        await h.network.sync.flushUpdates();
        assert.deepEqual(Wire.unpackCounterMap(h.network.sync.getObject(stateId).data.processedEffects), {});
        h.network.transport.acknowledge = true;
        h.syncGameState();
        await h.network.sync.flushUpdates();
        assert.deepEqual(Wire.unpackCounterMap(h.network.server.get(stateId).data.processedEffects), {});
        assert.equal(h.getLocalModifier(), MODIFIER_KIND.FOCUS);
        h.syncGameState();
        h.updateGameEffects(0);
        await h.network.sync.flushUpdates();
        assertRewards(h);
        assert.equal(h.game.score, h.expected.score);
        assert.equal(h.game.lives, h.expected.lives);
        assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
    });
}

for (const field of rewardFields) {
    test(`unconfirmed reward field ${field} still prevents production receipt retirement`, async () => {
        const h = harness();
        h.network.transport.acknowledge = false;
        h.syncGameState();
        await h.network.sync.flushUpdates();
        const publication = structuredClone(h.network.sync.getObject(stateId).data);
        const partial = { ...publication };
        delete partial[field];
        // Confirm every other field from the actual production reward publication.
        h.network.transport.acknowledge = true;
        h.network.sync.updateObject(stateId, partial);
        await h.network.sync.flushUpdates();
        assert.equal(h.network.sync.isDataConfirmed(stateId, partial), true);
        assert.equal(h.network.sync.isDataConfirmed(stateId, { [field]: publication[field] }), false);
        assertRewards(h, h.network.sync.getObject(stateId).data);
        h.updateGameEffects(0);
        await turn();
        assert.ok(h.network.sync.getObject(receiptId), 'a real unconfirmed reward must retain its receipt');
        assert.equal(h.network.server.has(receiptId), true);
        assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 0);

        h.network.sync.updateObject(stateId, { [field]: publication[field] });
        await h.network.sync.flushUpdates();
        h.updateGameEffects(0);
        await turn();
        assert.equal(h.network.server.has(receiptId), false, 'confirming that reward field releases retirement');
        h.syncGameState();
        await h.network.sync.flushUpdates();
        assert.deepEqual(Wire.unpackCounterMap(h.network.server.get(stateId).data.processedEffects), {});
        assertRewards(h);
    });
}

test('optimistic collecting-life changes cannot replace confirmed boost deadline or obsolete-life evidence', async () => {
    const h = harness(cases.find(scenario => scenario.payload === PAYLOAD_KIND.SHIELD));
    await confirmRewards(h);
    h.clock.server = 2000;
    h.network.transport.acknowledge = false;
    h.updateGameEffects(0);
    await turn();
    await h.network.sync.flushUpdates();
    assert.equal(h.game.ship.boostState.shieldUntil, 7000);
    assert.equal(h.network.sync.isDataConfirmed(shipId, h.game.ship.boostData()), false);
    assert.equal(h.network.server.has(receiptId), true);

    const collectingLife = h.game.ship.boostState.lifeId;
    h.game.ship.resetLife();
    assert.notEqual(h.game.ship.boostState.lifeId, collectingLife);
    h.syncLocalShipBoosts();
    await h.network.sync.flushUpdates();
    h.updateGameEffects(0);
    await turn();
    assert.equal(h.network.server.has(receiptId), true, 'an unconfirmed wrong life cannot discard the boost');
    assert.equal(h.game.ship.boostState.shieldUntil, 0, 'the old receipt never activates on the new life');

    h.network.transport.acknowledge = true;
    h.syncLocalShipBoosts();
    await h.network.sync.flushUpdates();
    h.updateGameEffects(0);
    await turn();
    assert.equal(h.network.server.has(receiptId), false, 'only the accepted new life makes the receipt obsolete');
    assert.equal(Wire.unpackBoostState(h.network.server.get(shipId).data.boostState).shieldUntil, 0);
    assertRewards(h);
});

test('a nuke still waits for blast targets after its exact one-second shield is confirmed', async () => {
    const h = harness(cases.find(scenario => scenario.payload === PAYLOAD_KIND.NUKE), { blastTarget: true });
    await confirmRewards(h);
    await confirmBoost(h);
    h.clock.server = 2000;
    h.updateGameEffects(0);
    await turn();
    assert.equal(h.network.server.has(receiptId), true);

    let rejectDelete;
    h.network.client.deleteObject = () => new Promise(resolve => { rejectDelete = resolve; });
    const deleting = h.network.sync.deleteObject(targetId);
    h.updateGameEffects(0);
    await turn();
    assert.equal(h.network.server.has(receiptId), true, 'pending local absence is not blast completion');
    rejectDelete({ success: false });
    assert.equal(await deleting, false);
    h.updateGameEffects(0);
    await turn();
    assert.equal(h.network.server.has(receiptId), true, 'a rejected target delete still pins the real command');

    h.network.server.delete(targetId);
    await h.network.sync.triggerReconciliation();
    h.updateGameEffects(0);
    await turn();
    assert.equal(h.network.server.has(receiptId), false);
    assert.equal(h.game.ship.boostState.shieldUntil, 2000);
    assertRewards(h);
});

test('metadata-only GameState migration still blocks retirement of an acknowledged receipt', async () => {
    const h = harness();
    await confirmRewards(h);
    h.network.sync.handleOwnershipMigration([{
        objectId: stateId, newOwnerId: otherMemberId,
        newVersion: h.network.sync.getObject(stateId).version + 1,
    }]);
    assert.equal(h.network.sync.getObject(stateId).ownershipMigrationPending, true);
    h.updateGameEffects(0);
    await turn();
    assert.ok(h.network.sync.getObject(receiptId));
    assert.equal(h.network.server.has(receiptId), true);
    assertRewards(h);
});
