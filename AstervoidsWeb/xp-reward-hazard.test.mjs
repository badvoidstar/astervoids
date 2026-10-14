import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
    loadInlineGameConstants, loadInlineGameFunctions,
} from './test-support/inline-game.mjs';
import { LARGE_XP_ENTRY_HEX } from './test-support/game-schema-fixture.mjs';
import { attachGameplaySync } from './test-support/gameplay-sync.mjs';

const require = createRequire(import.meta.url);
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const AstervoidsWireCodec = require('./wwwroot/js/astervoids-wire-codec.js');
const AstervoidsConfig = require('./wwwroot/js/game-config.js');
const AstervoidsCollision = require('./wwwroot/js/collision-geometry.js');
const AstervoidsFracture = require('./wwwroot/js/asteroid-fracture.js');
const constants = loadInlineGameConstants([
    'PROGRESSION', 'PAYLOAD_KIND', 'GAME_EFFECT_KIND', 'OBJECT_TYPES', 'TURN_CONTROL_MODE', 'CONFIG',
], { SHARED_CONFIG_DEFAULTS: AstervoidsConfig.SHARED_DEFAULTS });
const { PROGRESSION, PAYLOAD_KIND, GAME_EFFECT_KIND, OBJECT_TYPES } = constants;
const progression = loadInlineGameFunctions([
    'getLevelXpThreshold', 'getLevelForXp', 'getProgressionForXp',
    'buildVolleyPattern', 'chooseAsteroidLoadout',
], constants);
const id = number => `${number.toString(16).padStart(8, '0')}-1111-2222-3333-aabbccddeeff`;
const participantA = id(1);
const participantB = id(2);
const memberA = id(11);
const memberB = id(12);
const shipA = id(21);
const shipB = id(22);

test('effect artwork keeps vector glyphs without rasterized Canvas text', () => {
    const { drawGameEffects } = loadInlineGameFunctions(['drawGameEffects']);
    assert.match(drawGameEffects.toString(), /\bdrawPayloadGlyph\(/);
    assert.doesNotMatch(drawGameEffects.toString(), /\b(?:fillText|strokeText)\(/);
});

function approx(actual, expected, tolerance = 1e-10) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function baseHarness({ session = false, extraNames = [], globals = {} } = {}) {
    const config = { ...constants.CONFIG };
    const events = [];
    const objects = new Map();
    const clock = { server: 1000, solo: 0 };
    const game = {
        mode: session ? 'session' : 'solo', state: 'playing', previousState: null,
        score: 0, lives: 3, wave: 1, speedMultiplier: 1, waveDelayTimer: 0,
        soloXp: 0, simulationTimeMs: 0, leaderboardRun: null,
        ship: null, astervoids: [], bullets: [], effects: [],
        multiplayer: {
            myShipObjectId: session ? shipA : null,
            gameStateObjectId: session ? id(31) : null,
            processedPendingBullets: new Set(), remoteShips: new Map(),
            observedScoreLifeAwardCount: 0,
            contactClaims: new Map(), effectMutations: new Set(), effectAnchors: new Map(),
        },
    };
    const sessionClient = {
        getCurrentMember: () => ({ id: memberA, role: 'Server' }),
        getCurrentSession: () => ({ id: id(30), members: [{ id: memberA }, { id: memberB }] }),
        getParticipantId: () => participantA,
        getParticipantIdentity: () => ({ id: participantA, tag: 'Pilot_1' }),
        getSessionEpoch: () => 1,
    };
    const objectSync = {
        getObject: objectId => objects.get(objectId),
        getObjectByType: type => [...objects.values()].find(object => object.data.type === type),
        getObjectsByType: type => [...objects.values()].filter(object => object.data.type === type),
        updateObject: (...args) => events.push(['update', ...args]),
        deleteObject: async objectId => { objects.delete(objectId); events.push(['delete', objectId]); },
        isDataConfirmed: () => false,
    };
    const production = loadInlineGameFunctions([
        'ShipInvulnerability', 'Ship', 'Asteroid', 'Bullet', 'assignDefined',
        'getReferenceDimension', 'fromNormalizedX', 'fromNormalizedY', 'fromNormalizedSize',
        'sizeToNormalizedX', 'sizeToNormalizedY',
        'velocityToNormalizedDeltaX', 'velocityToNormalizedDeltaY',
        'wrapNormalized', 'wrapMarginX', 'wrapMarginY',
        'normalizeTurnControlMode', 'getShipTurnSpeed', 'rampInputToward',
        ...extraNames,
    ], {
        ...constants, ...progression, CONFIG: config, game, GuidUtils,
        AstervoidsWireCodec, AstervoidsCollision, AstervoidsFracture,
        pointInPolygon: AstervoidsCollision.pointInPolygon,
        crypto: { randomUUID },
        randomRange: () => 0,
        getGameWidth: () => 1000, getGameHeight: () => 1000,
        getEffectiveAsteroidAspectScales: () => ({ speedScale: 1, radiusScale: 1 }),
        isSessionMode: () => game.mode === 'session',
        isDeterministicMode: () => true,
        isGameOver: () => game.state === 'gameover' || game.lives <= 0,
        isGameStateOwner: () => session,
        isLobbySpectating: () => false,
        RemoteObjects: {
            clock: { offsetInitialized: true }, isClockOffsetInitialized: () => true,
            serverNowMs: () => clock.server,
        },
        SessionClient: sessionClient,
        ObjectSync: objectSync,
        AudioSystem: {
            init() {}, resume() {},
            playFire: () => events.push(['fire']),
            playExplosion: (...args) => events.push(['explosion', ...args]),
            playShipExplosion: () => events.push(['ship-explosion']),
            thrustSound: { start() {}, stop() {} },
            beat: { start() {}, stop() {} },
        },
        CollisionEffects: {
            startAsteroidHit: (...args) => events.push(['asteroid-cue', ...args]),
            startShipHit: (...args) => events.push(['ship-cue', ...args]),
            resolveBullet() {},
        },
        updateHUD() {}, publishDebugMetrics() {},
        announceExtraLifeAward: () => events.push(['extra-life']),
        countExtraLivesForScore: AstervoidsConfig.countExtraLivesForScore,
        _error: (...args) => assert.fail(args.join(' ')),
        _warn: (...args) => events.push(['warning', ...args]),
        ...globals,
    });
    game.ship = new production.Ship(0.35, 0.5, 2);
    Object.assign(game.ship, {
        angle: 0, memberId: memberA, participantId: participantA, participantTag: 'Pilot_1',
        syncObjectId: session ? shipA : null,
    });
    return { ...production, game, config, events, objects, clock, objectSync, sessionClient };
}

test('XP thresholds are cumulative and overflow carries through every boundary', () => {
    assert.equal(PROGRESSION.XP_PER_ASTEROID, 10);
    const { getLevelXpThreshold, getLevelForXp, getProgressionForXp } = progression;
    assert.deepEqual([1, 2, 3, 4, 5].map(getLevelXpThreshold), [0, 20, 60, 120, 200]);
    for (const level of [2, 3, 4, 5, 12, 100, 10_000, 1_000_000]) {
        const threshold = getLevelXpThreshold(level);
        assert.equal(getLevelForXp(threshold - 1), level - 1);
        assert.equal(getLevelForXp(threshold), level);
        assert.equal(getLevelForXp(threshold + 1), level);
        assert.equal(getLevelXpThreshold(level + 1) - threshold, 20 * level);
    }
    assert.deepEqual(getProgressionForXp(70), {
        xp: 70, level: 3, currentXp: 10, requiredXp: 60, nextLevelXp: 120, fraction: 1 / 6,
    });
    assert.deepEqual(getProgressionForXp(0), {
        xp: 0, level: 1, currentXp: 0, requiredXp: 20, nextLevelXp: 20, fraction: 0,
    });
    for (const xp of [0x100000001, Number.MAX_SAFE_INTEGER]) {
        const result = getProgressionForXp(xp);
        assert.ok(result.level > 10, 'progression has no old shot-count plateau');
        assert.equal(result.xp, xp);
        assert.ok(getLevelXpThreshold(result.level) <= xp);
        assert.ok(getLevelXpThreshold(result.level + 1) > xp);
        assert.ok(result.fraction >= 0 && result.fraction < 1);
    }
});

test('XP helpers visibly reject invalid numeric inputs rather than fabricate level one', () => {
    for (const xp of [-1, 0.5, NaN, Infinity, -Infinity, '20', undefined, null,
        Number.MAX_SAFE_INTEGER + 1, 20n]) {
        assert.throws(() => progression.getLevelForXp(xp), RangeError);
        assert.throws(() => progression.getProgressionForXp(xp), RangeError);
    }
    for (const level of [0, -1, 1.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => progression.getLevelXpThreshold(level), RangeError);
        assert.throws(() => progression.buildVolleyPattern(level), RangeError);
    }
});

test('XP maps normalize and sort GUIDs while preserving f64 safe integers above uint32', () => {
    const first = '00112233-4455-6677-8899-aabbccddeeff';
    const second = '11223344-5566-7788-99aa-bbccddeeff00';
    const input = Object.freeze({ [second.toUpperCase()]: Number.MAX_SAFE_INTEGER, [first]: 0x100000001 });
    const bytes = AstervoidsWireCodec.packXpMap(input);
    assert.equal(bytes.length, 48);
    assert.equal(Buffer.from(bytes.subarray(0, 24)).toString('hex'), LARGE_XP_ENTRY_HEX);
    assert.deepEqual(AstervoidsWireCodec.unpackXpMap(bytes), {
        [first]: 0x100000001, [second]: Number.MAX_SAFE_INTEGER,
    });
    const padded = new Uint8Array(bytes.length + 10);
    padded.set(bytes, 7);
    assert.deepEqual(AstervoidsWireCodec.unpackXpMap(padded.subarray(7, 7 + bytes.length)),
        AstervoidsWireCodec.unpackXpMap(bytes), 'decode must honor byteOffset');
    assert.deepEqual(AstervoidsWireCodec.packXpMap({}), new Uint8Array());
    assert.deepEqual(AstervoidsWireCodec.unpackXpMap(new Uint8Array()), {});
});

test('XP maps reject invalid GUIDs, duplicate normalized IDs, and unsafe or nonnumeric values', () => {
    for (const invalid of ['bad', '', '00112233445566778899aabbccddeeff', `${participantA} `]) {
        assert.throws(() => AstervoidsWireCodec.packXpMap({ [invalid]: 0 }), TypeError);
    }
    assert.throws(() => AstervoidsWireCodec.packXpMap({
        [participantA]: 1, [participantA.toUpperCase()]: 2,
    }), /duplicate/i);
    for (const value of [-1, 0.1, NaN, Infinity, '10', null, undefined,
        Number.MAX_SAFE_INTEGER + 1, 1n]) {
        assert.throws(() => AstervoidsWireCodec.packXpMap({ [participantA]: value }), RangeError);
    }
    for (const map of [[], new Uint8Array(), 1, 'xp', () => {}]) {
        assert.throws(() => AstervoidsWireCodec.packXpMap(map), TypeError);
    }
});

test('packed XP corruption is rejected without truncation, uint32 coercion, or silent map reset', () => {
    const valid = AstervoidsWireCodec.packXpMap({ [participantA]: 10, [participantB]: 20 });
    for (const value of [[], {}, valid.subarray(0, 47), new Uint8Array([1])]) {
        assert.throws(() => AstervoidsWireCodec.unpackXpMap(value));
    }
    const duplicate = new Uint8Array(valid);
    duplicate.set(duplicate.subarray(0, 16), 24);
    assert.throws(() => AstervoidsWireCodec.unpackXpMap(duplicate), /distinct|duplicate/i);
    const reversed = new Uint8Array(valid.length);
    reversed.set(valid.subarray(24), 0);
    reversed.set(valid.subarray(0, 24), 24);
    assert.throws(() => AstervoidsWireCodec.unpackXpMap(reversed), /sorted/i);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const malformed = new Uint8Array(valid);
        new DataView(malformed.buffer).setFloat64(16, value, true);
        assert.throws(() => AstervoidsWireCodec.unpackXpMap(malformed), RangeError);
    }
});

test('volleys are exactly level-sized, centered parallel at 1-3, and symmetric fan at 4+', () => {
    for (const level of [1, 2, 3, 4, 5, 10, 12, 32, 100]) {
        const lanes = progression.buildVolleyPattern(level);
        assert.equal(lanes.length, level);
        for (let index = 0; index < level; index++) {
            approx(lanes[index].angleOffset, -lanes[level - 1 - index].angleOffset);
            approx(lanes[index].lateralOffset, -lanes[level - 1 - index].lateralOffset);
        }
        if (level <= 3) {
            assert.deepEqual(lanes.map(lane => lane.angleOffset), Array(level).fill(0));
            assert.deepEqual(lanes.map(lane => lane.lateralOffset),
                Array.from({ length: level }, (_, index) => index - (level - 1) / 2));
        } else {
            const spread = Math.min(90, 24 + 8 * (level - 4)) * Math.PI / 180;
            approx(lanes.at(-1).angleOffset - lanes[0].angleOffset, spread);
            assert.ok(lanes.every(lane => lane.lateralOffset === 0));
        }
    }
});

test('wave originals follow exact level armor bands and every armored payload distribution', () => {
    for (const [level, expected] of [
        [1, [1000, 0, 0]], [3, [1000, 0, 0]],
        [4, [800, 200, 0]], [6, [800, 200, 0]],
        [7, [700, 200, 100]], [100, [700, 200, 100]],
    ]) {
        const counts = [0, 0, 0];
        for (let index = 0; index < 1000; index++) {
            const loadout = progression.chooseAsteroidLoadout(level, (index + 0.5) / 1000, 0.25);
            counts[loadout.maxHits - 1]++;
            assert.equal(loadout.hitsRemaining, loadout.maxHits);
            assert.equal(loadout.payloadKind, loadout.maxHits === 1 ? PAYLOAD_KIND.NONE : PAYLOAD_KIND.LEVELUP);
        }
        assert.deepEqual(counts, expected, `level ${level}`);
    }
    const payloads = Array(6).fill(0);
    for (let index = 0; index < 1000; index++) {
        const loadout = progression.chooseAsteroidLoadout(7, 0.95, (index + 0.5) / 1000);
        payloads[loadout.payloadKind - 1]++;
    }
    assert.deepEqual(payloads, [200, 200, 200, 200, 100, 100]);
    assert.equal(progression.chooseAsteroidLoadout(4, 0.8, 0).maxHits, 2);
    assert.equal(progression.chooseAsteroidLoadout(7, 0.7, 0).maxHits, 2);
    assert.equal(progression.chooseAsteroidLoadout(7, 0.9, 0).maxHits, 3);
});

test('real Ship.shoot preserves speed, lifetime, controls, and one cooldown for complete high-level volleys', () => {
    for (const level of [1, 2, 3, 4, 12, 32]) {
        const h = baseHarness({ session: true });
        const ship = h.game.ship;
        const controls = {
            turnTarget: ship.turnTarget, thrustInput: ship.thrustInput, brakeInput: ship.brakeInput,
        };
        const shots = ship.shoot(level);
        assert.equal(shots.length, level);
        assert.equal(ship.shootCooldown, h.config.SHOOT_COOLDOWN);
        assert.equal(h.events.filter(event => event[0] === 'fire').length, 1);
        assert.equal(ship.shoot(level), null, 'cooldown never emits a partial volley');
        assert.deepEqual({
            turnTarget: ship.turnTarget, thrustInput: ship.thrustInput, brakeInput: ship.brakeInput,
        }, controls);
        assert.equal(new Set(shots.map(shot => shot.damageId)).size, level);
        for (const shot of shots) {
            approx(Math.hypot(shot.velocityX, shot.velocityY), h.config.BULLET_SPEED);
            assert.equal(shot.lifetime, h.config.BULLET_LIFETIME);
            assert.equal(shot.ownerMemberId, memberA);
            assert.equal(shot.participantId, participantA);
            assert.equal(shot.participantTag, 'Pilot_1');
            assert.equal(shot.shipId, shipA);
            assert.equal(shot.syncObjectId, null);
            assert.ok(GuidUtils.isGuid(shot.damageId), 'impact identity exists before asynchronous create');
        }
        if (level <= 3) {
            assert.equal(new Set(shots.map(shot => shot.y)).size, level);
            assert.ok(shots.every(shot => shot.velocityY === 0));
            approx(shots.reduce((sum, shot) => sum + shot.y, 0) / level, ship.y);
        } else {
            approx(shots[0].velocityY, -shots.at(-1).velocityY);
            assert.ok(shots.every(shot => shot.x === shots[0].x && shot.y === shots[0].y));
        }
        ship.memberId = memberB;
        ship.participantId = participantB;
        assert.ok(shots.every(shot => shot.participantId === participantA && shot.ownerMemberId === memberA));
    }
});

test('armor damage and ship hazard receipts survive production serializers without becoming pose traffic', () => {
    const h = baseHarness({ session: true });
    const asteroid = new h.Asteroid(0.5, 0.5, 0.04, 0, 0, 123);
    Object.assign(asteroid, {
        maxHits: 3, hitsRemaining: 2, payloadKind: PAYLOAD_KIND.SPRAY,
        processedDamage: { [id(41)]: 1 },
        _processedDamageBytes: AstervoidsWireCodec.packCounterMap({ [id(41)]: 1 }),
    });
    const data = asteroid.toSyncData();
    const copy = h.Asteroid.fromSyncData(data);
    assert.equal(copy.maxHits, 3);
    assert.equal(copy.hitsRemaining, 2);
    assert.equal(copy.payloadKind, PAYLOAD_KIND.SPRAY);
    assert.deepEqual(copy.processedDamage, { [id(41)]: 1 });
    assert.deepEqual(copy.toDamageData(), asteroid.toDamageData());
    for (const field of ['processedDamage', 'payloadKind', 'hitsRemaining', 'maxHits']) {
        assert.equal(Object.hasOwn(asteroid.toUpdateData(), field), false, field);
    }
    const child = new h.Asteroid(0.5, 0.5, 0.02, 0, 0, 123);
    assert.equal(child.maxHits, 1);
    assert.equal(child.hitsRemaining, 1);
    assert.equal(child.payloadKind, PAYLOAD_KIND.NONE);
    h.game.ship.handledHazards = { [id(42)]: 1 };
    const shipData = h.game.ship.toSyncData();
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(shipData.handledHazards), { [id(42)]: 1 });
    const replacement = new h.Ship(0.5, 0.5);
    replacement.fromSyncData(shipData);
    assert.deepEqual(replacement.handledHazards, h.game.ship.handledHazards);
    assert.equal(Object.hasOwn(shipData, 'xp'), false, 'personal XP never lives on a disposable ship');
});

test('independent impact GUID and attribution are fixed before either asynchronous bullet create resolves', async () => {
    const pending = [];
    const h = baseHarness({
        session: true, extraNames: ['createSyncedBullet'],
        globals: {
            ObjectSync: {
                createObject: (data, scope, owner, alive) => {
                    assert.equal(scope, 'Member');
                    assert.equal(owner, null);
                    assert.equal(alive(), true);
                    return new Promise(resolve => pending.push({ data, resolve }));
                },
            },
        },
    });
    const shots = h.game.ship.shoot(2);
    h.game.bullets.push(...shots);
    const creating = shots.map(shot => h.createSyncedBullet(shot));
    assert.equal(pending.length, 2);
    assert.notEqual(pending[0].data.damageId, pending[1].data.damageId);
    assert.ok(pending.every(({ data }) => data.participantId === participantA
        && data.shipId === shipA && GuidUtils.isGuid(data.damageId)));
    pending[1].resolve({ id: id(52) });
    pending[0].resolve({ id: id(51) });
    await Promise.all(creating);
    assert.equal(shots[0].syncObjectId, id(51));
    assert.equal(shots[1].syncObjectId, id(52));
    assert.equal(shots[0].damageId, pending[0].data.damageId,
        'damage identity does not change to the transport object ID');
});

const { calculateGameState } = loadInlineGameFunctions(['calculateGameState'], {
    ...constants, ...progression, GuidUtils, AstervoidsWireCodec,
    countExtraLivesForScore: AstervoidsConfig.countExtraLivesForScore,
});

function fullLedgers(overrides = {}) {
    return {
        processedHits: {}, processedScores: {},
        countedParticipants: { [participantA]: 1, [participantB]: 1 },
        participantScores: { [participantA]: 0, [participantB]: 0 },
        participantNumbers: { [participantA]: 1, [participantB]: 2 },
        participantTags: { [participantA]: 'Pilot_1', [participantB]: 'Pilot_2' },
        participantXp: { [participantA]: 0, [participantB]: 0 }, processedEffects: {},
        ...overrides,
    };
}

function calculate({ persisted = {}, ledgers = fullLedgers(), ships = [], effects = [], retired = [] } = {}) {
    return calculateGameState({
        lives: 3, groupScore: 0, peakShipCount: 2, state: 'playing',
        ...persisted,
    }, ledgers, ships, {
        lives: 3, state: 'playing', observedScoreLifeAwardCount: 0,
    }, 0, effects, retired);
}

function calculateAgain(previous, { ships = [], effects = [] } = {}) {
    return calculate({ persisted: previous, ledgers: fullLedgers(previous), ships, effects });
}

function receipt(number, {
    kind = GAME_EFFECT_KIND.BREAK_RECEIPT, participantId = participantA,
    points = 100, payloadKind = PAYLOAD_KIND.NONE, sourceId = id(number + 1000),
} = {}) {
    return { id: id(number), data: {
        type: OBJECT_TYPES.GAME_EFFECT, kind, participantId, participantTag: 'Pilot_1',
        points, payloadKind, sourceId,
    } };
}

test('personal XP is a per-break ledger, never a proxy for score, hits, or a disposable ship', () => {
    const xp = Object.freeze({ [participantA]: 70, [participantB]: 0 });
    const first = calculate({
        ledgers: fullLedgers({ participantXp: xp }),
        ships: [{ id: shipA, data: {
            type: OBJECT_TYPES.SHIP, participantId: participantA, participantTag: 'Pilot_1',
            score: 9876, hitCount: 1,
        } }],
    });
    assert.equal(first.groupScore, 9876);
    assert.equal(first.lives, 2);
    assert.deepEqual(first.participantXp, xp, 'score and a nonbreaking damage counter earn zero XP');
    assert.notEqual(first.participantXp, xp);
    const departed = calculateAgain(first);
    const rejoined = calculateAgain(departed, {
        ships: [{ id: shipB, data: {
            type: OBJECT_TYPES.SHIP, participantId: participantA.toUpperCase(), score: 0, hitCount: 0,
        } }],
    });
    assert.equal(rejoined.participantXp[participantA], 70);
    assert.equal(rejoined.participantNumbers[participantA], first.participantNumbers[participantA]);
    assert.equal(rejoined.lives, 2, 'rejoin never repays an entry life');
    assert.equal(progression.getLevelForXp(rejoined.participantXp[participantA]), 3);
});

test('each original, fragment, and blast break earns ten XP and its existing points once', () => {
    const effects = [
        receipt(101, { points: 20 }), receipt(102, { points: 50 }), receipt(103, { points: 100 }),
    ];
    const duplicate = { ...effects[1], id: effects[1].id.toUpperCase() };
    const first = calculate({ effects: [...effects, duplicate] });
    assert.equal(first.participantXp[participantA], 30);
    assert.equal(first.groupScore, 170);
    assert.equal(first.participantScores[participantA], 170);
    assert.deepEqual(first.processedEffects, Object.fromEntries(effects.map(effect => [effect.id, 1])));
    for (const ships of [[], [{ id: shipB, data: { participantId: participantA, score: 0, hitCount: 0 } }]]) {
        const migrated = calculateAgain(first, { ships, effects: [...effects].reverse() });
        assert.equal(migrated.participantXp[participantA], 30);
        assert.equal(migrated.groupScore, 170);
        assert.deepEqual(migrated.processedEffects, first.processedEffects);
    }
});

test('retired receipt acknowledgements compact without undoing XP, points, lives or replaying stale inputs', () => {
    const broken = receipt(140, { points: 100 });
    const life = receipt(141, {
        kind: GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payloadKind: PAYLOAD_KIND.EXTRA_LIFE, points: 0,
    });
    const active = receipt(142, {
        kind: GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payloadKind: PAYLOAD_KIND.NUKE, points: 0,
    });
    const first = calculate({ effects: [broken, life, active] });
    assert.equal(first.participantXp[participantA], 10);
    assert.equal(first.groupScore, 100);
    assert.equal(first.lives, 4);
    const retired = [broken.id, life.id];
    const compacted = calculate({
        persisted: first, ledgers: fullLedgers(first), effects: [broken, life, active], retired,
    });
    assert.deepEqual(compacted.processedEffects, { [active.id]: 1 },
        'active blast authorization is retained until target acknowledgements and receipt deletion');
    assert.equal(compacted.participantXp[participantA], 10);
    assert.equal(compacted.participantScores[participantA], 100);
    assert.equal(compacted.groupScore, 100);
    assert.equal(compacted.lives, 4);
    assert.deepEqual(first.processedEffects, { [broken.id]: 1, [life.id]: 1, [active.id]: 1 },
        'compaction is pure and cannot change a previously published ledger');
});

test('multiple browsers of one normalized participant share a personal run but not another identity XP', () => {
    const first = calculate({
        ledgers: fullLedgers({ participantXp: { [participantA]: 20, [participantB]: 200 } }),
        ships: [
            { id: shipA, data: { participantId: participantA, score: 0 } },
            { id: shipB, data: { participantId: participantA.toUpperCase(), score: 0 } },
        ],
        effects: [
            receipt(104, { participantId: participantA }),
            receipt(105, { participantId: participantA.toUpperCase() }),
        ],
    });
    assert.deepEqual(first.participantXp, { [participantA]: 40, [participantB]: 200 });
    assert.equal(first.lives, 3);
    assert.deepEqual(calculateAgain(first).participantXp, first.participantXp,
        'departed participants remain in the session-scoped run');
});

test('GameState receipt validation rejects invalid attribution, points, and XP overflow visibly', () => {
    for (const invalid of [
        { ...receipt(106), id: 'not-a-guid' },
        receipt(106, { participantId: 'not-a-guid' }),
        receipt(106, { points: -1 }), receipt(106, { points: 1.5 }),
        receipt(106, { points: NaN }), receipt(106, { points: 0x100000000 }),
    ]) {
        assert.throws(() => calculate({ effects: [invalid] }));
    }
    assert.throws(() => calculate({
        ledgers: fullLedgers({ participantXp: { [participantA]: Number.MAX_SAFE_INTEGER - 9 } }),
        effects: [receipt(107)],
    }), /XP.*safe integer/i);
    const large = calculate({
        ledgers: fullLedgers({ participantXp: { [participantA]: 0x100000001, [participantB]: 0 } }),
        effects: [receipt(108)],
    });
    assert.equal(large.participantXp[participantA], 0x10000000b);
});

test('level-up pickups add exactly the remaining threshold, one level, without score or extra levels', () => {
    for (const [xp, expected] of [[0, 20], [19, 20], [20, 60], [59, 60], [75, 120], [199, 200]]) {
        const effect = receipt(109, {
            kind: GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payloadKind: PAYLOAD_KIND.LEVELUP, points: 0,
        });
        const next = calculate({
            ledgers: fullLedgers({ participantXp: { [participantA]: xp, [participantB]: 0 } }),
            effects: [effect],
        });
        assert.equal(next.participantXp[participantA], expected);
        assert.equal(progression.getLevelForXp(expected), progression.getLevelForXp(xp) + 1);
        assert.equal(next.groupScore, 0);
        assert.equal(next.lives, 3);
        assert.equal(calculateAgain(next, { effects: [effect] }).participantXp[participantA], expected);
    }
});

test('extra-life activation increments the existing shared pool once and never revives a terminal run', () => {
    const effect = receipt(110, {
        kind: GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payloadKind: PAYLOAD_KIND.EXTRA_LIFE, points: 0,
    });
    const next = calculate({ effects: [effect] });
    assert.equal(next.lives, 4);
    assert.equal(next.announcePowerupLifeAward, true);
    assert.equal(next.scoreLifeAwardCount, 0);
    assert.equal(next.participantXp[participantA], 0);
    assert.equal(calculateAgain(next, { effects: [effect] }).lives, 4);
    for (const payloadKind of [
        PAYLOAD_KIND.LEVELUP, PAYLOAD_KIND.EXTRA_LIFE, PAYLOAD_KIND.NUKE, PAYLOAD_KIND.SMART_BOMB,
    ]) {
        const terminal = calculate({
            persisted: { lives: 0, gameOverAt: 1000, terminalAt: 1750, terminalShipId: shipA },
            ledgers: fullLedgers({ participantXp: { [participantA]: 30, [participantB]: 0 } }),
            effects: [receipt(111, { kind: GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payloadKind, points: 0 })],
        });
        assert.equal(terminal.lives, 0);
        assert.equal(terminal.participantXp[participantA], 30);
        assert.equal(terminal.processedEffects[id(111)], 2, 'terminal receipt is bookkeeping, not a new command');
        assert.equal(terminal.terminalShipId, shipA);
    }
});

test('run-highest level includes retained participants and XP cache detects in-place same-version changes', () => {
    const record = { id: id(120), version: 1, data: {
        participantXp: AstervoidsWireCodec.packXpMap({ [participantA]: 20, [participantB]: 200 }),
    } };
    const errors = [];
    const functions = loadInlineGameFunctions([
        'getSessionXpLedger', 'getLocalProgression', 'getRunHighestLevel',
        'readGameStateLedger', 'gameStateLedgerMatches', 'gameStateCounterMapsEqual',
    ], {
        ...constants, ...progression, AstervoidsWireCodec, sessionXpViewCache: null,
        game: { soloXp: 0 },
        isSessionMode: () => true,
        ObjectSync: { getObjectByType: () => record },
        SessionClient: { getParticipantId: () => participantA.toUpperCase() },
        reportMalformedGameStateLedgers: (...args) => errors.push(args),
    });
    assert.equal(functions.getLocalProgression().level, 2);
    assert.equal(functions.getRunHighestLevel(), 5, 'no live ship is required for retained run-highest');
    new DataView(record.data.participantXp.buffer).setFloat64(16, 120, true);
    assert.equal(functions.getLocalProgression().level, 4);
    assert.equal(record.version, 1);
    record.data.participantXp = new Uint8Array([1]);
    assert.equal(functions.getLocalProgression(), null);
    assert.equal(functions.getRunHighestLevel(), null);
    assert.equal(errors.length, 2, 'invalid XP is unavailable rather than silently reset');
});

function effectHarness(options = {}) {
    return baseHarness({
        ...options,
        extraNames: [
            'getAsteroidObjectId', 'getGameEffectObjects', 'getGameEffectNow',
            'createGameEffectData', 'getGameEffectTiming', 'anchorGameEffectData',
            'getGameEffectTimerData', 'ensureOwnedGameEffectAnchor', 'isGameEffectReady',
            'addSoloGameEffect', 'buildAsteroidBreakEffects',
            'collectBlastTargets', 'isHostileGameEffect', 'getGameEffectPose',
            'buildSprayProjectiles', 'normalizedDistance',
            ...(options.extraNames ?? []),
        ],
    });
}

test('every armored payload is predetermined and break creates one receipt plus a pickup or immediate hazard', () => {
    const h = effectHarness();
    for (const payloadKind of Object.values(PAYLOAD_KIND)) {
        const asteroid = new h.Asteroid(0.4, 0.6, 0.02, 0, 0, 123);
        Object.assign(asteroid, {
            payloadKind, maxHits: payloadKind ? 2 : 1, hitsRemaining: 0,
            processedDamage: { [id(130)]: 1 }, syncObjectId: id(140 + payloadKind),
        });
        const damage = {
            damageId: id(131), participantId: participantA.toUpperCase(),
            participantTag: 'Pilot_1', shipId: shipA,
        };
        const effects = h.buildAsteroidBreakEffects(asteroid, damage);
        assert.equal(effects.length, payloadKind === PAYLOAD_KIND.NONE ? 1 : 2);
        const [winner, payload] = effects;
        assert.equal(winner.kind, GAME_EFFECT_KIND.BREAK_RECEIPT);
        assert.equal(winner.points, asteroid.getPoints());
        assert.equal(winner.participantId, participantA);
        assert.equal(winner.claimId, damage.damageId);
        assert.equal(winner.sourceId, asteroid.syncObjectId);
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(winner.damageReceipts),
            { [id(130)]: 1, [id(131)]: 1 });
        if (payload) {
            assert.equal(payload.kind, payloadKind === PAYLOAD_KIND.MINE ? GAME_EFFECT_KIND.MINE
                : payloadKind === PAYLOAD_KIND.SPRAY ? GAME_EFFECT_KIND.SPRAY : GAME_EFFECT_KIND.PICKUP);
            assert.equal(payload.payloadKind, payloadKind);
            assert.equal(payload.sourceId, asteroid.syncObjectId);
            assert.equal(payload.participantId, null, 'a positive drop belongs to the eventual hull-contact winner');
            assert.equal(payload.velocityX, 0);
            assert.equal(payload.velocityY, 0);
        }
    }
});

test('effect deadlines use accepted validAt once and never reset on migration, retries, or a hidden owner', () => {
    const h = effectHarness({ session: true });
    h.game.multiplayer.effectAnchors = new Map();
    for (const [kind, armDelay, lifetime] of [
        [GAME_EFFECT_KIND.PICKUP, 0, 12000], [GAME_EFFECT_KIND.MINE, 1000, 8000],
        [GAME_EFFECT_KIND.SPRAY, 800, 2800], [GAME_EFFECT_KIND.HOSTILE_BULLET, 0, 2000],
    ]) {
        const initial = h.createGameEffectData(kind, PAYLOAD_KIND.NONE, id(150));
        const anchored = h.anchorGameEffectData(initial, 1000);
        assert.deepEqual(h.getGameEffectTimerData(anchored), {
            startedAt: 1000, armedAt: 1000 + armDelay, expiresAt: 1000 + lifetime,
        });
        assert.equal(h.anchorGameEffectData(anchored, 50_000), anchored);
        for (const invalid of [undefined, NaN, Infinity, 0, -1]) {
            assert.equal(h.anchorGameEffectData(initial, invalid), null);
        }
        const record = { id: id(160 + kind), data: initial, validAt: 1000, ownerMemberId: memberA };
        assert.equal(h.ensureOwnedGameEffectAnchor(record), false, 'unconfirmed deadlines are not executable');
        const first = h.events.at(-1)[2];
        record.validAt = 4000;
        h.clock.server = 20_000;
        assert.equal(h.ensureOwnedGameEffectAnchor(record), false);
        assert.deepEqual(h.events.at(-1)[2], first, 'retry uses the first accepted anchor, not current time');
        record.data = anchored;
        h.game.multiplayer.effectAnchors.clear();
        h.ensureOwnedGameEffectAnchor(record);
        assert.deepEqual(h.events.at(-1)[2], first, 'new owner adopts persisted deadlines unchanged');
    }
});

test('solo effects use simulation time, not wall time, so paused runs do not age a pickup or mine', () => {
    const h = effectHarness();
    h.game.effects = [];
    h.game.simulationTimeMs = 2000;
    for (const kind of [GAME_EFFECT_KIND.PICKUP, GAME_EFFECT_KIND.MINE, GAME_EFFECT_KIND.SPRAY]) {
        const effect = h.addSoloGameEffect(h.createGameEffectData(kind, PAYLOAD_KIND.NONE, id(170)));
        assert.equal(effect.data.startedAt, 2000);
        const before = h.getGameEffectTimerData(effect.data);
        h.game.state = 'paused';
        h.clock.server = 100_000;
        assert.equal(h.getGameEffectNow(), 2000);
        assert.deepEqual(h.getGameEffectTimerData(effect.data), before);
        h.game.state = 'playing';
    }
    h.game.mode = 'session';
    assert.equal(h.getGameEffectNow(), 100_000);
});

test('spray launches twelve radial 40-percent-speed no-wrap bullets on its original 0.8-second deadline', () => {
    const h = effectHarness();
    const record = { id: id(180), data: {
        kind: GAME_EFFECT_KIND.SPRAY, x: 0.98, y: 0.5, startedAt: 1000, armedAt: 1800, expiresAt: 3800,
    } };
    h.clock.server = 40_000;
    const bullets = h.buildSprayProjectiles(record);
    assert.equal(bullets.length, 12);
    for (let lane = 0; lane < bullets.length; lane++) {
        const bullet = bullets[lane];
        assert.equal(bullet.kind, GAME_EFFECT_KIND.HOSTILE_BULLET);
        assert.equal(bullet.sourceId, record.id);
        approx(Math.hypot(bullet.velocityX, bullet.velocityY), h.config.BULLET_SPEED * 0.4);
        approx(bullet.angle, lane * Math.PI * 2 / 12);
        assert.equal(bullet.startedAt, 1800);
        assert.equal(bullet.armedAt, 1800);
        assert.equal(bullet.expiresAt, 3800);
    }
    approx(h.getGameEffectPose(bullets[0], 2800).x, 1.38);
    approx(h.getGameEffectPose(bullets[0], 1800).x, 0.98);
    assert.ok(h.getGameEffectPose(bullets[0], 2800).x > 1, 'hostile bullets leave the viewport instead of wrapping');
});

test('nuke fixes its starting radius targets and smart bomb fixes all starting asteroids and existing hazards', () => {
    const h = effectHarness();
    const asteroids = [
        { id: id(190), data: { x: 0.5, y: 0.5, hitsRemaining: 3 } },
        { id: id(191), data: { x: 0.75, y: 0.5, hitsRemaining: 2 } },
        { id: id(192), data: { x: 0.7501, y: 0.5, hitsRemaining: 1 } },
    ];
    const hazards = [
        { id: id(193), data: { kind: GAME_EFFECT_KIND.MINE } },
        { id: id(194), data: { kind: GAME_EFFECT_KIND.SPRAY } },
        { id: id(195), data: { kind: GAME_EFFECT_KIND.HOSTILE_BULLET } },
        { id: id(196), data: { kind: GAME_EFFECT_KIND.PICKUP } },
    ];
    const nuke = h.collectBlastTargets({ payloadKind: PAYLOAD_KIND.NUKE, x: 0.5, y: 0.5 }, asteroids, hazards);
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(nuke.asteroidTargets), { [id(190)]: 1, [id(191)]: 1 });
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(nuke.hazardTargets), {});
    const smart = h.collectBlastTargets({ payloadKind: PAYLOAD_KIND.SMART_BOMB, x: 0.5, y: 0.5 }, asteroids, hazards);
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(smart.asteroidTargets),
        { [id(190)]: 1, [id(191)]: 1, [id(192)]: 1 });
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(smart.hazardTargets),
        { [id(193)]: 1, [id(194)]: 1, [id(195)]: 1 });
    asteroids.push({ id: id(197), data: { x: 0.5, y: 0.5 } });
    hazards.push({ id: id(198), data: { kind: GAME_EFFECT_KIND.MINE } });
    assert.equal(Object.hasOwn(AstervoidsWireCodec.unpackCounterMap(smart.asteroidTargets), id(197)), false);
    assert.equal(Object.hasOwn(AstervoidsWireCodec.unpackCounterMap(smart.hazardTargets), id(198)), false,
        'recursive children, loot and hazards are never retroactively enrolled');
});

function damageHarness(options = {}) {
    let h;
    h = effectHarness({
        ...options,
        extraNames: [
            'applyOwnedAsteroidDamage', 'applySoloAsteroidDamage', 'awardSoloAsteroidScore',
            'splitAsteroid', 'replaceSyncedAsteroid', 'computeDeflectionImpulse',
            'retireConfirmedPendingBullets', 'deleteSyncedBullet', 'syncLocalAstervoids',
            'handleShipHit', 'syncLocalShipHazards', 'getShipByMemberId',
            ...(options.extraNames ?? []),
        ],
        globals: {
            emitShipStateChanged: () => h.events.push(['ship-event']),
            predictFatalShipHit: () => false,
            deleteSyncedObject: objectId => h.objectSync.deleteObject(objectId),
            SendGate: { shouldSend: () => false },
            ...(options.globals ?? {}),
        },
    });
    if (options.session) h.network = attachGameplaySync(h, memberA);
    return h;
}

function rock(h, { number = 200, x = 0.5, y = 0.5, radius = 0.02, hits = 1, remaining = hits,
    payload = PAYLOAD_KIND.NONE, owner = memberA, processed = {} } = {}) {
    const asteroid = new h.Asteroid(x, y, radius, 0, 0, 123,
        Array.from({ length: 8 }, (_, index) => ({ angle: index * Math.PI / 4, distance: radius })));
    Object.assign(asteroid, {
        angle: 0, rotationSpeed: 0, maxHits: hits, hitsRemaining: remaining, payloadKind: payload,
        processedDamage: processed, _processedDamageBytes: AstervoidsWireCodec.packCounterMap(processed),
    });
    h.game.astervoids.push(asteroid);
    if (h.game.mode === 'session') {
        asteroid.syncObjectId = id(number);
        h.network.seed([{
            id: asteroid.syncObjectId, ownerMemberId: owner, creatorMemberId: owner,
            scope: 'Session', version: 1, schemaId: 2, data: asteroid.toSyncData(), validAt: 1000,
        }]);
    } else {
        asteroid.localObjectId = id(number);
    }
    return asteroid;
}

function impact(number, { participantId = participantA, shipId = shipA } = {}) {
    return { damageId: id(number), participantId, participantTag: 'Pilot_1', shipId };
}

test('solo armor consumes independent impacts but earns zero XP or points until the final break', () => {
    const h = damageHarness();
    const asteroid = rock(h, { hits: 3, payload: PAYLOAD_KIND.LEVELUP });
    const points = asteroid.getPoints();
    for (const [number, expected] of [[201, 2], [202, 1]]) {
        assert.equal(h.applySoloAsteroidDamage(asteroid, impact(number)), true);
        assert.equal(asteroid.hitsRemaining, expected);
        assert.equal(h.applySoloAsteroidDamage(asteroid, impact(number)), false);
        assert.equal(asteroid.hitsRemaining, expected);
        assert.equal(h.game.score, 0);
        assert.equal(h.game.soloXp, 0);
        assert.equal(h.game.effects.length, 0, 'nonbreaking armor never rolls or drops its payload');
    }
    assert.equal(h.applySoloAsteroidDamage(asteroid, impact(203)), true);
    assert.equal(h.game.score, points);
    assert.equal(h.game.soloXp, 10);
    assert.equal(h.game.astervoids.includes(asteroid), false);
    assert.equal(h.game.effects.length, 1);
    assert.equal(h.game.effects[0].data.kind, GAME_EFFECT_KIND.PICKUP);
    assert.equal(h.game.effects[0].data.payloadKind, PAYLOAD_KIND.LEVELUP);
    assert.equal(h.applySoloAsteroidDamage(asteroid, impact(204)), false, 'a competing late hit cannot repay the break');
    assert.equal(h.game.score, points);
    assert.equal(h.game.soloXp, 10);
});

test('owned armor HP and damage IDs retry outside motion gating and acknowledge without a reward', async () => {
    const h = damageHarness({ session: true });
    const asteroid = rock(h, { hits: 3, payload: PAYLOAD_KIND.MINE });
    h.network.transport.acknowledge = false;
    assert.equal(await h.applyOwnedAsteroidDamage(asteroid, impact(205)), true);
    assert.equal(await h.applyOwnedAsteroidDamage(asteroid, impact(205)), false);
    assert.equal(await h.applyOwnedAsteroidDamage(asteroid, impact(206)), true);
    assert.equal(asteroid.hitsRemaining, 1);
    assert.deepEqual(asteroid.processedDamage, { [id(205)]: 1, [id(206)]: 1 });
    assert.equal(h.objectSync.isDataConfirmed(asteroid.syncObjectId, asteroid.toDamageData()), false);
    assert.equal(h.network.server.get(asteroid.syncObjectId).data.hitsRemaining, 3);
    await h.objectSync.flushUpdates();
    h.network.transport.acknowledge = true;
    h.syncLocalAstervoids();
    await h.objectSync.flushUpdates();
    assert.equal(h.network.server.get(asteroid.syncObjectId).data.hitsRemaining, 1);
    assert.equal(h.objectSync.isDataConfirmed(asteroid.syncObjectId, asteroid.toDamageData()), true);
    assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 0);
    assert.equal(h.game.ship.score, 0, 'the old bullet self-credit path must not be reused');
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 0);
});

test('competing final impacts produce one atomic winner receipt, payload and normal children under one session owner', async () => {
    const h = damageHarness({ session: true });
    const asteroid = rock(h, {
        radius: 0.08, hits: 3, remaining: 1, payload: PAYLOAD_KIND.EXTRA_LIFE,
        processed: { [id(207)]: 1, [id(208)]: 1 },
    });
    let finish;
    h.network.transport.replacementGate = new Promise(resolve => { finish = resolve; });
    const winner = impact(209, { participantId: participantB, shipId: shipB });
    const winning = h.applyOwnedAsteroidDamage(asteroid, winner,
        { bulletAngle: 0, offsetN: 0, impactTorque: 0 }, memberB);
    assert.equal(asteroid.replacementInFlight, true);
    assert.equal(await h.applyOwnedAsteroidDamage(asteroid, impact(210)), false);
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
    finish();
    assert.equal(await winning, true);
    const created = [...h.network.server.values()];
    assert.ok(created.length >= 3, 'the actual fracture also creates surviving children');
    assert.ok(created.every(object => object.scope === 'Session' && object.ownerMemberId === memberB));
    assert.equal(h.objectSync.getObject(asteroid.syncObjectId), undefined);
    const effects = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT);
    const winners = effects.filter(effect => effect.data.kind === GAME_EFFECT_KIND.BREAK_RECEIPT);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].data.claimId, winner.damageId);
    assert.equal(winners[0].data.participantId, participantB);
    assert.equal(winners[0].data.points, asteroid.getPoints());
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(winners[0].data.damageReceipts),
        { [id(207)]: 1, [id(208)]: 1, [id(209)]: 1 });
    assert.equal(effects.filter(effect => effect.data.kind === GAME_EFFECT_KIND.PICKUP).length, 1);
    for (const child of h.objectSync.getObjectsByType(OBJECT_TYPES.ASTEROID)) {
        assert.equal(child.data.maxHits, 1);
        assert.equal(child.data.hitsRemaining, 1);
        assert.equal(child.data.payloadKind, PAYLOAD_KIND.NONE, 'fragments never inherit armor or loot');
    }
    const calculated = calculate({ effects });
    assert.equal(calculated.participantXp[participantA], 0);
    assert.equal(calculated.participantXp[participantB], 10);
    assert.equal(calculated.groupScore, asteroid.getPoints());
    assert.equal(h.game.ship.score, 0);
    assert.equal(calculateAgain(calculated, { effects }).groupScore, asteroid.getPoints());
});

test('a disappearing target or nonbreaking acknowledgement retires a pending bullet without XP or points', () => {
    for (const acknowledged of [false, true]) {
        const h = damageHarness({ session: true });
        const bullet = new h.Bullet(0.5, 0.5, 1, 0, 0, memberA, {
            participantId: participantA, shipId: shipA, participantTag: 'Pilot_1',
        });
        bullet.pendingHit = true;
        bullet.hitTargetId = id(211);
        h.game.bullets.push(bullet);
        if (acknowledged) {
            rock(h, { number: 211, hits: 3, remaining: 2, processed: { [bullet.damageId]: 1 } });
        }
        h.retireConfirmedPendingBullets(memberA);
        assert.equal(h.game.bullets.length, 0);
        assert.equal(h.game.ship.score, 0);
        assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 0);
        assert.equal(calculate({ effects: h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT) })
            .participantXp[participantA], 0);
    }
});

test('the production fire gate scales the ten-active-bullet budget and refuses every partial volley', () => {
    for (const level of [1, 2, 3, 12, 32]) {
        for (const room of [level, level - 1]) {
            const h = baseHarness({
                extraNames: ['handleInput', 'getLocalProgression'],
                globals: {
                    keys: {}, isAnalogControlSchemeEnabled: () => false,
                    getNeutralAnalogBrakeInput: () => 0,
                    input: { left: () => false, right: () => false, thrust: () => false,
                        brake: () => false, fire: () => true },
                },
            });
            h.game.soloXp = progression.getLevelXpThreshold(level);
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
            assert.equal(h.events.filter(event => event[0] === 'fire').length, room === level ? 1 : 0);
        }
    }
});

test('solo death keeps XP but actual new-game initialization resets guests and automation without a leaderboard run', async () => {
    const classes = { classList: { add() {}, remove() {} } };
    const h = damageHarness({
        extraNames: ['init'],
        globals: {
            adoptSoloSim() {}, spawnWave: async () => {},
            startScreen: classes, hudCache: {}, overlayCache: {},
        },
    });
    h.game.soloXp = 75;
    h.game.leaderboardRun = null;
    const ship = h.game.ship;
    assert.equal(h.handleShipHit(ship), false);
    assert.equal(h.game.lives, 2);
    assert.equal(h.game.soloXp, 75);
    assert.equal(progression.getLevelForXp(h.game.soloXp), 3);
    h.game.lives = 1;
    assert.equal(h.handleShipHit(ship), true);
    assert.equal(h.game.soloXp, 75);
    h.game.simulationTimeMs = 1234;
    h.game.effects.push({ id: id(212), data: {} });
    assert.equal(await h.init(), true);
    assert.notEqual(h.game.ship, ship);
    assert.equal(h.game.soloXp, 0);
    assert.equal(h.game.simulationTimeMs, 0);
    assert.equal(h.game.effects.length, 0);
    assert.equal(h.game.leaderboardRun, null);
});

function contactHarness(options = {}) {
    return damageHarness({
        ...options,
        extraNames: [
            'getShipHullVerticesAt', 'polygonsTouch', 'gameEffectTouchesShip', 'findGameEffectContactTime',
            'buildGameContactClaim', 'createGameContactClaim',
            'isGameContactClaimEligible', 'chooseGameContactClaim', 'buildActivationReceipt',
            'replaceGameEffect', 'applyHazardReceipt', 'isHazardReceiptHandled',
            'applyOwnedBlastCommand', 'isBlastCommandComplete', 'getProcessedGameEffects',
            'activateSoloPickup', 'checkGameEffectContacts', 'cleanupGameContactClaims', 'updateGameEffects',
            ...(options.extraNames ?? []),
        ],
    });
}

function timedEffect(h, {
    number = 300, kind = GAME_EFFECT_KIND.PICKUP, payload = PAYLOAD_KIND.LEVELUP,
    x = h.game.ship.x, y = h.game.ship.y, start = 1000, owner = memberA,
} = {}) {
    const data = h.anchorGameEffectData(h.createGameEffectData(kind, payload, id(number + 1000), null, x, y), start);
    const record = {
        id: id(number), data, ownerMemberId: owner, creatorMemberId: owner,
        scope: 'Session', schemaId: 5, version: 1, validAt: start,
    };
    if (h.game.mode === 'session') h.network.seed([record]);
    else h.game.effects.push(record);
    return record;
}

function seedShip(h, { number = 21, participant = participantA, owner = memberA,
    revision = 0, x = h.game.ship.x, y = h.game.ship.y } = {}) {
    const data = {
        ...h.game.ship.toSyncData(), participantId: participant, memberId: owner,
        x, y, invulnerable: 0, invulnerabilityRevision: revision,
    };
    const record = { id: id(number), data, ownerMemberId: owner, creatorMemberId: owner,
        scope: 'Member', schemaId: 1, version: 1, validAt: 1000 };
    h.network.seed([record]);
    return record;
}

function contactClaim(h, record, {
    number = 310, participant = participantA, ship = shipA, owner = memberA,
    at = 1100, revision = 0, x = h.game.ship.x, y = h.game.ship.y,
} = {}) {
    return { id: id(number), ownerMemberId: owner, creatorMemberId: owner, scope: 'Member',
        schemaId: 6, version: 1, data: {
            type: OBJECT_TYPES.GAME_CLAIM, targetId: record.id,
            shipId: ship, participantId: participant, participantTag: 'Pilot_1',
            x, y, angle: h.game.ship.angle, claimedAt: at, invulnerabilityRevision: revision,
        } };
}

test('pickup collision uses the actual hull and diamond, not a permissive bounding-circle proxy', () => {
    const h = contactHarness();
    const ship = h.game.ship;
    const behind = h.createGameEffectData(GAME_EFFECT_KIND.PICKUP, PAYLOAD_KIND.LEVELUP,
        id(301), null, ship.x - h.config.SHIP_SIZE - PROGRESSION.PICKUP_RADIUS * 0.9, ship.y);
    assert.ok(Math.abs(ship.x - behind.x) < h.config.SHIP_SIZE + PROGRESSION.PICKUP_RADIUS);
    assert.equal(h.gameEffectTouchesShip(behind, ship, 1000), false);
    const tangent = { ...behind, x: ship.x + h.config.SHIP_SIZE + PROGRESSION.PICKUP_RADIUS };
    assert.equal(h.gameEffectTouchesShip(tangent, ship, 1000), true, 'actual hull tangency collects once');
    assert.equal(h.gameEffectTouchesShip({ ...behind, x: ship.x, y: ship.y }, ship, 1000), true);
});

test('solo hull pickup is consumed once for level-up and extra life without durable progression or new controls', () => {
    for (const payload of [PAYLOAD_KIND.LEVELUP, PAYLOAD_KIND.EXTRA_LIFE]) {
        const h = contactHarness();
        h.game.soloXp = 30;
        const effect = timedEffect(h, { payload });
        h.game.effectContactNowMs = 1100;
        h.game.effectContactPreviousMs = 1000;
        h.checkGameEffectContacts();
        assert.equal(h.game.effects.includes(effect), false);
        assert.equal(h.game.soloXp, payload === PAYLOAD_KIND.LEVELUP ? 60 : 30);
        assert.equal(h.game.lives, payload === PAYLOAD_KIND.EXTRA_LIFE ? 4 : 3);
        h.checkGameEffectContacts();
        assert.equal(h.game.soloXp, payload === PAYLOAD_KIND.LEVELUP ? 60 : 30);
        assert.equal(h.game.lives, payload === PAYLOAD_KIND.EXTRA_LIFE ? 4 : 3);
        assert.equal(h.game.score, 0);
        assert.equal(h.game.leaderboardRun, null);
    }
});

test('nuke ignores armor and smart bomb deals one hit only to their fixed starting targets, not children or fresh hazards', () => {
    for (const payload of [PAYLOAD_KIND.NUKE, PAYLOAD_KIND.SMART_BOMB]) {
        const h = contactHarness();
        h.game.ship.x = 0.5;
        const first = rock(h, {
            number: 302, radius: 0.08, hits: 3,
            remaining: payload === PAYLOAD_KIND.NUKE ? 3 : 1, payload: PAYLOAD_KIND.MINE,
        });
        first.x = 0.55;
        const second = rock(h, { number: 303, radius: 0.06, hits: 3 });
        second.x = 0.65;
        const outside = rock(h, { number: 304, radius: 0.06, hits: 3 });
        outside.x = 0.9;
        const existing = [
            timedEffect(h, { number: 305, kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE, x: 0.9, y: 0.9 }),
            timedEffect(h, { number: 306, kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY, x: 0.9, y: 0.9 }),
            timedEffect(h, { number: 307, kind: GAME_EFFECT_KIND.HOSTILE_BULLET, payload: PAYLOAD_KIND.SPRAY, x: 0.9, y: 0.9 }),
        ];
        const pickup = timedEffect(h, { number: 308, payload });
        h.game.effectContactNowMs = 1100;
        h.checkGameEffectContacts();
        assert.equal(h.game.effects.includes(pickup), false);
        assert.equal(h.game.astervoids.includes(first), false);
        const nuke = payload === PAYLOAD_KIND.NUKE;
        assert.equal(h.game.astervoids.includes(second), !nuke);
        if (!nuke) assert.equal(second.hitsRemaining, 2);
        assert.equal(h.game.astervoids.includes(outside), true);
        assert.equal(outside.hitsRemaining, nuke ? 3 : 2);
        assert.equal(h.game.soloXp, nuke ? 20 : 10);
        assert.equal(h.game.score, first.getPoints() + (nuke ? second.getPoints() : 0));
        for (const effect of existing) assert.equal(h.game.effects.includes(effect), nuke);
        assert.ok(h.game.effects.some(effect =>
            effect.data.kind === GAME_EFFECT_KIND.MINE && effect.data.sourceId === first.localObjectId),
        'the newly released hazard is not recursively cleared by the same smart bomb');
        const children = h.game.astervoids.filter(asteroid => ![first, second, outside].includes(asteroid));
        assert.ok(children.length >= 2);
        assert.ok(children.every(asteroid => asteroid.maxHits === 1
            && asteroid.hitsRemaining === 1 && asteroid.payloadKind === PAYLOAD_KIND.NONE));
    }
});

test('owned multiplayer blasts retry armor acknowledgements and reward only durable fixed-target breaks once', async () => {
    for (const payload of [PAYLOAD_KIND.NUKE, PAYLOAD_KIND.SMART_BOMB]) {
        const h = contactHarness({ session: true });
        h.game.ship.x = 0.5;
        seedShip(h);
        const nuke = payload === PAYLOAD_KIND.NUKE;
        const first = rock(h, {
            number: 400, x: 0.55, radius: 0.08, hits: 3,
            remaining: nuke ? 3 : 1, payload: PAYLOAD_KIND.MINE,
        });
        const second = rock(h, { number: 401, x: 0.65, hits: 3 });
        const outside = rock(h, { number: 402, x: 0.9, hits: 3 });
        const hazards = [
            timedEffect(h, { number: 403, kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE }),
            timedEffect(h, { number: 404, kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY }),
            timedEffect(h, { number: 405, kind: GAME_EFFECT_KIND.HOSTILE_BULLET, payload: PAYLOAD_KIND.SPRAY }),
        ];
        const data = h.createGameEffectData(GAME_EFFECT_KIND.ACTIVATION_RECEIPT, payload, id(406), {
            claimId: id(407), participantId: participantA, participantTag: 'Pilot_1', shipId: shipA,
        }, 0.5, 0.5);
        Object.assign(data, h.collectBlastTargets(data,
            h.objectSync.getObjectsByType(OBJECT_TYPES.ASTEROID), hazards));
        const command = { id: id(408), data };
        h.network.transport.acknowledge = false;
        h.applyOwnedBlastCommand(command);
        h.applyOwnedBlastCommand(command);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.objectSync.getObject(first.syncObjectId), undefined);
        assert.equal(!!h.objectSync.getObject(second.syncObjectId), !nuke);
        assert.equal(h.objectSync.getObject(outside.syncObjectId).data.hitsRemaining, nuke ? 3 : 2);
        for (const hazard of hazards) assert.equal(!!h.objectSync.getObject(hazard.id), nuke);
        const children = h.objectSync.getObjectsByType(OBJECT_TYPES.ASTEROID)
            .filter(record => ![second.syncObjectId, outside.syncObjectId].includes(record.id));
        assert.ok(children.length >= 2);
        assert.ok(children.every(record => record.data.hitsRemaining === 1
            && record.data.maxHits === 1 && record.data.payloadKind === PAYLOAD_KIND.NONE));
        assert.equal(h.isBlastCommandComplete(command), nuke,
            'optimistic nonbreaking damage alone is not a confirmed blast acknowledgement');
        await h.objectSync.flushUpdates();
        h.network.transport.acknowledge = true;
        h.syncLocalAstervoids();
        await h.objectSync.flushUpdates();
        assert.equal(h.isBlastCommandComplete(command), true);
        const replacementCount = h.network.calls.filter(call => call.method === 'replace').length;
        h.applyOwnedBlastCommand(command);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.network.calls.filter(call => call.method === 'replace').length, replacementCount);
        const effects = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT);
        const winners = effects.filter(record => record.data.kind === GAME_EFFECT_KIND.BREAK_RECEIPT);
        assert.equal(winners.length, nuke ? 2 : 1);
        assert.ok(winners.every(record => record.data.claimId === command.id
            && record.data.participantId === participantA));
        assert.ok(effects.some(record => record.data.kind === GAME_EFFECT_KIND.MINE
            && record.data.sourceId === first.syncObjectId),
        'the fixed command never enrolls newly released hazards');
        const next = calculate({ effects: winners });
        assert.equal(next.participantXp[participantA], nuke ? 20 : 10);
        assert.equal(next.groupScore, first.getPoints() + (nuke ? second.getPoints() : 0));
        assert.equal(calculateAgain(next, { effects: winners }).participantXp[participantA],
            next.participantXp[participantA]);
        assert.equal(h.game.ship.score, 0);
    }
});

test('blast and hazard receipts wait for authoritative target removal, never pending or rejected local-first deletes', async () => {
    const h = contactHarness({ session: true });
    const ship = seedShip(h);
    const asteroid = rock(h, { number: 430, hits: 3 });
    const mine = timedEffect(h, { number: 431, kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE });
    const data = h.createGameEffectData(GAME_EFFECT_KIND.ACTIVATION_RECEIPT, PAYLOAD_KIND.SMART_BOMB,
        id(432), { participantId: participantA, shipId: ship.id });
    Object.assign(data, h.collectBlastTargets(data, [
        h.objectSync.getObject(asteroid.syncObjectId),
    ], [mine]));
    const command = { id: id(433), ownerMemberId: memberA, scope: 'Session', version: 1, schemaId: 5, data };
    h.network.seed([command]);
    const deleteObject = h.network.client.deleteObject;
    const pending = [];
    h.network.client.deleteObject = () => new Promise(resolve => pending.push(resolve));
    const deleting = [asteroid.syncObjectId, mine.id, ship.id].map(id => h.objectSync.deleteObject(id));
    assert.equal(h.isBlastCommandComplete(command), false);
    assert.equal(h.isHazardReceiptHandled(data, command.id), false);
    for (const resolve of pending) resolve({ success: false });
    assert.deepEqual(await Promise.all(deleting), [false, false, false]);
    assert.equal(h.isBlastCommandComplete(command), false, 'rejection is not a durable target acknowledgement');
    assert.equal(h.isHazardReceiptHandled(data, command.id), false);
    await h.objectSync.triggerReconciliation();
    assert.ok(h.objectSync.getObject(asteroid.syncObjectId));
    assert.ok(h.objectSync.getObject(mine.id));
    assert.ok(h.objectSync.getObject(ship.id));
    h.network.client.deleteObject = deleteObject;
    await Promise.all([asteroid.syncObjectId, mine.id, ship.id].map(id => h.objectSync.deleteObject(id)));
    assert.equal(h.isBlastCommandComplete(command), true);
    assert.equal(h.isHazardReceiptHandled(data, command.id), true);
});

test('mine waits exactly one second, expires at eight total seconds, and consumes one normal ship hit', () => {
    const h = contactHarness();
    h.game.simulationTimeMs = 1000;
    const mine = timedEffect(h, { kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE });
    h.updateGameEffects(59.94);
    h.checkGameEffectContacts();
    assert.equal(h.game.ship.hitCount, 0);
    assert.equal(h.game.effects.includes(mine), true);
    h.updateGameEffects(0.06);
    h.checkGameEffectContacts();
    assert.equal(h.game.ship.hitCount, 1);
    assert.equal(h.game.lives, 2);
    assert.equal(h.game.effects.includes(mine), false);
    h.checkGameEffectContacts();
    assert.equal(h.game.ship.hitCount, 1);
    assert.equal(h.game.soloXp, 0);
    const expired = contactHarness();
    expired.game.simulationTimeMs = 1000;
    timedEffect(expired, { kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE });
    expired.updateGameEffects(480);
    expired.checkGameEffectContacts();
    assert.equal(expired.game.effects.length, 0);
    assert.equal(expired.game.ship.hitCount, 0);
});

test('the actual effect updater telegraphs spray for 0.8 seconds and never grants a hidden owner a fresh lifespan', () => {
    const h = contactHarness();
    h.game.simulationTimeMs = 1000;
    timedEffect(h, { kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY, x: 0.9, y: 0.9 });
    h.updateGameEffects(47.94);
    assert.equal(h.game.effects.length, 1);
    assert.equal(h.game.effects[0].data.kind, GAME_EFFECT_KIND.SPRAY);
    h.updateGameEffects(0.06);
    assert.equal(h.game.effects.length, 12);
    assert.ok(h.game.effects.every(effect => effect.data.kind === GAME_EFFECT_KIND.HOSTILE_BULLET
        && effect.data.startedAt === 1800 && effect.data.expiresAt === 3800));
    h.updateGameEffects(120);
    assert.equal(h.game.effects.length, 0);
    const late = contactHarness();
    late.game.simulationTimeMs = 1000;
    timedEffect(late, { kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY });
    late.updateGameEffects(180);
    assert.equal(late.game.effects.length, 0, 'already expired spray is cleaned up, not relaunched');
    assert.equal(late.game.soloXp, 0);
});

test('multiplayer spray atomically launches one twelve-bullet burst and migration cannot restart its persisted deadlines', async () => {
    const h = contactHarness({ session: true });
    const spray = timedEffect(h, {
        number: 410, kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY, x: 0.9, y: 0.9,
    });
    h.clock.server = 1800;
    h.updateGameEffects(0);
    h.updateGameEffects(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.objectSync.getObject(spray.id), undefined);
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
    const bullets = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT);
    assert.equal(bullets.length, 12);
    for (const bullet of bullets) {
        assert.equal(bullet.scope, 'Session');
        assert.equal(bullet.ownerMemberId, memberA);
        assert.equal(bullet.data.kind, GAME_EFFECT_KIND.HOSTILE_BULLET);
        assert.equal(bullet.data.startedAt, 1800);
        assert.equal(bullet.data.armedAt, 1800);
        assert.equal(bullet.data.expiresAt, 3800);
        approx(Math.hypot(bullet.data.velocityX, bullet.data.velocityY), h.config.BULLET_SPEED * 0.4, 1e-7);
    }
    const migrated = [...h.network.server.values()].map(record => ({
        ...record, ownerMemberId: memberB, validAt: 4500,
    }));
    h.sessionClient.getCurrentMember = () => ({ id: memberB, role: 'Server' });
    h.network = attachGameplaySync(h, memberB);
    h.network.seed(migrated);
    h.clock.server = 4500;
    h.updateGameEffects(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 0,
        'the new owner expires the original burst rather than granting two more seconds');
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 12);
    assert.equal(h.network.calls.filter(call => call.method === 'create').length, 0);
    assert.equal(h.game.soloXp, 0);
});

test('invulnerability blocks mine and hostile-bullet contacts and telegraph spray is never a collectible', () => {
    for (const kind of [GAME_EFFECT_KIND.MINE, GAME_EFFECT_KIND.HOSTILE_BULLET, GAME_EFFECT_KIND.SPRAY]) {
        const h = contactHarness();
        h.game.ship.invulnerable = 180;
        const hazard = timedEffect(h, { kind, payload: kind === GAME_EFFECT_KIND.MINE ? PAYLOAD_KIND.MINE : PAYLOAD_KIND.SPRAY });
        h.game.effectContactNowMs = 2100;
        h.checkGameEffectContacts();
        assert.equal(h.game.ship.hitCount, 0);
        assert.equal(h.game.effects.includes(hazard), true);
        assert.equal(h.game.soloXp, 0);
    }
});

test('a fast hostile spray bullet uses a no-wrap hull sweep and consumes exactly one normal damage contact', () => {
    const h = contactHarness();
    h.game.ship.x = 0.5;
    const hostile = timedEffect(h, {
        number: 309, kind: GAME_EFFECT_KIND.HOSTILE_BULLET, payload: PAYLOAD_KIND.SPRAY,
        x: 0.4, y: 0.5,
    });
    hostile.data.velocityX = h.config.BULLET_SPEED * 0.4;
    assert.equal(h.gameEffectTouchesShip(hostile.data, h.game.ship, 2000), false,
        'the final pose alone has already passed the ship');
    assert.equal(h.gameEffectTouchesShip(hostile.data, h.game.ship, 2000, 1000), true);
    const contactAt = h.findGameEffectContactTime(hostile.data, h.game.ship, 1000, 2000);
    assert.ok(contactAt > 1000 && contactAt < 2000);
    h.game.effectContactNowMs = 2000;
    h.game.effectContactPreviousMs = 1000;
    h.checkGameEffectContacts();
    assert.equal(h.game.ship.hitCount, 1);
    assert.equal(h.game.lives, 2);
    assert.equal(h.game.effects.includes(hostile), false);
    h.checkGameEffectContacts();
    assert.equal(h.game.ship.hitCount, 1);
    assert.equal(h.game.soloXp, 0);
});

test('multiplayer contacts persist exactly one member-scoped claim before asynchronous acceptance', async () => {
    const h = contactHarness({ session: true });
    seedShip(h);
    timedEffect(h);
    h.game.effectContactNowMs = 1100;
    h.checkGameEffectContacts();
    h.checkGameEffectContacts();
    assert.equal(h.network.calls.filter(call => call.method === 'create').length, 1);
    assert.equal(h.game.multiplayer.contactClaims.size, 1);
    await new Promise(resolve => setImmediate(resolve));
    const claims = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_CLAIM);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].scope, 'Member');
    assert.equal(claims[0].data.participantId, participantA);
    assert.equal(claims[0].data.shipId, shipA);
    assert.equal(claims[0].data.claimedAt, 1100);
    assert.equal(claims[0].data.invulnerabilityRevision, h.game.ship.invulnerabilityRevision);
    assert.equal(h.game.ship.score, 0);
});

test('owner contact validation checks GUID attribution, member ownership, actual hull, clock, lifespan and hazard revision', () => {
    const h = contactHarness({ session: true });
    const ship = seedShip(h, { revision: 7 });
    const mine = timedEffect(h, { kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE });
    const valid = contactClaim(h, mine, { at: 2500, revision: 7 });
    assert.equal(h.isGameContactClaimEligible(mine, valid, ship, 2500), true);
    for (const changed of [
        { ownerMemberId: memberB }, { data: { participantId: participantB } },
        { data: { participantId: 'not-a-guid' } }, { data: { shipId: shipB } },
        { data: { targetId: id(399) } }, { data: { claimedAt: NaN } },
        { data: { claimedAt: 1999 } }, { data: { claimedAt: 9000 } },
        { data: { claimedAt: 2500 + PROGRESSION.CLAIM_CLOCK_TOLERANCE_MS + 1 } },
        { data: { invulnerabilityRevision: 6 } }, { data: { x: 0.9, y: 0.9 } },
    ]) {
        const candidate = { ...valid, ...changed, data: { ...valid.data, ...changed.data } };
        assert.equal(h.isGameContactClaimEligible(mine, candidate, ship, 2500), false);
    }
    assert.equal(h.isGameContactClaimEligible(mine, valid, null, 2500), false);
    const pickup = timedEffect(h, { number: 312 });
    const early = contactClaim(h, pickup, { number: 313, at: 1200, revision: 7 });
    const later = contactClaim(h, pickup, { number: 314, at: 1201, revision: 7 });
    const tie = contactClaim(h, pickup, { number: 311, at: 1200, revision: 7 });
    assert.equal(h.chooseGameContactClaim(pickup, [later, early, tie], 1500).id, tie.id);
});

test('competing pickup claims atomically select one winner and its durable activation receipt applies only once', async () => {
    const h = contactHarness({ session: true });
    seedShip(h);
    seedShip(h, { number: 22, participant: participantB, owner: memberB });
    const pickup = timedEffect(h);
    const local = contactClaim(h, pickup, { number: 315, at: 1200 });
    const earlier = contactClaim(h, pickup, {
        number: 316, at: 1100, participant: participantB, ship: shipB, owner: memberB,
    });
    h.network.seed([local, earlier]);
    h.clock.server = 1500;
    let finish;
    h.network.transport.replacementGate = new Promise(resolve => { finish = resolve; });
    h.updateGameEffects(0);
    h.updateGameEffects(0);
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.objectSync.getObject(pickup.id), undefined);
    const receipts = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].data.kind, GAME_EFFECT_KIND.ACTIVATION_RECEIPT);
    assert.equal(receipts[0].data.claimId, earlier.id);
    assert.equal(receipts[0].data.participantId, participantB);
    assert.equal(receipts[0].scope, 'Session');
    const next = calculate({ effects: receipts });
    assert.equal(next.participantXp[participantA], 0);
    assert.equal(next.participantXp[participantB], 20);
    assert.equal(calculateAgain(next, { effects: receipts }).participantXp[participantB], 20);
});

test('durable contact claims expire after sixteen seconds or ship replacement rather than following a recreated ship', async () => {
    for (const replacement of [false, true]) {
        const h = contactHarness({ session: true });
        seedShip(h);
        const pickup = timedEffect(h, { number: 322 });
        const claim = contactClaim(h, pickup, { number: 323, at: 1000 });
        h.network.seed([claim]);
        h.game.multiplayer.contactClaims.set(pickup.id, {
            id: claim.id, data: claim.data, epoch: h.sessionClient.getSessionEpoch(),
        });
        if (replacement) h.game.multiplayer.myShipObjectId = shipB;
        h.cleanupGameContactClaims(replacement ? 1100 : 17000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.objectSync.getObject(claim.id), undefined);
        assert.equal(h.game.multiplayer.contactClaims.size, 0);
        assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 1,
            'claim cleanup does not fabricate an activation receipt');
    }
});

test('hazard receipts respect invulnerability and respawn revisions, persist once, and retry outside motion gates', async () => {
    for (const blocked of [null, 'invulnerable', 'stale revision', 'death hold', 'terminal maintenance']) {
        const h = contactHarness({ session: true });
        seedShip(h);
        h.network.transport.acknowledge = false;
        if (blocked === 'invulnerable') h.game.ship.invulnerable = 180;
        if (blocked === 'stale revision') h.game.ship.invulnerabilityRevision = 7;
        if (blocked === 'death hold') h.game.ship.deathHold = {};
        const hazardId = id(317);
        const data = h.createGameEffectData(GAME_EFFECT_KIND.ACTIVATION_RECEIPT, PAYLOAD_KIND.MINE,
            hazardId, { claimId: id(318), participantId: participantA, shipId: shipA });
        data.damageReceipts = AstervoidsWireCodec.packCounterMap({ [id(318)]: 0 });
        const record = { id: id(319), data };
        h.applyHazardReceipt(record, blocked === 'terminal maintenance');
        h.applyHazardReceipt(record);
        assert.equal(h.game.ship.hitCount, blocked === null ? 1 : 0);
        assert.deepEqual(h.game.ship.handledHazards, { [hazardId]: 1 });
        await h.objectSync.flushUpdates();
        h.network.transport.acknowledge = true;
        h.syncLocalShipHazards();
        await h.objectSync.flushUpdates();
        const persisted = h.network.server.get(shipA).data;
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(persisted.handledHazards), { [hazardId]: 1 });
        assert.equal(persisted.hitCount, blocked === null ? 1 : 0);
        assert.equal(h.game.ship.score, 0);
    }
});

test('actual simulation pause/reconnect gates preserve solo effect time and terminal maintenance cannot activate rewards or hazards', () => {
    const h = contactHarness({
        extraNames: ['runSimulationStep'],
        globals: { snapshotRenderState() {}, handleInput() {} },
    });
    h.game.simulationTimeMs = 1000;
    timedEffect(h, { kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE });
    h.game.state = 'paused';
    h.runSimulationStep(600, false);
    assert.equal(h.game.simulationTimeMs, 1000);
    assert.equal(h.game.effects.length, 1);
    h.game.state = 'playing';
    h.runSimulationStep(600, true);
    assert.equal(h.game.simulationTimeMs, 1000);
    assert.equal(h.game.effects.length, 1);
    h.game.state = 'gameover';
    h.game.lives = 0;
    h.game.soloXp = 30;
    timedEffect(h, { number: 320, payload: PAYLOAD_KIND.EXTRA_LIFE });
    timedEffect(h, { number: 321, kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY });
    h.updateGameEffects(600, true);
    h.game.effectContactNowMs = 9000;
    h.checkGameEffectContacts();
    assert.equal(h.game.simulationTimeMs, 1000);
    assert.equal(h.game.effects.length, 0);
    assert.equal(h.game.soloXp, 30);
    assert.equal(h.game.lives, 0);
    assert.equal(h.game.ship.hitCount, 0);
});

test('a twelve-second pickup expires before contact and late valid claims retain the original collectible deadline', () => {
    const solo = contactHarness();
    solo.game.simulationTimeMs = 1000;
    const pickup = timedEffect(solo);
    assert.equal(pickup.data.expiresAt, 13000);
    solo.updateGameEffects(720);
    solo.checkGameEffectContacts();
    assert.equal(solo.game.effects.length, 0);
    assert.equal(solo.game.soloXp, 0);
    const session = contactHarness({ session: true });
    const ship = seedShip(session);
    const durable = timedEffect(session);
    const claim = contactClaim(session, durable, { at: 12999 });
    assert.equal(session.isGameContactClaimEligible(durable, claim, ship, 14000), true);
    assert.equal(session.isGameContactClaimEligible(durable,
        { ...claim, data: { ...claim.data, claimedAt: 13000 } }, ship, 14000), false);
    assert.equal(durable.data.startedAt, 1000);
    assert.equal(durable.data.expiresAt, 13000);
});

test('multiplayer terminal maintenance performs expiry only, never pickup activation, blasts, spray or mine damage', async () => {
    const h = contactHarness({ session: true });
    h.game.state = 'gameover';
    h.game.lives = 0;
    seedShip(h);
    const xp = AstervoidsWireCodec.packXpMap({ [participantA]: 30 });
    h.network.seed([{
        id: id(31), ownerMemberId: memberA, creatorMemberId: memberA,
        scope: 'Session', schemaId: 4, version: 1, data: {
            type: OBJECT_TYPES.GAME_STATE, lives: 0, groupScore: 0,
            participantXp: xp, participantScores: new Uint8Array(), processedEffects: new Uint8Array(),
        },
    }]);
    const pickup = timedEffect(h, { number: 330, payload: PAYLOAD_KIND.SMART_BOMB });
    const mine = timedEffect(h, { number: 331, kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE });
    timedEffect(h, { number: 332, kind: GAME_EFFECT_KIND.SPRAY, payload: PAYLOAD_KIND.SPRAY });
    h.network.seed([
        contactClaim(h, pickup, { number: 333, at: 2500 }),
        contactClaim(h, mine, { number: 334, at: 2500 }),
    ]);
    h.clock.server = 2500;
    h.updateGameEffects(0, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 0);
    assert.equal(h.game.ship.hitCount, 0);
    assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 3);
    h.clock.server = 13000;
    h.updateGameEffects(0, true);
    await new Promise(resolve => setImmediate(resolve));
    const replacements = h.network.calls.filter(call => call.method === 'replace');
    assert.equal(replacements.length, 3);
    assert.ok(replacements.every(call => call.replacements.length === 0));
    assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 0);
    assert.deepEqual(h.objectSync.getObject(id(31)).data.participantXp, xp);
    assert.equal(h.game.lives, 0);
    assert.equal(h.game.ship.hitCount, 0);
});

function hudHarness() {
    const writes = [];
    function element(name) {
        let text = '', hidden = true;
        return {
            style: {}, attributes: {},
            set textContent(value) { text = String(value); writes.push([name, 'text', text]); },
            get textContent() { return text; },
            set hidden(value) { hidden = value; writes.push([name, 'hidden', value]); },
            get hidden() { return hidden; },
            setAttribute(key, value) { this.attributes[key] = String(value); writes.push([name, key, value]); },
        };
    }
    const elements = Object.fromEntries([
        'xpHud', 'xpLevel', 'xpFraction', 'xpBar', 'xpFill', 'levelAnnouncement',
    ].map(name => [name, element(name)]));
    const h = baseHarness({
        extraNames: ['getLocalProgression', 'updateProgressionHud'],
        globals: { ...elements, hudCache: {}, fitProgressionHud: () => writes.push(['fit']) },
    });
    return { ...h, ...elements, writes };
}

test('production leveling HUD shows exact overflow, accessible levels, native fill and change-gated announcements', () => {
    const h = hudHarness();
    h.game.soloXp = 30;
    h.updateProgressionHud();
    assert.equal(h.xpHud.hidden, false);
    assert.equal(h.xpLevel.textContent, 'L2');
    assert.equal(h.xpFraction.textContent, '10/40 XP');
    assert.equal(h.xpBar.attributes['aria-label'], 'Level 2 experience');
    assert.equal(h.xpBar.attributes['aria-valuenow'], '10');
    assert.equal(h.xpBar.attributes['aria-valuemax'], '40');
    assert.equal(h.xpFill.style.width, '25%');
    const writes = h.writes.length;
    h.updateProgressionHud();
    assert.equal(h.writes.length, writes, 'a stable frame never rewrites the same XP text');
    h.game.soloXp = 70;
    h.updateProgressionHud();
    assert.equal(h.xpLevel.textContent, 'L3');
    assert.equal(h.xpFraction.textContent, '10/60 XP');
    assert.equal(h.levelAnnouncement.textContent, 'Level 3. 3 shots per volley.');
});

test('production leveling HUD hides for menu, pause, reconnect, terminal, identity changes and pure spectators', () => {
    for (const change of [
        { state: 'start' }, { state: 'paused' }, { state: 'lobby' }, { state: 'gameover' },
        { connectionLost: true }, { identityChanging: true }, { ship: null }, { lives: 0 },
    ]) {
        const h = hudHarness();
        h.updateProgressionHud();
        assert.equal(h.xpHud.hidden, false);
        Object.assign(h.game, change);
        h.updateProgressionHud();
        assert.equal(h.xpHud.hidden, true);
        assert.equal(h.levelAnnouncement.textContent, '');
    }
});

test('multiplayer nuke activation freezes current local and foreign asteroid poses between ballistic heartbeats', async () => {
    const ReplicationSendPolicy = require('./wwwroot/js/replication-send-policy.js');
    const ReplicationPresentation = require('./wwwroot/js/replication-presentation.js');
    const motionClock = { perf: 1000 };
    const SendGate = {}, DeadReckon = {};
    const h = contactHarness({
        session: true,
        extraNames: [
            'createDeadReckoningState', 'shortestAngleDelta', 'createKinematicPresentation',
            'getKinematicInstance', 'currentKinematicData', 'indexKinematicInstances',
            'buildReplicationContext', 'computeSpawnStaleness', 'projectSpawnData',
            'getRemoteBoundingRadius',
        ],
        globals: {
            SendGate, DeadReckon,
            performance: { now: () => motionClock.perf },
            resolveTerminalSession: () => null,
        },
    });
    Object.assign(SendGate, ReplicationSendPolicy.createBallisticGate({
        config: h.config, isDeterministic: () => true, nowMs: () => motionClock.perf,
    }));
    Object.assign(DeadReckon, ReplicationPresentation.createDeadReckoningPolicy({
        config: h.config, nowMs: () => motionClock.perf,
        velocityToDeltaX: h.velocityToNormalizedDeltaX,
        velocityToDeltaY: h.velocityToNormalizedDeltaY,
        shortestAngleDelta: h.shortestAngleDelta,
        createState: h.createDeadReckoningState,
    }));
    const startUtc = 1_700_000_001_000;
    h.clock.server = startUtc;
    h.game.ship.x = h.game.ship.y = 0.5;
    seedShip(h);
    const pickup = timedEffect(h, {
        number: 500, payload: PAYLOAD_KIND.NUKE, start: startUtc, x: 0.5, y: 0.5,
    });
    const moving = [
        { number: 501, owner: memberA, x: 0.77, velocityX: -0.3 },
        { number: 502, owner: memberA, x: 0.73, velocityX: 0.3 },
        { number: 503, owner: memberB, x: 0.77, velocityX: -0.3 },
        { number: 504, owner: memberB, x: 0.73, velocityX: 0.3 },
    ].map(spec => {
        const asteroid = rock(h, { ...spec, y: 0.5 });
        asteroid.velocityX = spec.velocityX;
        h.network.seed([{
            ...h.objectSync.getObject(asteroid.syncObjectId),
            data: asteroid.toSyncData(), validAt: startUtc,
        }]);
        if (spec.owner === memberB) {
            DeadReckon.updateState(asteroid.syncObjectId, asteroid.toSyncData(), motionClock.perf);
        }
        return { ...spec, asteroid };
    });
    h.syncLocalAstervoids();
    await h.objectSync.flushUpdates();
    const baselineUpdates = h.network.calls.filter(call => call.method === 'update').length;
    motionClock.perf += 200;
    h.clock.server += 200;
    const presentation = h.createKinematicPresentation();
    for (const { owner, asteroid, velocityX } of moving) {
        if (owner === memberA) asteroid.update(0.2 * h.config.TARGET_FPS);
        else asteroid.fromSyncData(presentation.sample(asteroid.syncObjectId,
            { type: OBJECT_TYPES.ASTEROID }, h.objectSync.getObject(asteroid.syncObjectId), {}));
        approx(asteroid.x, velocityX < 0 ? 0.71 : 0.79);
    }
    h.syncLocalAstervoids();
    await h.objectSync.flushUpdates();
    assert.equal(h.network.calls.filter(call => call.method === 'update').length, baselineUpdates,
        'unchanged ballistic movement must not require extra motion publications');
    for (const { x, asteroid } of moving) {
        approx(h.objectSync.getObject(asteroid.syncObjectId).data.x, x, 1 / 32767);
    }
    h.updateGameEffects(0);
    h.checkGameEffectContacts();
    await new Promise(resolve => setImmediate(resolve));
    const claim = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_CLAIM)[0];
    assert.ok(claim);
    assert.equal(h.chooseGameContactClaim(h.objectSync.getObject(pickup.id), [claim], h.clock.server).id, claim.id);

    let finish;
    h.network.transport.replacementGate = new Promise(resolve => { finish = resolve; });
    h.updateGameEffects(0);
    h.updateGameEffects(0);
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
    for (const { asteroid, velocityX } of moving) asteroid.x = velocityX < 0 ? 0.95 : 0.5;
    rock(h, { number: 505, x: 0.5, y: 0.5 });
    h.clock.server += 100;
    motionClock.perf += 100;
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.objectSync.getObject(pickup.id), undefined);
    const receipts = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT);
    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    assert.equal(receipt.data.kind, GAME_EFFECT_KIND.ACTIVATION_RECEIPT);
    assert.equal(receipt.data.claimId, claim.id);
    assert.equal(receipt.data.participantId, participantA);
    assert.equal(receipt.data.shipId, shipA);
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(receipt.data.asteroidTargets), {
        [id(501)]: 1, [id(503)]: 1,
    }, 'freeze the currently near local/foreign IDs, not the opposite last-published anchors or later arrivals');
    assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(receipt.data.hazardTargets), {});
    h.updateGameEffects(0);
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
});

test('a rejected pre-respawn mine claim releases accepted and pending entries for one current vulnerable recontact', async () => {
    for (const pending of [false, true]) {
        const h = contactHarness({ session: true });
        h.game.ship.x = h.game.ship.y = 0.5;
        seedShip(h);
        const mine = timedEffect(h, {
            number: 510, kind: GAME_EFFECT_KIND.MINE, payload: PAYLOAD_KIND.MINE,
            owner: memberB, x: 0.5, y: 0.5,
        });
        assert.equal(mine.data.expiresAt, 9000);
        h.clock.server = 2100;
        h.updateGameEffects(0);
        h.checkGameEffectContacts();
        h.checkGameEffectContacts();
        assert.equal(h.network.calls.filter(call => call.method === 'create').length, 1);
        const oldEntry = h.game.multiplayer.contactClaims.get(mine.id);
        const oldClaim = [...h.network.server.values()].find(record => record.data.type === OBJECT_TYPES.GAME_CLAIM);
        assert.equal(oldEntry.id, null);
        assert.equal(oldEntry.data.invulnerabilityRevision, 0);
        assert.equal(oldClaim.scope, 'Member');
        if (!pending) await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.handleShipHit(h.game.ship), false);
        assert.equal(h.game.ship.syncObjectId, shipA);
        assert.equal(h.game.ship.hitCount, 1);
        assert.equal(h.game.ship.invulnerabilityRevision, 1);
        assert.equal(h.game.ship.invulnerable, h.config.INVULNERABILITY_TIME);
        assert.equal(h.chooseGameContactClaim(mine, [oldClaim], h.clock.server), null);
        h.updateGameEffects(0);
        h.checkGameEffectContacts();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.network.calls.filter(call => call.method === 'create').length, 1,
            'retiring a stale claim cannot fabricate a new invulnerable contact');
        assert.equal(h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length, 1);
        assert.equal(h.game.ship.hitCount, 1);

        h.clock.server = 5200;
        h.game.ship.update((5200 - 2100) * h.config.TARGET_FPS / 1000);
        assert.equal(h.game.ship.invulnerable, 0);
        assert.equal(h.game.ship.invulnerabilityRevision, 2);
        h.game.ship.x = 0.9;
        h.updateGameEffects(0);
        h.checkGameEffectContacts();
        assert.equal(h.network.calls.filter(call => call.method === 'create').length, 1,
            'vulnerability alone cannot replay the old hull contact');
        h.game.ship.x = 0.5;
        h.objectSync.updateObject(shipA, h.game.ship.toUpdateData());
        await h.objectSync.flushUpdates();
        h.checkGameEffectContacts();
        h.checkGameEffectContacts();
        assert.equal(h.network.calls.filter(call => call.method === 'create').length, 2,
            `${pending ? 'pending' : 'accepted'} stale revision must release the target for a genuine new contact`);
        await new Promise(resolve => setImmediate(resolve));
        const claims = h.objectSync.getObjectsByType(OBJECT_TYPES.GAME_CLAIM);
        assert.equal(claims.length, 1);
        const currentClaim = claims[0];
        assert.notEqual(currentClaim.id, oldClaim.id);
        assert.equal(h.objectSync.getObject(oldClaim.id), undefined);
        assert.equal(currentClaim.data.invulnerabilityRevision, 2);
        assert.equal(currentClaim.data.claimedAt, 5200);
        assert.ok(currentClaim.data.claimedAt < mine.data.expiresAt);
        assert.equal(h.game.multiplayer.contactClaims.get(mine.id).id, currentClaim.id);
        assert.equal(h.chooseGameContactClaim(mine, [oldClaim], h.clock.server), null);
        assert.equal(h.chooseGameContactClaim(mine, claims, h.clock.server).id, currentClaim.id);

        const owner = contactHarness({ session: true });
        owner.game.ship = null;
        owner.game.multiplayer.myShipObjectId = null;
        owner.sessionClient.getCurrentMember = () => ({ id: memberB, role: 'Client' });
        owner.network = attachGameplaySync(owner, memberB);
        owner.clock.server = h.clock.server;
        owner.network.seed([...h.network.server.values()]);
        owner.updateGameEffects(0);
        owner.updateGameEffects(0);
        await new Promise(resolve => setImmediate(resolve));
        owner.updateGameEffects(0);
        await owner.objectSync.flushUpdates();
        const receipts = owner.objectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT);
        assert.equal(receipts.length, 1);
        assert.equal(owner.network.calls.filter(call => call.method === 'replace').length, 1);
        const receipt = receipts[0];
        assert.equal(receipt.data.kind, GAME_EFFECT_KIND.ACTIVATION_RECEIPT);
        assert.equal(receipt.data.sourceId, mine.id);
        assert.equal(receipt.data.claimId, currentClaim.id);
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(receipt.data.damageReceipts), { [currentClaim.id]: 2 });
        h.network = attachGameplaySync(h, memberA);
        h.network.seed([...owner.network.server.values()].map(record => ({
            ...record, validAt: owner.objectSync.getObject(record.id).validAt,
        })));
        h.updateGameEffects(0);
        h.updateGameEffects(0);
        await h.objectSync.flushUpdates();
        h.syncLocalShipHazards();
        await h.objectSync.flushUpdates();
        assert.equal(h.game.ship.hitCount, 2, 'the live mine produces exactly one additional normal hit');
        assert.deepEqual(h.game.ship.handledHazards, { [mine.id]: 1 });
        assert.equal(h.game.ship.invulnerabilityRevision, 3);
        assert.equal(h.game.multiplayer.contactClaims.size, 0);
        h.clock.server = 8500;
        h.game.ship.update(h.config.INVULNERABILITY_TIME);
        h.updateGameEffects(0);
        h.updateGameEffects(0);
        assert.equal(h.game.ship.invulnerable, 0);
        assert.equal(h.game.ship.hitCount, 2, 'the same receipt cannot damage the next vulnerable life');
        assert.equal(h.chooseGameContactClaim(mine, [oldClaim], h.clock.server), null);
        const persisted = h.network.server.get(shipA).data;
        assert.equal(persisted.hitCount, 2);
        assert.deepEqual(AstervoidsWireCodec.unpackCounterMap(persisted.handledHazards), { [mine.id]: 1 });
    }
});
