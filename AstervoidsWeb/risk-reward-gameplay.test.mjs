import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadInlineGameConstants, loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { attachGameplaySync } from './test-support/gameplay-sync.mjs';

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const Wire = require('./wwwroot/js/astervoids-wire-codec.js');
const Config = require('./wwwroot/js/game-config.js');
const Collision = require('./wwwroot/js/collision-geometry.js');
const Fracture = require('./wwwroot/js/asteroid-fracture.js');
const Schema = require('./wwwroot/js/schema-codec.js');
const Schemas = require('./wwwroot/js/game-wire-schemas.js');
const Presentation = require('./wwwroot/js/replication-presentation.js');
const constants = loadInlineGameConstants([
    'PROGRESSION', 'PAYLOAD_KIND', 'MODIFIER_KIND', 'GAME_EFFECT_KIND', 'OBJECT_TYPES',
    'TURN_CONTROL_MODE', 'CONFIG',
], { SHARED_CONFIG_DEFAULTS: Config.SHARED_DEFAULTS });
const { PROGRESSION, PAYLOAD_KIND, MODIFIER_KIND, GAME_EFFECT_KIND, OBJECT_TYPES } = constants;
const id = ordinal => `${ordinal.toString(16).padStart(8, '0')}-1111-2222-3333-aabbccddeeff`;
const A = id(1), B = id(2), C = id(3), D = id(4);
const memberA = id(11), memberB = id(12), memberC = id(13);
const shipA = id(21), shipB = id(22), shipC = id(23), stateId = id(31);
const approx = (actual, expected, tolerance = 1e-9) =>
    assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const pureNames = [
    'getLevelXpThreshold', 'getLevelForXp', 'getProgressionForXp', 'buildVolleyPattern',
    'chooseAsteroidLoadout',
];
const pure = loadInlineGameFunctions(pureNames, constants);

function harness({ session = false, names = [], globals = {} } = {}) {
    const config = { ...constants.CONFIG };
    const clock = { server: 1000 };
    const events = [];
    const objects = new Map();
    const game = {
        mode: session ? 'session' : 'solo', state: 'playing', previousState: null,
        score: 0, lives: 3, wave: 1, speedMultiplier: 1, waveDelayTimer: 0,
        soloXp: 0, soloModifier: null, simulationTimeMs: 0, leaderboardRun: null,
        ship: null, astervoids: [], bullets: [], effects: [],
        multiplayer: {
            myShipObjectId: session ? shipA : null, gameStateObjectId: session ? stateId : null,
            remoteShips: new Map(), contactClaims: new Map(), effectMutations: new Set(),
            effectAnchors: new Map(), processedPendingBullets: new Set(),
            observedScoreLifeAwardCount: 0,
        },
    };
    const sessionClient = {
        getCurrentMember: () => ({ id: memberA, role: 'Server' }),
        getCurrentSession: () => ({
            id: id(30), members: [{ id: memberA }, { id: memberB }, { id: memberC }],
        }),
        getParticipantId: () => A,
        getParticipantIdentity: () => ({ id: A, tag: 'Pilot_1' }),
        getSessionEpoch: () => 1,
    };
    const objectSync = {
        getObject: objectId => objects.get(objectId),
        getObjectByType: type => [...objects.values()].find(object => object.data.type === type),
        getObjectsByType: type => [...objects.values()].filter(object => object.data.type === type),
        isDataConfirmed: () => false,
        updateObject: (...args) => events.push(['update', ...args]),
    };
    const functions = loadInlineGameFunctions([...new Set([
        ...pureNames, 'ShipInvulnerability', 'Ship', 'Asteroid', 'Bullet', 'assignDefined',
        'getReferenceDimension', 'fromNormalizedX', 'fromNormalizedY', 'fromNormalizedSize',
        'sizeToNormalizedX', 'sizeToNormalizedY', 'velocityToNormalizedDeltaX',
        'velocityToNormalizedDeltaY', 'wrapNormalized', 'wrapMarginX', 'wrapMarginY',
        'normalizeTurnControlMode', 'getShipTurnSpeed', 'rampInputToward',
        'getGameEffectNow', 'createGameEffectData', 'getGameEffectTiming', 'anchorGameEffectData',
        'getGameEffectPose', 'buildSprayProjectiles', 'isHostileGameEffect',
        ...names,
    ])], {
        ...constants, CONFIG: config, game, AstervoidsWireCodec: Wire, GuidUtils,
        AstervoidsCollision: Collision, AstervoidsFracture: Fracture,
        crypto: { randomUUID }, pointInPolygon: Collision.pointInPolygon,
        getGameWidth: () => 1000, getGameHeight: () => 1000,
        getEffectiveAsteroidAspectScales: () => ({ radiusScale: 1, speedScale: 1 }),
        randomRange: () => 0, simRandomRange: () => 0,
        isDeterministicMode: () => true, isSessionMode: () => game.mode === 'session',
        isGameOver: () => game.state === 'gameover' || game.lives <= 0,
        isGameStateOwner: () => session, isLobbySpectating: () => false,
        SessionClient: sessionClient, ObjectSync: objectSync,
        RemoteObjects: {
            clock: { offsetInitialized: true },
            isClockOffsetInitialized: () => true, serverNowMs: () => clock.server,
        },
        countExtraLivesForScore: Config.countExtraLivesForScore,
        AudioSystem: {
            playFire: () => events.push(['fire']), playShipExplosion: () => events.push(['ship-hit']),
            thrustSound: { start() {}, stop() {} }, beat: { start() {}, stop() {} },
        },
        CollisionEffects: { startShipHit() {}, startAsteroidHit() {}, resolveBullet() {} },
        updateHUD() {}, publishDebugMetrics() {}, announceExtraLifeAward() {},
        _error: (...args) => assert.fail(args.join(' ')), _warn() {},
        ...globals,
    });
    game.ship = new functions.Ship(0.4, 0.5);
    Object.assign(game.ship, {
        angle: 0, memberId: memberA, participantId: A, participantTag: 'Pilot_1',
        syncObjectId: session ? shipA : null,
    });
    return { ...functions, game, config, clock, events, objects, objectSync, sessionClient };
}

function ledgers(overrides = {}) {
    return {
        processedHits: {}, processedScores: {}, countedParticipants: { [A]: 1, [B]: 1, [C]: 1 },
        participantScores: { [A]: 0, [B]: 0, [C]: 0 },
        participantNumbers: { [A]: 1, [B]: 2, [C]: 3 },
        participantTags: { [A]: 'Pilot_1', [B]: 'Pilot_2', [C]: 'Pilot_3' },
        participantXp: { [A]: 0, [B]: 0, [C]: 0 }, processedEffects: {},
        participantModifiers: {}, ...overrides,
    };
}

const shipRecord = (shipId, participantId, ownerMemberId, extra = {}) => ({
    id: shipId, ownerMemberId,
    data: { type: OBJECT_TYPES.SHIP, participantId, memberId: ownerMemberId, score: 0, hitCount: 0, ...extra },
});
const breakReceipt = (number, finisher, contributors = {}, points = 20) => ({
    id: id(number),
    data: {
        type: OBJECT_TYPES.GAME_EFFECT, kind: GAME_EFFECT_KIND.BREAK_RECEIPT,
        payloadKind: PAYLOAD_KIND.NONE, participantId: finisher, participantTag: 'Pilot_1',
        sourceId: id(number + 1000), points, contributors: Wire.packContributors(
            Object.keys(contributors).length ? contributors : { [finisher.toLowerCase()]: 1 }),
    },
});
const calculator = () => loadInlineGameFunctions([
    ...pureNames, 'getParticipatingParticipantIds', 'awardBreakXp', 'calculateGameState',
], {
    ...constants, GuidUtils, AstervoidsWireCodec: Wire,
    countExtraLivesForScore: Config.countExtraLivesForScore,
});
function calculate({ previous = null, history = ledgers(), ships = [], effects = [],
    members = [memberA, memberB, memberC], retired = [], persisted = {}, local = {} } = {}) {
    return calculator().calculateGameState({
        lives: 3, groupScore: 0, peakShipCount: 3, state: 'playing',
        ...persisted, ...(previous ?? {}),
    }, previous ? ledgers(previous) : history, ships, {
        lives: 3, state: 'playing', observedScoreLifeAwardCount: 0, ...local,
    }, 0, effects, retired, members);
}

test('participation is current-member-owned Ships and unique identities, not spectators or run history', () => {
    const { getParticipatingParticipantIds } = calculator();
    const ships = [
        shipRecord(shipA, A, memberA),
        shipRecord(shipB, A.toUpperCase(), memberB.toUpperCase()),
        shipRecord(shipC, B, memberC),
        shipRecord(id(24), C, id(99)),
        shipRecord(id(25), 'invalid', memberA),
    ];
    const before = structuredClone(ships);
    assert.deepEqual([...getParticipatingParticipantIds(ships, [memberA, memberB, id(98)])].sort(), [A]);
    assert.deepEqual([...getParticipatingParticipantIds(ships, [])], []);
    assert.deepEqual(ships, before, 'ownership and normalization never rewrite borrowed records');
});

test('one break freezes all beneficiary pre-levels before finisher and assist catch-up arithmetic', () => {
    const { awardBreakXp } = calculator();
    for (const contributors of [{ [A]: 2, [B]: 1, [C]: 3 }, { [C]: 3, [B]: 1, [A]: 2 }]) {
        const xp = { [A]: 110, [B]: 50, [C]: 120 };
        const receipt = breakReceipt(101, A.toUpperCase(), contributors);
        awardBreakXp(receipt.data, xp, new Set([A, B, C]));
        assert.deepEqual(xp, { [A]: 120, [B]: 57, [C]: 125 },
            'B is two levels below the pre-award L4 leader; A only one below and cannot self-assist');
    }
});

test('catch-up threshold is inclusive at two levels and uses only current participants', () => {
    const { awardBreakXp } = calculator();
    const data = breakReceipt(102, A, { [A]: 1, [B]: 2 }).data;
    for (const [participating, expectedA, expectedB] of [
        [[A, B, C], 32, 7],
        [[A, B], 30, 5],
        [[], 30, 5],
    ]) {
        const xp = { [A]: 20, [B]: 0, [C]: 200, [D]: 2000 };
        awardBreakXp(data, xp, new Set(participating));
        assert.equal(xp[A], expectedA);
        assert.equal(xp[B], expectedB);
        assert.equal(xp[D], 2000, 'retained departed leaders are not participating');
        assert.equal(xp[C], 200, 'current leader receives nothing without damage');
    }
});

test('departed contributors keep earned assist XP but do not become the catch-up leader', () => {
    const effects = [breakReceipt(103, A, { [B]: 1, [C]: 2, [A]: 3 }, 100)];
    const next = calculate({
        history: ledgers({ participantXp: { [A]: 10, [B]: 2000, [C]: 20 } }),
        ships: [shipRecord(shipA, A, memberA)], members: [memberA], effects,
    });
    assert.deepEqual(next.participantXp, { [A]: 20, [B]: 2005, [C]: 25 });
    assert.equal(next.groupScore, 100);
    assert.deepEqual(next.participantScores, { [A]: 100, [B]: 0, [C]: 0 },
        'assists neither duplicate team points nor receive finisher personal score');
    assert.equal(next.lives, 3);
    assert.deepEqual(next.processedEffects, { [effects[0].id]: 1 });
    const migrated = calculate({ previous: next, effects: [...effects, {
        ...effects[0], id: effects[0].id.toUpperCase(),
    }] });
    assert.deepEqual(migrated.participantXp, next.participantXp);
    assert.equal(migrated.groupScore, 100);
});

test('distinct damage identities award at most two assists and no damage-only or passive XP', () => {
    const untouched = calculate({
        ships: [shipRecord(shipA, A, memberA, { hitCount: 1, score: 100 })],
    });
    assert.deepEqual(untouched.participantXp, { [A]: 0, [B]: 0, [C]: 0 });
    const effects = [breakReceipt(104, A, { [A]: 1, [B]: 2, [C]: 3 })];
    const next = calculate({
        previous: untouched,
        ships: [shipRecord(shipB, A.toUpperCase(), memberB)],
        effects: [effects[0], { ...effects[0], id: effects[0].id.toUpperCase() }],
    });
    assert.deepEqual(next.participantXp, { [A]: 10, [B]: 5, [C]: 5 });
    assert.equal(next.groupScore, untouched.groupScore + 20);
    assert.equal(next.lives, untouched.lives);
});

test('receipt GUID order, not arrival order, deterministically crosses catch-up thresholds', () => {
    const history = ledgers({ participantXp: { [A]: 10, [B]: 60, [C]: 0 } });
    const ships = [shipRecord(shipA, A, memberA), shipRecord(shipB, B, memberB)];
    const low = breakReceipt(105, A);
    const high = breakReceipt(106, A);
    const first = calculate({ history, ships, effects: [high, low] });
    const second = calculate({ history, ships, effects: [low, high] });
    assert.deepEqual(first, second);
    assert.equal(first.participantXp[A], 32,
        'L1 starts two below L3 (+12); next receipt sees L2 only one below (+10)');
    assert.deepEqual(history.participantXp, { [A]: 10, [B]: 60, [C]: 0 });
});

test('co-visible same-identity modifier conflicts use normalized Ship GUID order and accept once per milestone', () => {
    const history = ledgers({ participantXp: { [A]: 120, [B]: 0, [C]: 0 } });
    const first = shipRecord(shipA.toUpperCase(), A.toUpperCase(), memberA,
        { modifierRequestMilestone: 4, modifierRequestKind: MODIFIER_KIND.FOCUS });
    const later = shipRecord(shipB, A, memberB,
        { modifierRequestMilestone: 4, modifierRequestKind: MODIFIER_KIND.SWEEP });
    const next = calculate({ history, ships: [later, first] });
    assert.deepEqual(next.participantModifiers, {
        [A]: { consumedMilestone: 4, modifierKind: MODIFIER_KIND.FOCUS },
    });
    const repeat = calculate({ previous: next, ships: [later] });
    assert.deepEqual(repeat.participantModifiers, next.participantModifiers);
    assert.deepEqual(history.participantModifiers, {}, 'the pure authority cannot alter persisted history');
    assert.equal(calculate({ history }).participantModifiers[A], undefined,
        'the game never auto-selects an optional milestone');
});

test('a choice is validated after receipt XP, collapses unspent milestones and persists through death/departure', () => {
    const request = shipRecord(shipA, A, memberA,
        { modifierRequestMilestone: 4, modifierRequestKind: MODIFIER_KIND.SWEEP });
    const next = calculate({
        history: ledgers({ participantXp: { [A]: 110, [B]: 0, [C]: 0 } }),
        ships: [request], effects: [breakReceipt(109, A)],
    });
    assert.deepEqual(next.participantModifiers[A], { consumedMilestone: 4, modifierKind: MODIFIER_KIND.SWEEP });
    const returned = calculate({
        previous: { ...next, participantXp: { [A]: 1320, [B]: 0, [C]: 0 } },
        ships: [shipRecord(shipC, A, memberC,
            { modifierRequestMilestone: 12, modifierRequestKind: MODIFIER_KIND.FOCUS, hitCount: 1 })],
    });
    assert.deepEqual(returned.participantModifiers[A], { consumedMilestone: 12, modifierKind: MODIFIER_KIND.FOCUS });
    const departed = calculate({ previous: returned, ships: [], members: [] });
    assert.deepEqual(departed.participantModifiers, returned.participantModifiers);
    const stale = calculate({
        previous: departed, ships: [shipRecord(shipB, A, memberB,
            { modifierRequestMilestone: 8, modifierRequestKind: MODIFIER_KIND.SWEEP })],
    });
    assert.deepEqual(stale.participantModifiers, departed.participantModifiers,
        'old L8 cannot replace the accepted latest L12 choice after a new ship or owner');
});

test('modifier requests reject unearned/stale milestones, invalid kinds, stale owners and terminal activation', () => {
    const history = ledgers({ participantXp: { [A]: 560, [B]: 0, [C]: 0 } });
    for (const extra of [
        { modifierRequestMilestone: 4, modifierRequestKind: 1 },
        { modifierRequestMilestone: 12, modifierRequestKind: 1 },
        { modifierRequestMilestone: 8, modifierRequestKind: 0 },
        { modifierRequestMilestone: 8, modifierRequestKind: 3 },
        { modifierRequestMilestone: 8, modifierRequestKind: 1, memberId: memberB },
    ]) {
        assert.deepEqual(calculate({ history, ships: [shipRecord(shipA, A, memberA, extra)] })
            .participantModifiers, {});
    }
    const valid = shipRecord(shipA, A, memberA,
        { modifierRequestMilestone: 8, modifierRequestKind: 1 });
    assert.deepEqual(calculate({ history, ships: [valid], members: [memberB] }).participantModifiers, {});
    assert.deepEqual(calculate({ history, ships: [valid],
        persisted: { lives: 0, gameOverAt: 1000 } }).participantModifiers, {});
});

test('failed choice acknowledgement latches its first winner against a later lower-GUID conflict', () => {
    const history = ledgers({ participantXp: { [A]: 120, [B]: 0, [C]: 0 } });
    const acceptedFirst = calculate({
        history, ships: [shipRecord(shipC, A, memberC,
            { modifierRequestMilestone: 4, modifierRequestKind: MODIFIER_KIND.SWEEP })],
    });
    const retry = calculate({
        history, local: { tentativeModifiers: acceptedFirst.participantModifiers },
        ships: [shipRecord(shipA, A, memberA,
            { modifierRequestMilestone: 4, modifierRequestKind: MODIFIER_KIND.FOCUS })],
    });
    assert.deepEqual(retry.participantModifiers, acceptedFirst.participantModifiers,
        'the rejected write must retry the same choice, not recalculate a different tentative winner');
});

test('owned Ship modifier/boost retries carry fresh pose outside the motion gate until durable acknowledgement', async () => {
    const h = harness({ session: true, names: ['syncLocalShipBoosts'] });
    const network = attachGameplaySync(h, memberA);
    network.seed([{
        id: shipA, ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Member', schemaId: 1, version: 1, data: h.game.ship.toSyncData(),
    }]);
    h.game.ship.modifierRequestMilestone = 4;
    h.game.ship.modifierRequestKind = MODIFIER_KIND.FOCUS;
    h.game.ship.boostState.shieldUntil = 7000;
    h.game.ship.x = 0.61;
    network.transport.acknowledge = false;
    h.syncLocalShipBoosts();
    await network.sync.flushUpdates();
    assert.equal(network.sync.isDataConfirmed(shipA, h.game.ship.boostData()), false);
    h.game.ship.x = 0.72;
    h.syncLocalShipBoosts();
    await network.sync.flushUpdates();
    const batches = network.calls.filter(call => call.method === 'update');
    assert.equal(batches.length, 2);
    assert.equal(batches[0].updates[0].data.modifierRequestKind, MODIFIER_KIND.FOCUS);
    assert.equal(batches[1].updates[0].data.modifierRequestMilestone, 4);
    approx(batches[0].updates[0].data.x, 0.61);
    approx(batches[1].updates[0].data.x, 0.72);
    assert.deepEqual(Wire.unpackBoostState(batches[1].updates[0].data.boostState), h.game.ship.boostState);
    network.transport.acknowledge = true;
    h.syncLocalShipBoosts();
    await network.sync.flushUpdates();
    const confirmedWrites = network.calls.length;
    h.syncLocalShipBoosts();
    await network.sync.flushUpdates();
    assert.equal(network.calls.length, confirmedWrites, 'confirmed boosts do not turn into every-tick motion traffic');
});

test('only the accepted GameState modifier fires, never the request or an optimistic failed choice write', async () => {
    const h = harness({
        session: true,
        names: ['getSessionModifierLedger', 'getLocalModifier', 'readGameStateLedger',
            'gameStateLedgerMatches', 'gameStateCounterMapsEqual'],
        globals: { sessionModifierViewCache: null, reportMalformedGameStateLedgers: (...args) => assert.fail(args[1]) },
    });
    const network = attachGameplaySync(h, memberA);
    network.seed([{
        id: stateId, ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Session', schemaId: 4, version: 1, data: {
            type: OBJECT_TYPES.GAME_STATE, participantModifiers: Wire.packParticipantModifiers({}),
        },
    }]);
    assert.equal(h.getLocalModifier(), MODIFIER_KIND.NONE);
    h.game.ship.modifierRequestMilestone = 4;
    h.game.ship.modifierRequestKind = MODIFIER_KIND.FOCUS;
    assert.equal(h.getLocalModifier(), MODIFIER_KIND.NONE);
    const payload = { participantModifiers: Wire.packParticipantModifiers({
        [A]: { consumedMilestone: 4, modifierKind: MODIFIER_KIND.FOCUS },
    }) };
    network.transport.acknowledge = false;
    network.sync.updateObject(stateId, payload);
    await network.sync.flushUpdates();
    assert.equal(h.getLocalModifier(), MODIFIER_KIND.NONE);
    const unaccepted = h.game.ship.shoot(5, h.getLocalModifier());
    approx(Math.hypot(unaccepted[2].velocityX, unaccepted[2].velocityY), h.config.BULLET_SPEED);
    network.transport.acknowledge = true;
    network.sync.updateObject(stateId, payload);
    await network.sync.flushUpdates();
    assert.equal(h.getLocalModifier(), MODIFIER_KIND.FOCUS);
    h.game.ship.shootCooldown = 0;
    const accepted = h.game.ship.shoot(5, h.getLocalModifier());
    approx(Math.hypot(accepted[2].velocityX, accepted[2].velocityY), h.config.BULLET_SPEED * 1.15);
});

test('every level fires exactly L shots with exclusive FOCUS/SWEEP modifiers and unchanged first formations', () => {
    for (const level of [1, 2, 3, 4, 8, 12, 32, 71]) {
        for (const modifier of [MODIFIER_KIND.NONE, MODIFIER_KIND.FOCUS, MODIFIER_KIND.SWEEP]) {
            const h = harness();
            const shots = h.game.ship.shoot(level, modifier);
            assert.equal(shots.length, level);
            assert.equal(h.events.filter(event => event[0] === 'fire').length, 1);
            assert.equal(h.game.ship.shoot(level, modifier), null);
            const speed = h.config.BULLET_SPEED * (modifier === MODIFIER_KIND.FOCUS ? 1.15 : 1);
            for (const shot of shots) {
                approx(Math.hypot(shot.velocityX, shot.velocityY), speed);
                assert.equal(shot.lifetime, h.config.BULLET_LIFETIME);
            }
            if (level <= 3) {
                assert.deepEqual(shots.map(shot => shot.velocityY), Array(level).fill(0));
                assert.equal(new Set(shots.map(shot => shot.y)).size, level);
            } else {
                const scale = modifier === MODIFIER_KIND.FOCUS ? 0.75 : modifier === MODIFIER_KIND.SWEEP ? 1.25 : 1;
                const degrees = Math.min(90, Math.min(90, 24 + 8 * (level - 4)) * scale);
                approx(Math.atan2(shots.at(-1).velocityY, shots.at(-1).velocityX)
                    - Math.atan2(shots[0].velocityY, shots[0].velocityX), degrees * Math.PI / 180);
            }
            assert.equal(h.game.ship.shootCooldown, h.config.SHOOT_COOLDOWN);
        }
    }
});

test('rapid fire changes only the next complete volley cooldown and leaves existing shots frozen', () => {
    const h = harness();
    const ship = h.game.ship;
    const before = ship.shoot(8, MODIFIER_KIND.FOCUS);
    const snapshots = before.map(bullet => bullet.toSyncData());
    ship.boostState.rapidFireUntil = 6000;
    ship.boostState.shieldUntil = 6000;
    assert.equal(ship.shootCooldown, h.config.SHOOT_COOLDOWN, 'a pickup cannot rewrite a running cooldown');
    assert.equal(ship.shoot(8, MODIFIER_KIND.SWEEP), null);
    ship.update(h.config.SHOOT_COOLDOWN);
    assert.equal(ship.shoot(8, MODIFIER_KIND.SWEEP).length, 8);
    assert.equal(ship.shootCooldown, h.config.SHOOT_COOLDOWN * 0.75);
    assert.deepEqual(before.map(bullet => bullet.toSyncData()), snapshots,
        'accepted new choice/boost cannot change existing velocity, lifetime, damage ID or attribution');
    h.game.simulationTimeMs = 6000;
    ship.shootCooldown = 0;
    ship.shoot(8, MODIFIER_KIND.SWEEP);
    assert.equal(ship.shootCooldown, h.config.SHOOT_COOLDOWN, 'exact expiry restores normal cadence');
});

test('real input preserves MAX_BULLETS times level and admits a whole modified volley or nothing', () => {
    for (const level of [1, 2, 3, 4, 12, 33, 71]) {
        for (const room of [level, level - 1]) {
            const h = harness({
                names: ['handleInput', 'getLocalProgression', 'getLocalModifier'],
                globals: {
                    keys: {}, isAnalogControlSchemeEnabled: () => false,
                    getNeutralAnalogBrakeInput: () => 0,
                    input: {
                        left: () => false, right: () => false, thrust: () => false,
                        brake: () => false, fire: () => true,
                    },
                },
            });
            h.game.soloXp = h.getLevelXpThreshold(level);
            h.game.soloModifier = { consumedMilestone: 4, modifierKind: MODIFIER_KIND.FOCUS };
            const active = h.config.MAX_BULLETS * level - room;
            h.game.bullets = [
                ...Array.from({ length: active }, () => ({ ownerMemberId: memberA, pendingHit: false })),
                ...Array.from({ length: 20 }, () => ({ ownerMemberId: memberA, pendingHit: true })),
                ...Array.from({ length: 20 }, () => ({ ownerMemberId: memberB, pendingHit: false })),
            ];
            const before = h.game.bullets.length;
            h.handleInput();
            assert.equal(h.game.bullets.length - before, room === level ? level : 0);
            assert.equal(h.game.ship.shootCooldown, room === level ? h.config.SHOOT_COOLDOWN : 0);
            if (room === level) for (const bullet of h.game.bullets.slice(before)) {
                approx(Math.hypot(bullet.velocityX, bullet.velocityY), h.config.BULLET_SPEED * 1.15);
            }
        }
    }
});

test('full FOCUS velocities reach real spawn, presentation, canonical and terminal projections without borrowing mutations', () => {
    const clock = { now: 1000, deterministic: true, terminal: null };
    const config = { ...constants.CONFIG };
    let h;
    const dead = Presentation.createDeadReckoningPolicy({
        config, nowMs: () => clock.now,
        velocityToDeltaX: value => value / config.TARGET_FPS,
        velocityToDeltaY: value => value / config.TARGET_FPS,
        shortestAngleDelta: (a, b) => a - b,
        createState: (...args) => h.createDeadReckoningState(...args),
        shouldReplay: () => false,
    });
    const buffered = Presentation.createSnapshotInterpolationPolicy({
        config, nowMs: () => clock.now, validAtToTime: value => value,
        getDelayForMember: () => 0,
        velocityToDeltaX: value => value, velocityToDeltaY: value => value,
        shortestDeltaX: (a, b) => b - a, shortestDeltaY: (a, b) => b - a,
        wrapX: value => value, wrapY: value => value,
        distanceBetween: (a, b) => Math.hypot(b.x - a.x, b.y - a.y),
    });
    h = harness({
        names: [
            'createDeadReckoningState', 'projectSpawnData', 'currentKinematicData',
            'createKinematicPresentation', 'buildTerminalTargetPayload',
            'normalizeTerminalAngle', 'wrapNormalizedMod', 'computeReplacementBridgePose',
        ],
        globals: {
            DeadReckon: dead,
            RemoteObjects: {
                ...buffered, isClockOffsetInitialized: () => true,
                serverNowMs: () => clock.now, getBoundingRadius: () => 0,
            },
            getRemoteBoundingRadius: () => 0, getKinematicInstance: () => null,
            wrapRadiusFor: () => 0,
            isDeterministicMode: () => clock.deterministic,
            resolveTerminalSession: () => clock.terminal,
            getDeterministicIngestBaselinePerf: () => 1000,
        },
    });
    const policy = h.createKinematicPresentation();
    for (const [index, vx, vy] of [
        [0, Math.fround(1.15), 0], [1, -Math.fround(1.15), 0],
        [2, 0, Math.fround(1.15)], [3, 0, -Math.fround(1.15)],
    ]) {
        clock.now = 1000;
        clock.terminal = null;
        const data = Object.freeze({
            type: OBJECT_TYPES.BULLET, x: 0.4, y: 0.5, angle: 0,
            velocityX: Math.max(-1, Math.min(1, vx)), velocityY: Math.max(-1, Math.min(1, vy)),
            velocityXFull: vx, velocityYFull: vy, lifetime: 60,
        });
        const before = structuredClone(data);
        const objectId = id(180 + index);
        const record = { id: objectId, version: 1, ownerMemberId: memberB, validAt: 1000, data };
        const facts = { type: OBJECT_TYPES.BULLET, objectId };
        const projected = h.projectSpawnData(data, 0.1);
        approx(projected.x, data.x + vx * 0.1);
        approx(projected.y, data.y + vy * 0.1);
        assert.notEqual(h.projectSpawnData(data, 0), data);
        const fallback = h.currentKinematicData(OBJECT_TYPES.BULLET, objectId, record, {});
        assert.equal(fallback.velocityX, vx);
        assert.equal(fallback.velocityY, vy);
        for (const deterministic of [true, false]) {
            clock.now = 1000;
            clock.deterministic = deterministic;
            policy.ingest(objectId, data, facts, record, {});
            clock.now = 1100;
            const sampled = policy.sample(objectId, facts, record, { renderTime: clock.now });
            approx(sampled.x, data.x + vx * 0.1);
            approx(sampled.y, data.y + vy * 0.1);
            assert.equal(sampled.velocityX, vx);
            assert.equal(sampled.velocityY, vy);
        }
        const terminal = { epoch: 900, terminalAt: 1250 };
        clock.now = 1000;
        const target = h.buildTerminalTargetPayload(null, record, terminal);
        approx(target.terminalX, data.x + vx * 0.125);
        approx(target.terminalY, data.y + vy * 0.125);
        clock.now = 100_000;
        assert.deepEqual(h.buildTerminalTargetPayload(null, record, terminal), target);
        clock.deterministic = true;
        clock.terminal = terminal;
        const terminalSample = policy.sample(objectId, facts, record, { renderTime: clock.now });
        assert.equal(terminalSample.velocityX, vx);
        assert.equal(terminalSample.velocityY, vy);
        const bridge = h.computeReplacementBridgePose(data, {
            x: 0.1, y: 0.2, angle: 0, velocityX: 0.05, velocityY: 0.1,
        }, { timeDiffSec: 0.1, bridgeIsBeforeAuth: false, velScaleX: 1, velScaleY: 1 });
        approx(bridge.x, data.x - vx * 0.1);
        approx(bridge.y, data.y - vy * 0.1);
        assert.equal(bridge.velocityX, vx);
        assert.equal(bridge.velocityY, vy);
        assert.deepEqual(data, before);
    }
});

test('FOCUS full-velocity roundtrip feeds real Bullet factory, sparse adoption and movement without source mutation', () => {
    const h = harness();
    Schema.replaceAll(Schemas.SCHEMAS);
    const s = Schema.get(3);
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        h.game.ship.angle = angle;
        h.game.ship.shootCooldown = 0;
        const shot = h.game.ship.shoot(5, MODIFIER_KIND.FOCUS)[2];
        assert.ok(Math.max(Math.abs(shot.velocityX), Math.abs(shot.velocityY)) > 1);
        const encoded = Schema.encode(s, shot.toSyncData());
        const decoded = Schema.decode(s, encoded);
        const borrowed = Object.freeze(decoded);
        const resolved = h.Bullet.resolveVelocityData(borrowed);
        assert.notEqual(resolved, borrowed);
        const recovered = h.Bullet.fromSyncData(borrowed);
        approx(recovered.velocityX, shot.velocityX, 1e-6);
        approx(recovered.velocityY, shot.velocityY, 1e-6);
        const baseline = { x: recovered.x, y: recovered.y };
        recovered.fromSyncData({ lifetime: 10 });
        recovered.update(1);
        approx(recovered.x - baseline.x, shot.velocityX / h.config.TARGET_FPS, 1e-6);
        approx(recovered.y - baseline.y, shot.velocityY / h.config.TARGET_FPS, 1e-6);
        approx(recovered.velocityXFull, shot.velocityX, 1e-6);
        approx(recovered.velocityYFull, shot.velocityY, 1e-6);
        assert.equal(borrowed.velocityX, decoded.velocityX, 'the borrowed quantized slot remains untouched');
    }
    for (const invalid of [
        { velocityXFull: 1.15 }, { velocityYFull: 1.15 },
        { velocityXFull: null, velocityYFull: 0 }, { velocityXFull: 0, velocityYFull: null },
        { velocityXFull: Infinity, velocityYFull: 0 },
        { velocityXFull: 0, velocityYFull: NaN },
    ]) assert.throws(() => h.Bullet.fromSyncData(invalid));
});

test('armor probabilities stay unchanged while all eight payload probabilities preserve old enum codes', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(PAYLOAD_KIND)), {
        NONE: 0, NUKE: 1, LEVELUP: 2, EXTRA_LIFE: 3, SMART_BOMB: 4, MINE: 5, SPRAY: 6,
        SHIELD: 7, RAPID_FIRE: 8,
    });
    for (const [level, expected] of [[3, [1000, 0, 0]], [4, [800, 200, 0]], [7, [700, 200, 100]]]) {
        const armor = [0, 0, 0];
        for (let index = 0; index < 1000; index++) {
            armor[pure.chooseAsteroidLoadout(level, (index + 0.5) / 1000, 0).maxHits - 1]++;
        }
        assert.deepEqual(armor, expected);
    }
    const payloads = Array(9).fill(0);
    for (let index = 0; index < 1000; index++) {
        payloads[pure.chooseAsteroidLoadout(7, 0.95, (index + 0.5) / 1000).payloadKind]++;
    }
    assert.deepEqual(payloads, [0, 150, 150, 150, 150, 100, 100, 100, 100]);
});

test('wave armor multiplies spawn velocity once and accepted damage cannot accelerate survivors', async () => {
    const spawned = [];
    for (const armorRoll of [0.1, 0.8, 0.95]) {
        const rolls = [0.05, 0.05, 0.25, 0.5, 0.2, armorRoll, 0.65];
        const h = harness({
            names: ['spawnAsteroidAwayFromShip', 'normalizedDistance', 'applySoloAsteroidDamage'],
            globals: {
                simRandom: () => rolls.shift(), simRng: { nextSeed: () => 123 },
                getRunHighestLevel: () => 7,
            },
        });
        const asteroid = await h.spawnAsteroidAwayFromShip();
        spawned.push(asteroid);
        const velocity = { x: asteroid.velocityX, y: asteroid.velocityY };
        while (asteroid.hitsRemaining > 1) {
            h.applySoloAsteroidDamage(asteroid, { damageId: randomUUID(), participantId: A });
            assert.deepEqual({ x: asteroid.velocityX, y: asteroid.velocityY }, velocity);
        }
    }
    assert.deepEqual(spawned.map(asteroid => asteroid.maxHits), [1, 2, 3]);
    for (const [index, scale] of [[1, 0.85], [2, 0.70]]) {
        approx(spawned[index].velocityX, spawned[0].velocityX * scale);
        approx(spawned[index].velocityY, spawned[0].velocityY * scale);
    }
});

test('armored direct fractures speed linear children once but erase payload and damage/contributor histories', () => {
    const h = harness({ names: ['splitAsteroid', 'computeDeflectionImpulse'] });
    const fracture = maxHits => {
        const asteroid = new h.Asteroid(0.6, 0.2, 0.09, 0.1, -0.02, 123);
        Object.assign(asteroid, { maxHits, hitsRemaining: 1, payloadKind: PAYLOAD_KIND.NONE,
            angle: 0.35, rotationSpeed: 0.005,
            processedDamage: { [id(110)]: 1 }, contributors: { [A]: 1 } });
        h.game.astervoids = [asteroid];
        h.splitAsteroid(asteroid, null, { bulletAngle: 0.4, offsetN: 0.2, impactTorque: 0 });
        return [...h.game.astervoids];
    };
    const normal = fracture(1);
    const armored = fracture(3);
    assert.equal(armored.length, normal.length);
    assert.ok(armored.length > 0);
    for (let index = 0; index < normal.length; index++) {
        const child = armored[index];
        approx(child.velocityX, normal[index].velocityX * 1.15);
        approx(child.velocityY, normal[index].velocityY * 1.15);
        approx(child.rotationSpeed, normal[index].rotationSpeed);
        assert.equal(child.maxHits, 1);
        assert.equal(child.hitsRemaining, 1);
        assert.equal(child.payloadKind, PAYLOAD_KIND.NONE);
        assert.deepEqual(Wire.unpackContributors(child.toSyncData().contributors), {});
        assert.deepEqual(Wire.unpackCounterMap(child.toSyncData().processedDamage), {});
    }
    const child = armored[0];
    const expected = Fracture.calculateAsteroidFragments(child,
        { bulletAngle: 0.4, offsetN: 0.2, impactTorque: 0 }, h.config).children;
    h.game.astervoids = [child];
    h.splitAsteroid(child, null, { bulletAngle: 0.4, offsetN: 0.2, impactTorque: 0 });
    assert.equal(h.game.astervoids.length, expected.length);
    for (let index = 0; index < expected.length; index++) {
        approx(h.game.astervoids[index].velocityX, expected[index].vx);
        approx(h.game.astervoids[index].velocityY, expected[index].vy);
    }
});

test('armored-child speed is applied before shooter avoidance and existing wire speed caps', async () => {
    const seen = [];
    const h = harness({
        session: true, names: ['splitAsteroid', 'replaceSyncedAsteroid'],
        globals: {
            AstervoidsFracture: {
                ...Fracture,
                calculateAsteroidFragments: () => ({ children: [{
                    cx: 0.02, cy: 0.01, r: 0.03, vx: 0.2, vy: -0.1, omega: 0.01,
                }] }),
            },
            computeDeflectionImpulse: (...args) => {
                seen.push(args);
                return { dvx: 0, dvy: 0 };
            },
        },
    });
    const network = attachGameplaySync(h, memberA);
    const parent = new h.Asteroid(0.6, 0.2, 0.09, 0.1, -0.02, 123);
    Object.assign(parent, { syncObjectId: id(160), maxHits: 3, hitsRemaining: 1 });
    network.seed([{
        id: parent.syncObjectId, ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Session', schemaId: 2, version: 1, data: parent.toSyncData(),
    }]);
    h.config.DEFLECTION_SCALE = 1;
    h.config.DEFLECTION_TIME_LIMIT = 1;
    h.config.ASTEROID_MAX_SPEED = 0.15;
    await h.splitAsteroid(parent, memberA, null, h.game.ship);
    assert.equal(seen.length, 1);
    approx(seen[0][2], 0.23);
    approx(seen[0][3], -0.115);
    const child = network.calls.find(call => call.method === 'replace').replacements[0];
    approx(Math.hypot(child.velocityX, child.velocityY), 0.15);
    assert.deepEqual(Wire.unpackContributors(child.contributors), {});
    assert.equal(child.maxHits, 1);
});

test('accepted armor damage deduplicates first, persists contributors with HP, and retries current motion outside SendGate', async () => {
    const h = harness({
        session: true, names: ['applyOwnedAsteroidDamage', 'syncLocalAstervoids'],
        globals: { SendGate: { shouldSend: () => false } },
    });
    const network = attachGameplaySync(h, memberA);
    const asteroid = new h.Asteroid(0.6, 0.2, 0.09, 0.1, -0.02, 123);
    Object.assign(asteroid, { syncObjectId: id(161), maxHits: 3, hitsRemaining: 3 });
    h.game.astervoids = [asteroid];
    network.seed([{
        id: asteroid.syncObjectId, ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Session', schemaId: 2, version: 1, data: asteroid.toSyncData(),
    }]);
    const damage = { damageId: id(162), participantId: B, shipId: shipB };
    network.transport.acknowledge = false;
    assert.equal(await h.applyOwnedAsteroidDamage(asteroid, damage), true);
    await network.sync.flushUpdates();
    assert.equal(await h.applyOwnedAsteroidDamage(asteroid, damage), false);
    assert.equal(asteroid.hitsRemaining, 2);
    assert.deepEqual(asteroid.contributors, { [B]: 1 });
    asteroid.x = 0.7;
    asteroid.y = 0.3;
    h.syncLocalAstervoids();
    await network.sync.flushUpdates();
    const update = network.calls.filter(call => call.method === 'update').at(-1).updates[0].data;
    assert.equal(update.hitsRemaining, 2);
    assert.deepEqual(Wire.unpackContributors(update.contributors), { [B]: 1 });
    assert.deepEqual(Wire.unpackCounterMap(update.processedDamage), { [damage.damageId]: 1 });
    approx(update.x, 0.7);
    approx(update.y, 0.3);
    assert.equal(h.game.soloXp, 0);
    assert.equal(h.game.score, 0);
    network.transport.acknowledge = true;
    h.syncLocalAstervoids();
    await network.sync.flushUpdates();
    const before = network.calls.length;
    h.syncLocalAstervoids();
    await network.sync.flushUpdates();
    assert.equal(network.calls.length, before);
});

test('atomic breaking replacement freezes distinct contributors and receipts while direct children start clean', async () => {
    const h = harness({ session: true, names: [
        'applyOwnedAsteroidDamage', 'splitAsteroid', 'replaceSyncedAsteroid',
        'computeDeflectionImpulse', 'buildAsteroidBreakEffects', 'getAsteroidObjectId',
    ] });
    const network = attachGameplaySync(h, memberA);
    const asteroid = new h.Asteroid(0.6, 0.2, 0.09, 0.1, -0.02, 123);
    Object.assign(asteroid, {
        syncObjectId: id(170), maxHits: 3, hitsRemaining: 3, payloadKind: PAYLOAD_KIND.SHIELD,
    });
    h.game.astervoids = [asteroid];
    network.seed([{
        id: asteroid.syncObjectId, ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Session', schemaId: 2, version: 1, data: asteroid.toSyncData(),
    }]);
    for (const [number, participantId] of [[171, B], [172, A], [173, B]]) {
        assert.equal(await h.applyOwnedAsteroidDamage(asteroid, {
            damageId: id(number), participantId, shipId: participantId === A ? shipA : shipB,
        }, null, memberB), true);
        await network.sync.flushUpdates();
    }
    const replacement = network.calls.find(call => call.method === 'replace');
    assert.ok(replacement);
    const receipt = replacement.replacements.find(data => data.kind === GAME_EFFECT_KIND.BREAK_RECEIPT);
    assert.deepEqual(Wire.unpackContributors(receipt.contributors), { [A]: 2, [B]: 1 });
    assert.deepEqual(Wire.unpackCounterMap(receipt.damageReceipts),
        { [id(171)]: 1, [id(172)]: 1, [id(173)]: 1 });
    const children = replacement.replacements.filter(data => data.type === OBJECT_TYPES.ASTEROID);
    assert.ok(children.length > 0);
    for (const child of children) {
        assert.deepEqual(Wire.unpackContributors(child.contributors), {});
        assert.deepEqual(Wire.unpackCounterMap(child.processedDamage), {});
        assert.equal(child.maxHits, 1);
        assert.equal(child.payloadKind, PAYLOAD_KIND.NONE);
    }
    const pickup = replacement.replacements.find(data => data.kind === GAME_EFFECT_KIND.PICKUP);
    assert.equal(pickup.payloadKind, PAYLOAD_KIND.SHIELD);
    assert.deepEqual(Wire.unpackContributors(pickup.contributors), {});
    assert.equal(h.game.score, 0);
    assert.equal(h.game.soloXp, 0);
});

test('shield deadline OR normal invulnerability protects without healing or sharing across same-identity ships', () => {
    const h = harness();
    const ship = h.game.ship;
    ship.hitCount = 2;
    ship.boostState.shieldUntil = 6000;
    ship.invulnerable = 0;
    assert.equal(ship.isShielded(5999.999), true);
    assert.equal(ship.isShielded(6000), false);
    ship.invulnerable = 1;
    assert.equal(ship.isShielded(10_000), true);
    assert.equal(ship.hitCount, 2);
    assert.equal(h.game.lives, 3);
    const other = new h.Ship(0.4, 0.5);
    other.participantId = A;
    other.invulnerable = 0;
    assert.equal(other.isShielded(1000), false);
    assert.notEqual(other.boostState.lifeId, ship.boostState.lifeId);
});

test('same surviving Ship recovery preserves boost deadlines and life token; damage/reset rotate once', () => {
    const h = harness({ names: ['handleShipHit'] });
    const original = h.game.ship;
    original.boostState.shieldUntil = 4000;
    original.boostState.rapidFireUntil = 6000;
    const accepted = original.toSyncData();
    assert.equal(accepted.boostState.length, 32);
    const recovered = new h.Ship(0, 0);
    recovered.fromSyncData(accepted);
    assert.deepEqual(recovered.boostState, original.boostState);
    const token = recovered.boostState.lifeId;
    recovered.invulnerable = 1;
    recovered.update(1);
    assert.equal(recovered.boostState.lifeId, token, 'ordinary invulnerability expiry is not a new life');
    h.game.ship = recovered;
    h.handleShipHit(recovered);
    assert.notEqual(recovered.boostState.lifeId, token);
    assert.equal(recovered.boostState.shieldUntil, 0);
    assert.equal(recovered.boostState.rapidFireUntil, 0);
    const afterDamage = recovered.boostState.lifeId;
    recovered.reset();
    assert.notEqual(recovered.boostState.lifeId, afterDamage);
});

const boostNames = [
    'isTimedBoostPayload', 'applyBoostReceipt', 'isBoostReceiptHandled',
    'syncLocalShipBoosts', 'isGameEffectReady', 'getGameEffectTimerData',
];
function boostReceipt(h, { number = 200, payloadKind = PAYLOAD_KIND.SHIELD,
    startedAt = 1000, owner = memberB, shipId = shipA, participantId = A, lifeId = h.game.ship.boostState.lifeId } = {}) {
    return {
        id: id(number), ownerMemberId: owner, creatorMemberId: owner,
        scope: 'Session', schemaId: 5, version: 1, validAt: startedAt + 20_000,
        data: {
            ...h.createGameEffectData(GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payloadKind,
                id(number + 1000), { shipId, participantId, shipLifeId: lifeId }, 0.4, 0.5),
            startedAt, armedAt: startedAt, expiresAt: startedAt,
        },
    };
}
function seedBoostSession(h, network, receipts = [], extraObjects = []) {
    network.seed([{
        id: shipA, ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Member', schemaId: 1, version: 1, data: h.game.ship.toSyncData(),
    }, {
        id: stateId, ownerMemberId: memberB, creatorMemberId: memberB,
        scope: 'Session', schemaId: 4, version: 1,
        data: {
            type: OBJECT_TYPES.GAME_STATE, lives: 3, groupScore: 0,
            participantXp: Wire.packXpMap({ [A]: 0 }),
            participantScores: Wire.packCounterMap({ [A]: 0 }),
            participantModifiers: Wire.packParticipantModifiers({}),
            processedEffects: Wire.packCounterMap(Object.fromEntries(receipts.map(record => [record.id, 1]))),
        },
    }, ...receipts, ...extraObjects]);
}

test('accepted boost receipts coexist and refresh max original-start+6000 without additive or replay time', async () => {
    const h = harness({ session: true, names: boostNames });
    const network = attachGameplaySync(h, memberA);
    const first = boostReceipt(h);
    const rapid = boostReceipt(h, { number: 201, payloadKind: PAYLOAD_KIND.RAPID_FIRE });
    const refresh = boostReceipt(h, { number: 202, startedAt: 2000 });
    const nuke = boostReceipt(h, { number: 203, payloadKind: PAYLOAD_KIND.NUKE, startedAt: 2500 });
    seedBoostSession(h, network, [first, rapid, refresh, nuke]);
    let releaseFirst;
    const firstRequest = new Promise(resolve => { releaseFirst = resolve; });
    const update = network.client.updateObjects;
    let holdFirst = true;
    network.client.updateObjects = async updates => {
        if (holdFirst) {
            holdFirst = false;
            await firstRequest;
        }
        return update(updates);
    };
    h.clock.server = 3000;
    for (const receipt of [first, rapid, refresh, nuke]) assert.equal(h.applyBoostReceipt(receipt, 1), true);
    assert.deepEqual(h.game.ship.boostState, {
        lifeId: h.game.ship.boostState.lifeId, shieldUntil: 8000, rapidFireUntil: 7000,
    });
    const before = { ...h.game.ship.boostState };
    h.clock.server = 30_000;
    first.validAt = 30_000;
    assert.equal(h.applyBoostReceipt(first, 1), true);
    assert.deepEqual(h.game.ship.boostState, before);
    assert.equal(h.game.ship.isShielded(), false, 'a late recovered old receipt never creates fresh protection');
    assert.equal(h.game.lives, 3);
    assert.equal(h.game.ship.hitCount, 0);
    assert.equal(h.isBoostReceiptHandled(first.data, first.id, 1), false);
    releaseFirst();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Wire.unpackBoostState(network.server.get(shipA).data.boostState), {
        lifeId: h.game.ship.boostState.lifeId, shieldUntil: 7000, rapidFireUntil: 0,
    });
    assert.equal(h.isBoostReceiptHandled(first.data, first.id, 1), false,
        'the newer coalesced boost blob still waits for its own acknowledged cadence slot');
    await network.sync.flushUpdates();
    assert.equal(h.isBoostReceiptHandled(first.data, first.id, 1), true);
});

test('nuke protection is one second from acceptance and cannot shorten an existing six-second shield', () => {
    const h = harness({ session: true, names: boostNames });
    const network = attachGameplaySync(h, memberA);
    const nuke = boostReceipt(h, { payloadKind: PAYLOAD_KIND.NUKE });
    seedBoostSession(h, network, [nuke]);
    h.applyBoostReceipt(nuke, 1);
    assert.equal(h.game.ship.boostState.shieldUntil, 2000);
    h.game.ship.boostState.shieldUntil = 7000;
    h.applyBoostReceipt(nuke, 1);
    assert.equal(h.game.ship.boostState.shieldUntil, 7000);
});

test('boost activation requires authorized live disposition, exact collecting Ship/life and no predicted death hold', () => {
    const h = harness({ session: true, names: boostNames });
    const network = attachGameplaySync(h, memberA);
    const receipt = boostReceipt(h);
    seedBoostSession(h, network, [receipt]);
    for (const disposition of [undefined, 0, 2]) assert.equal(h.applyBoostReceipt(receipt, disposition), false);
    assert.equal(h.applyBoostReceipt(receipt, 1, true), false);
    h.game.ship.deathHold = { hitCount: 1 };
    assert.equal(h.applyBoostReceipt(receipt, 1), false);
    h.game.ship.deathHold = null;
    for (const change of [{ shipId: shipB }, { participantId: B }, { shipLifeId: id(250) }]) {
        assert.equal(h.applyBoostReceipt({ ...receipt, data: { ...receipt.data, ...change } }, 1), false);
    }
    h.game.lives = 0;
    assert.equal(h.applyBoostReceipt(receipt, 1), false);
    h.game.lives = 3;
    h.game.ship.resetLife();
    assert.equal(h.applyBoostReceipt(receipt, 1), false);
    assert.equal(h.game.ship.boostState.shieldUntil, 0);
    assert.equal(h.game.ship.boostState.rapidFireUntil, 0);
});

test('optimistic boost writes and new-life writes cannot retire receipts before durable deadline dominance', async () => {
    const h = harness({ session: true, names: boostNames });
    const network = attachGameplaySync(h, memberA);
    const receipt = boostReceipt(h);
    seedBoostSession(h, network, [receipt]);
    network.transport.acknowledge = false;
    h.applyBoostReceipt(receipt, 1);
    await network.sync.flushUpdates();
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, undefined), false);
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), false);
    h.game.ship.resetLife();
    h.syncLocalShipBoosts();
    await network.sync.flushUpdates();
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), false,
        'an optimistic new token is not authoritative obsolescence');
    network.transport.acknowledge = true;
    h.syncLocalShipBoosts();
    await network.sync.flushUpdates();
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), true,
        'an accepted new life makes the old receipt obsolete without activating it');
});

test('a locally hidden collecting Ship is not authoritatively absent after a rejected delete', async () => {
    const h = harness({ session: true, names: boostNames });
    const network = attachGameplaySync(h, memberA);
    const receipt = boostReceipt(h);
    seedBoostSession(h, network, [receipt]);
    let resolveDelete;
    network.client.deleteObject = () => new Promise(resolve => { resolveDelete = resolve; });
    const deleting = network.sync.deleteObject(shipA);
    assert.equal(network.sync.getObject(shipA), undefined);
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), false);
    resolveDelete({ success: false });
    assert.equal(await deleting, false);
    await network.sync.triggerReconciliation();
    assert.ok(network.sync.getObject(shipA));
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), false);
});

test('contact claims carry and validate the accepted collecting life, not just identity or invulnerability revision', async () => {
    const h = harness({
        session: true,
        names: [
            'buildGameContactClaim', 'isGameContactClaimEligible', 'buildActivationReceipt',
            'gameEffectTouchesShip', 'getShipHullVerticesAt', 'polygonsTouch',
        ],
    });
    const network = attachGameplaySync(h, memberA);
    seedBoostSession(h, network);
    const pickup = {
        id: id(260), ownerMemberId: memberB, data: {
            ...h.createGameEffectData(GAME_EFFECT_KIND.PICKUP, PAYLOAD_KIND.SHIELD, id(261), null, 0.4, 0.5),
            startedAt: 1000, armedAt: 1000, expiresAt: 13_000,
        },
    };
    const claim = { id: id(262), ownerMemberId: memberA,
        data: h.buildGameContactClaim(pickup, h.game.ship, 2000) };
    assert.equal(claim.data.shipLifeId, h.game.ship.boostState.lifeId);
    assert.equal(h.isGameContactClaimEligible(pickup, claim, network.sync.getObject(shipA), 2000), true);
    const activation = h.buildActivationReceipt(pickup, claim, [], [], 2000);
    assert.equal(activation.shipLifeId, claim.data.shipLifeId);
    for (const change of [{ shipLifeId: id(263) }, { participantId: B }, { shipId: shipB }]) {
        assert.equal(h.isGameContactClaimEligible(pickup,
            { ...claim, data: { ...claim.data, ...change } }, network.sync.getObject(shipA), 2000), false);
    }
    h.game.ship.resetLife();
    claim.data = h.buildGameContactClaim(pickup, h.game.ship, 2000);
    network.sync.updateObject(shipA, h.game.ship.boostData());
    assert.equal(h.isGameContactClaimEligible(pickup, claim, network.sync.getObject(shipA), 2000), false,
        'local optimistic token changes cannot authorize a claim before acceptance');
    await network.sync.flushUpdates();
    assert.equal(h.isGameContactClaimEligible(pickup, claim, network.sync.getObject(shipA), 2000), true);
});

const effectMaintenanceNames = [
    ...boostNames, 'getGameEffectObjects', 'getProcessedGameEffects', 'updateGameEffects',
    'ensureOwnedGameEffectAnchor', 'replaceGameEffect', 'cleanupGameContactClaims',
    'applyHazardReceipt', 'isHazardReceiptHandled', 'applyOwnedBlastCommand', 'isBlastCommandComplete',
];
test('real receipt retirement waits for GS authorization plus accepted Ship deadline, not optimistic cleanup', async () => {
    const h = harness({ session: true, names: effectMaintenanceNames,
        globals: { reportMalformedGameStateLedgers: (...args) => assert.fail(args[1]) } });
    const network = attachGameplaySync(h, memberA);
    const receipt = boostReceipt(h, { owner: memberA });
    seedBoostSession(h, network, [receipt]);
    h.clock.server = 2000;
    network.transport.acknowledge = false;
    h.updateGameEffects(0);
    await network.sync.flushUpdates();
    assert.ok(network.sync.getObject(receipt.id));
    assert.equal(h.game.ship.boostState.shieldUntil, 7000);
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), false);
    network.transport.acknowledge = true;
    h.updateGameEffects(0);
    await network.sync.flushUpdates();
    h.updateGameEffects(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(network.sync.getObject(receipt.id), undefined);
    assert.equal(network.server.has(receipt.id), false);
    assert.equal(h.game.ship.boostState.shieldUntil, 7000);
});

test('nuke receipt also waits for fixed blast completion after the collector shield is durable', async () => {
    const h = harness({ session: true, names: effectMaintenanceNames,
        globals: { reportMalformedGameStateLedgers: (...args) => assert.fail(args[1]) } });
    const network = attachGameplaySync(h, memberA);
    const targetId = id(270);
    const asteroid = new h.Asteroid(0.4, 0.5, h.config.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
    const receipt = boostReceipt(h, { owner: memberA, payloadKind: PAYLOAD_KIND.NUKE });
    receipt.data.asteroidTargets = Wire.packCounterMap({ [targetId]: 1 });
    seedBoostSession(h, network, [receipt], [{
        id: targetId, ownerMemberId: memberB, creatorMemberId: memberB,
        scope: 'Session', schemaId: 2, version: 1, data: asteroid.toSyncData(),
    }]);
    h.clock.server = 2000;
    h.updateGameEffects(0);
    await network.sync.flushUpdates();
    assert.equal(h.isBoostReceiptHandled(receipt.data, receipt.id, 1), true);
    h.updateGameEffects(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(network.sync.getObject(receipt.id), 'an unacknowledged starting asteroid keeps the nuke receipt alive');
    network.server.delete(targetId);
    await network.sync.triggerReconciliation();
    h.updateGameEffects(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(network.sync.getObject(receipt.id), undefined);
});

test('spray uses the exact eight world-fixed lanes and two horizontal ninety-degree corridors', () => {
    const h = harness();
    const warning = h.createGameEffectData(GAME_EFFECT_KIND.SPRAY, PAYLOAD_KIND.SPRAY, id(120), null, 0.5, 0.5);
    const anchored = h.anchorGameEffectData(warning, 1000);
    assert.deepEqual([anchored.startedAt, anchored.armedAt, anchored.expiresAt], [1000, 2200, 4200]);
    const before = structuredClone(anchored);
    const projectiles = h.buildSprayProjectiles({ id: id(121), data: anchored });
    assert.equal(projectiles.length, 8);
    assert.deepEqual(projectiles.map(data => Math.round(data.angle * 180 / Math.PI)),
        [45, 75, 105, 135, 225, 255, 285, 315]);
    for (const projectile of projectiles) {
        approx(Math.hypot(projectile.velocityX, projectile.velocityY), h.config.BULLET_SPEED * 0.4);
        assert.equal(projectile.startedAt, 2200);
        assert.equal(projectile.armedAt, 2200);
        assert.equal(projectile.expiresAt, 4200);
        const end = h.getGameEffectPose(projectile, 4200);
        approx(end.x, 0.5 + projectile.velocityX * 2);
        approx(end.y, 0.5 + projectile.velocityY * 2);
        assert.ok(!(projectile.angle < Math.PI / 4)
            && !(projectile.angle > 7 * Math.PI / 4)
            && !(projectile.angle > 3 * Math.PI / 4 && projectile.angle < 5 * Math.PI / 4));
    }
    assert.deepEqual(anchored, before, 'projectile construction cannot move the telegraph or its deadlines');
    const edge = { ...projectiles[0], x: 0.99, velocityX: 1 };
    assert.ok(h.getGameEffectPose(edge, 4200).x > 1, 'hostile projectiles never wrap');
});

test('late solo and migrated spray maintenance keeps original launch/expiry times and never revives expired barrages', async () => {
    for (const session of [false, true]) for (const now of [2200, 3500, 4200, 500_000]) {
        const h = harness({ session, names: effectMaintenanceNames });
        const data = h.anchorGameEffectData(
            h.createGameEffectData(GAME_EFFECT_KIND.SPRAY, PAYLOAD_KIND.SPRAY, id(124), null, 0.5, 0.5), 1000);
        const original = structuredClone(data);
        let network;
        if (session) {
            network = attachGameplaySync(h, memberA);
            network.seed([{
                id: id(125), ownerMemberId: memberA, creatorMemberId: memberB,
                scope: 'Session', schemaId: 5, version: 2, validAt: 1000,
                data: Schema.decode(Schema.get(5), Schema.encode(Schema.get(5), data)),
            }]);
            h.clock.server = now;
        } else {
            h.game.effects = [{ id: id(125), data }];
            h.game.simulationTimeMs = now;
        }
        const origin = session ? { ...network.sync.getObject(id(125)).data } : { ...data };
        h.updateGameEffects(0);
        if (session) await new Promise(resolve => setImmediate(resolve));
        const projectiles = session
            ? network.sync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT)
            : h.game.effects;
        assert.equal(projectiles.length, now < 4200 ? 8 : 0);
        for (const projectile of projectiles) {
            assert.equal(projectile.data.kind, GAME_EFFECT_KIND.HOSTILE_BULLET);
            assert.equal(projectile.data.startedAt, 2200);
            assert.equal(projectile.data.armedAt, 2200);
            assert.equal(projectile.data.expiresAt, 4200);
            const pose = h.getGameEffectPose(projectile.data, now);
            assert.equal(projectile.data.x, origin.x);
            assert.equal(projectile.data.y, origin.y);
            approx(pose.x, origin.x + projectile.data.velocityX * (now - 2200) / 1000);
            approx(pose.y, origin.y + projectile.data.velocityY * (now - 2200) / 1000);
        }
        assert.deepEqual(data, original);
    }
});

test('mine arms at exactly 1.5 seconds, ends at eight seconds, and accepted anchors never restart on migration', () => {
    const h = harness();
    const mine = h.createGameEffectData(GAME_EFFECT_KIND.MINE, PAYLOAD_KIND.MINE, id(122));
    const original = h.anchorGameEffectData(mine, 1000);
    assert.deepEqual([original.startedAt, original.armedAt, original.expiresAt], [1000, 2500, 9000]);
    assert.deepEqual(h.anchorGameEffectData(original, 500_000), original);
    const pickup = h.anchorGameEffectData(
        h.createGameEffectData(GAME_EFFECT_KIND.PICKUP, PAYLOAD_KIND.SHIELD, id(123)), 1000);
    assert.equal(pickup.expiresAt, 13_000);
});

test('actual HUD coalesces level banners for 1.5 seconds and updates boost text only at integer changes', () => {
    const writes = [];
    const clock = { wall: 0 };
    const hudCache = {};
    const element = name => new Proxy({
        hidden: true, textContent: '', disabled: false,
        style: new Proxy({}, { set(target, key, value) {
            writes.push([name, `style.${String(key)}`, value]);
            target[key] = value;
            return true;
        } }),
        attributes: {},
        setAttribute(key, value) {
            writes.push([name, key, value]);
            this.attributes[key] = value;
        },
        removeAttribute(key) {
            writes.push([name, key, null]);
            delete this.attributes[key];
        },
    }, { set(target, key, value) {
        writes.push([name, key, value]);
        target[key] = value;
        return true;
    } });
    const dom = Object.fromEntries([
        'xpHud', 'xpLevel', 'xpFraction', 'xpBar', 'xpFill', 'levelAnnouncement',
        'levelBanner', 'boostStatus', 'modifierCurrent', 'modifierChoice', 'modifierTitle',
        'modifierFocus', 'modifierSweep',
    ].map(name => [name, element(name)]));
    const h = harness({
        names: ['updateProgressionHud', 'updateProgressionControls', 'getLocalProgression'],
        globals: {
            ...dom, hudCache, performance: { now: () => clock.wall },
            fitProgressionHud: () => assert.fail('The no-refit path must not measure layout'),
        },
    });
    h.game.ship.boostState.shieldUntil = 6000;
    h.game.ship.boostState.rapidFireUntil = 6000;
    h.updateProgressionHud(false);
    assert.equal(dom.boostStatus.textContent, 'Shield 6s · Rapid fire 6s');
    assert.equal(dom.levelAnnouncement.textContent, '');
    const initialWrites = writes.length;
    for (let frame = 1; frame < 60; frame++) {
        h.game.simulationTimeMs = frame * 16;
        clock.wall = frame * 16;
        h.updateProgressionHud(false);
    }
    assert.equal(writes.length, initialWrites, 'unchanged integers, XP and choice do not write DOM or ARIA per tick');
    const ariaWrites = writes.filter(write => write[0] === 'xpBar').length;
    h.game.simulationTimeMs = 1000;
    h.updateProgressionHud(false);
    assert.equal(dom.boostStatus.textContent, 'Shield 5s · Rapid fire 5s');
    assert.equal(writes.filter(write => write[0] === 'xpBar').length, ariaWrites);
    clock.wall = 1000;
    h.game.soloXp = 20;
    h.updateProgressionHud(false);
    assert.equal(dom.levelBanner.textContent, 'Level 2 · +1 projectile');
    assert.equal(dom.levelBanner.hidden, false);
    assert.equal(hudCache.levelBannerUntil, 2500);
    clock.wall = 2499;
    h.game.soloXp = 120;
    h.updateProgressionHud(false);
    assert.equal(dom.levelBanner.textContent, 'Level 4 · +2 projectiles');
    assert.equal(dom.levelAnnouncement.textContent, 'Level 4. 4 shots per volley.');
    assert.equal(hudCache.levelBannerUntil, 3999);
    assert.equal(dom.modifierChoice.hidden, false);
    assert.equal(h.game.state, 'playing', 'the optional native choice never pauses simulation');
    clock.wall = 2500;
    h.updateProgressionHud(false);
    assert.equal(dom.levelBanner.hidden, false, 'an older level cannot expire the coalesced newer banner');
    clock.wall = 3998.999;
    h.updateProgressionHud(false);
    assert.equal(dom.levelBanner.hidden, false);
    clock.wall = 3999;
    h.updateProgressionHud(false);
    assert.equal(dom.levelBanner.hidden, true);
    h.game.soloModifier = { consumedMilestone: 4, modifierKind: MODIFIER_KIND.FOCUS };
    h.updateProgressionHud(false);
    assert.equal(dom.modifierChoice.hidden, true);
    assert.equal(dom.modifierCurrent.textContent, 'FOCUS · faster / tighter');
    clock.wall += 100_000;
    h.updateProgressionHud(false);
    assert.equal(dom.boostStatus.textContent, 'Shield 5s · Rapid fire 5s',
        'the control reads solo simulation time, never advancing boost expiry from wall time');
    assert.equal(h.game.soloModifier.modifierKind, MODIFIER_KIND.FOCUS);
});

test('nuke clears only starting hazards inside radius while smart bomb includes all starting hazards', () => {
    const h = harness({ names: ['collectBlastTargets', 'normalizedDistance'] });
    const asteroids = [
        { id: id(130), data: { x: 0.5, y: 0.5 } },
        { id: id(131), data: { x: 0.75, y: 0.5 } },
        { id: id(132), data: { x: 0.7501, y: 0.5 } },
    ];
    const hazard = (number, kind, x) => ({
        id: id(number),
        data: { ...h.createGameEffectData(kind, PAYLOAD_KIND.NONE, id(number + 1000)), x, y: 0.5 },
    });
    const hazards = [
        hazard(133, GAME_EFFECT_KIND.MINE, 0.5),
        hazard(134, GAME_EFFECT_KIND.SPRAY, 0.75),
        hazard(135, GAME_EFFECT_KIND.HOSTILE_BULLET, 0.8),
        hazard(136, GAME_EFFECT_KIND.PICKUP, 0.5),
    ];
    for (const payloadKind of [PAYLOAD_KIND.NUKE, PAYLOAD_KIND.SMART_BOMB]) {
        const blast = { payloadKind, x: 0.5, y: 0.5 };
        const targets = h.collectBlastTargets(blast, asteroids, hazards);
        assert.deepEqual(Object.keys(Wire.unpackCounterMap(targets.asteroidTargets)),
            asteroids.slice(0, payloadKind === PAYLOAD_KIND.NUKE ? 2 : 3).map(record => record.id));
        assert.deepEqual(Object.keys(Wire.unpackCounterMap(targets.hazardTargets)),
            hazards.slice(0, payloadKind === PAYLOAD_KIND.NUKE ? 2 : 3).map(record => record.id));
        asteroids.push({ id: id(140 + payloadKind), data: { x: 0.5, y: 0.5 } });
        hazards.push({ id: id(150 + payloadKind), data: { kind: GAME_EFFECT_KIND.MINE, x: 0.5, y: 0.5 } });
        assert.equal(Object.hasOwn(Wire.unpackCounterMap(targets.asteroidTargets), id(140 + payloadKind)), false);
        assert.equal(Object.hasOwn(Wire.unpackCounterMap(targets.hazardTargets), id(150 + payloadKind)), false);
        asteroids.pop();
        hazards.pop();
    }
});

test('nuke hazard targeting uses the current world-fixed moving pose instead of the launch pose', () => {
    const h = harness({ names: ['collectBlastTargets', 'normalizedDistance'] });
    const make = (number, x, velocityX) => ({
        id: id(number),
        data: {
            ...h.createGameEffectData(GAME_EFFECT_KIND.HOSTILE_BULLET, PAYLOAD_KIND.SPRAY, id(number + 1000)),
            x, y: 0.5, velocityX, velocityY: 0, startedAt: 1000, armedAt: 1000, expiresAt: 3000,
        },
    });
    const entering = make(190, 0.8, -0.1);
    const leaving = make(191, 0.5, 0.3);
    const before = structuredClone([entering, leaving]);
    const targets = h.collectBlastTargets({ payloadKind: PAYLOAD_KIND.NUKE, x: 0.5, y: 0.5 },
        [], [entering, leaving], 2000);
    assert.deepEqual(Wire.unpackCounterMap(targets.hazardTargets), { [entering.id]: 1 });
    assert.deepEqual([entering, leaving], before);
});
