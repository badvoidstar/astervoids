import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameConstants, loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { attachGameplaySync } from './test-support/gameplay-sync.mjs';

const require = createRequire(import.meta.url);
const collision = require('./wwwroot/js/collision-geometry.js');
const fracture = require('./wwwroot/js/asteroid-fracture.js');
const wire = require('./wwwroot/js/astervoids-wire-codec.js');
const guidUtils = require('./wwwroot/js/guid-utils.js');
const sharedConfig = require('./wwwroot/js/game-config.js');
const constants = loadInlineGameConstants(['PROGRESSION', 'PAYLOAD_KIND', 'GAME_EFFECT_KIND']);
const progression = loadInlineGameFunctions(
    ['getLevelXpThreshold', 'getLevelForXp'], constants);

const ME = '00000001-1111-2222-3333-aabbccddeeff';
const PEER = '00000002-1111-2222-3333-aabbccddeeff';
const PARTICIPANT = '00000003-1111-2222-3333-aabbccddeeff';
const SHIP_ID = '00000004-1111-2222-3333-aabbccddeeff';
const ASTEROID_ID = '00000005-1111-2222-3333-aabbccddeeff';

// A ship crashing into an asteroid is also a hit on that asteroid, resolved
// through the production bullet paths: the contact point becomes the shot.
// The harness therefore runs the real collision pass, the real hit resolvers
// and the real handleShipHit, stubbing only the collaborators that reach the
// network, the audio device or the death-hold verdict (covered by
// ship-death-hold.test.mjs).
function harness({ session = false, lives = 3, fatal = false } = {}) {
    const viewport = { width: 1000, height: 1000 };
    const events = [];
    const config = {
        ...sharedConfig.SHARED_DEFAULTS,
        TARGET_FPS: 60,
        ASTEROID_VERTICES: 10, ASTEROID_JAGGEDNESS: 0.4,
        ASTEROID_MAX_SPEED: 0.4, ASTEROID_MAX_SPIN: Math.PI / 6,
        ASTEROID_LARGE_THRESHOLD: 0.067, ASTEROID_MEDIUM_THRESHOLD: 0.034,
        POINTS_LARGE: 20, POINTS_MEDIUM: 50, POINTS_SMALL: 100,
        BULLET_RADIUS: 0.0033, BULLET_LIFETIME: 60, SHIP_SIZE: 0.025,
        EXTRA_LIFE_SCORE_THRESHOLD: 10000, INVULNERABILITY_TIME: 180,
    };
    const game = {
        astervoids: [], bullets: [], ship: null, state: 'playing',
        score: 0, lives, soloXp: 0, effects: [], simulationTimeMs: 0,
        multiplayer: {
            processedPendingBullets: new Set(),
            myShipObjectId: session ? SHIP_ID : null,
            effectAnchors: new Map(),
        },
    };
    const objects = new Map();
    const objectSync = {
        getObject: id => objects.get(id),
        getObjectsByType: type => [...objects.values()].filter(obj => obj.data?.type === type),
        updateObject: (...args) => events.push(['update', ...args]),
    };
    const sessionClient = {
        getCurrentMember: () => ({ id: ME }),
        getCurrentSession: () => ({ members: [{ id: ME }, { id: PEER }] }),
        getSessionEpoch: () => 1,
    };
    const globals = {
        ...constants, ...progression, CONFIG: config, game,
        getGameWidth: () => viewport.width,
        getGameHeight: () => viewport.height,
        isSessionMode: () => session,
        isGameOver: () => game.lives <= 0 || game.state === 'gameover',
        SessionClient: sessionClient, ObjectSync: objectSync,
        GuidUtils: guidUtils, AstervoidsWireCodec: wire,
        countExtraLivesForScore: sharedConfig.countExtraLivesForScore,
        OBJECT_TYPES: {
            ASTEROID: 'asteroid', BULLET: 'bullet', SHIP: 'ship',
            GAME_EFFECT: 'gameEffect', GAME_CLAIM: 'gameClaim',
        },
    };
    let splitting;
    const production = loadInlineGameFunctions([
        'Asteroid', 'Bullet', 'assignDefined', 'getReferenceDimension',
        'fromNormalizedX', 'fromNormalizedY', 'fromNormalizedSize',
        'velocityToNormalizedDeltaX', 'velocityToNormalizedDeltaY',
        'wrapMarginX', 'wrapMarginY', 'wrapNormalized',
        'checkCollisions', 'checkShipAsteroidCollision', 'shipAsteroidCrash',
        'fireShipCrashImpact', 'prepareAsteroidCollision', 'handleShipHit',
        'computeBulletImpact', 'computeBulletAsteroidImpact', 'awardSoloAsteroidScore',
        'resolveBulletAsteroidHit', 'resolveOwnedAsteroidHit',
        'claimCrossOwnerAsteroidHit', 'resolveSoloAsteroidHit',
        'confirmOwnedAsteroidHitClaims', 'retireConfirmedPendingBullets',
        'applyOwnedAsteroidDamage', 'applySoloAsteroidDamage', 'checkGameEffectContacts',
        'calculateGameState',
    ], {
        ...globals,
        getEffectiveAsteroidAspectScales: () => ({ speedScale: 1 }),
        randomRange: () => 0,
        AstervoidsFracture: fracture,
        AstervoidsCollision: collision,
        pointInPolygon: collision.pointInPolygon,
        CollisionEffects: {
            startAsteroidHit: (...args) => events.push(['cue', ...args]),
            startShipHit: (...args) => events.push(['ship-cue', ...args]),
        },
        splitAsteroid: (...args) => {
            events.push(['split', ...args]);
            return splitting.splitAsteroid(...args);
        },
        emitOwnedAsteroidImpactCue: (...args) => events.push(['owned-cue', ...args]),
        // Mirrors production: the claim must already be on the bullet when its
        // creation payload is built, or the asteroid owner never sees it.
        createSyncedBullet: bullet => events.push(['create-bullet', bullet, bullet.toSyncData()]),
        deleteSyncedBullet: bullet => events.push(['delete-bullet', bullet]),
        emitShipStateChanged: (...args) => events.push(['ship-update', ...args]),
        getShipByMemberId: () => null,
        announceExtraLifeAward: () => events.push(['extra-life']),
        predictFatalShipHit: () => fatal,
        beginShipDeathHold: ship => {
            ship.deathHold = { hitCount: ship.hitCount };
            events.push(['death-hold', ship]);
        },
        updateHUD: () => events.push(['hud']),
        publishDebugMetrics: () => {},
        AudioSystem: {
            playExplosion: size => events.push(['explosion', size]),
            playShipExplosion: () => events.push(['ship-explosion']),
            thrustSound: { stop() {} },
            beat: { stop() {} },
        },
        _error: error => { throw error; },
    });
    splitting = loadInlineGameFunctions([
        'splitAsteroid', 'replaceSyncedAsteroid', 'computeDeflectionImpulse',
        'buildAsteroidBreakEffects', 'createGameEffectData', 'getAsteroidObjectId',
        'addSoloGameEffect', 'getGameEffectTiming', 'ensureOwnedGameEffectAnchor',
        'anchorGameEffectData', 'getGameEffectTimerData', 'isGameEffectReady',
    ], {
        ...globals, Asteroid: production.Asteroid, AstervoidsFracture: fracture,
        getEffectiveAsteroidAspectScales: () => ({ speedScale: 1, radiusScale: 1 }),
        getReferenceDimension: production.getReferenceDimension,
        emitShipStateChanged: (...args) => events.push(['ship-update', ...args]),
        updateHUD: () => events.push(['hud']),
        publishDebugMetrics() {},
        _error: error => { throw error; },
    });
    const result = { ...production, ...splitting, viewport, events, config, game, objects,
        objectSync, sessionClient, clock: { server: 1000 } };
    if (session) result.network = attachGameplaySync(result, ME);
    return result;
}

// Square rock so contact points are exact: corners at ±10 px around its centre.
function rock(h, { x = 0.5, y = 0.5, halfWidth = 0.01, syncObjectId = null, owner = ME } = {}) {
    const asteroid = new h.Asteroid(x, y, halfWidth, 0, 0, 123, [
        [-halfWidth, -halfWidth], [halfWidth, -halfWidth],
        [halfWidth, halfWidth], [-halfWidth, halfWidth],
    ].map(([vx, vy]) => ({ angle: Math.atan2(vy, vx), distance: Math.hypot(vx, vy) })));
    asteroid.angle = 0;
    asteroid.syncObjectId = syncObjectId;
    h.game.astervoids.push(asteroid);
    if (syncObjectId) {
        h.network.seed([{
            id: syncObjectId, ownerMemberId: owner, creatorMemberId: owner,
            scope: 'Session', schemaId: 2, version: 1, data: asteroid.toSyncData(),
        }]);
    }
    return asteroid;
}

// Nose-first crash: only the leading vertex is inside the rock, so the contact
// point is unambiguous and distinct from the ship's centre.
function ram(h, { vertex = { x: 505, y: 498 } } = {}) {
    const ship = {
        x: 0.52, y: 0.5, angle: 0, velocityX: -3, velocityY: 1.5,
        colorIndex: 2, memberId: ME, invulnerable: 0, score: 0, hitCount: 0,
        participantId: PARTICIPANT, participantTag: 'CrashPilot',
        syncObjectId: h.game.multiplayer.myShipObjectId,
        deathHold: null, resets: 0,
        getVertices: () => [vertex, { x: 520, y: 495 }, { x: 520, y: 505 }],
        reset() {
            this.resets++;
            this.x = 0.5;
            this.y = 0.5;
            this.velocityX = 0;
            this.velocityY = 0;
            this.invulnerable = h.config.INVULNERABILITY_TIME;
            this.deathHold = null;
        },
        toUpdateData() { return { x: this.x, y: this.y }; },
    };
    h.game.ship = ship;
    return ship;
}

function kinds(h) {
    return h.events.map(event => event[0]);
}

function find(h, kind) {
    return h.events.find(event => event[0] === kind);
}

test('a survivable solo crash destroys the asteroid like a shot at the contact point', () => {
    const h = harness({ lives: 3 });
    const asteroid = rock(h);
    const ship = ram(h);
    const crashVelocity = { x: ship.velocityX, y: ship.velocityY };

    h.checkCollisions();

    // Existing hit handling is untouched: life lost, wreck respawned.
    assert.equal(h.game.lives, 2);
    assert.equal(ship.resets, 1);
    assert.equal(ship.hitCount, 1);
    // ...and the crash now also resolves as a hit on the asteroid.
    assert.deepEqual(kinds(h), [
        'ship-explosion', 'ship-cue', 'hud', 'cue', 'explosion', 'split', 'hud',
    ]);
    assert.deepEqual(h.game.astervoids, [], 'the struck asteroid is destroyed');
    assert.equal(h.game.score, h.config.POINTS_SMALL);
    assert.equal(h.game.soloXp, 10);
    assert.equal(h.game.bullets.length, 0, 'the equivalent shot is consumed by its hit');

    const [, cueBullet, cueTarget] = find(h, 'cue');
    assert.equal(cueTarget, asteroid);
    assert.equal(cueBullet.x, 0.505, 'the shot starts at the contact point, not the ship centre');
    assert.equal(cueBullet.y, 0.498);
    assert.equal(cueBullet.velocityX, crashVelocity.x, 'carrying the crash velocity');
    assert.equal(cueBullet.velocityY, crashVelocity.y);
    assert.equal(cueBullet.colorIndex, ship.colorIndex);

    // Split geometry is the ordinary bullet impact computed from that point.
    const [, splitTarget, splitAttribution, splitImpact] = find(h, 'split');
    assert.equal(splitTarget, asteroid);
    assert.equal(splitAttribution, null);
    assert.deepEqual(
        splitImpact,
        h.computeBulletImpact(asteroid.radius, 0.505 - asteroid.x, 0.498 - asteroid.y,
            crashVelocity.x, crashVelocity.y));
});

test('the contact point drives the impact, not the ship centre', () => {
    const offsets = [];
    for (const vertex of [{ x: 505, y: 494 }, { x: 505, y: 506 }]) {
        const h = harness({ lives: 3 });
        const asteroid = rock(h);
        ram(h, { vertex });
        h.checkCollisions();
        offsets.push(find(h, 'split')[3].offsetN);
        // A ship-centre shot would report the same impact for both contacts.
        const centreImpact = h.computeBulletImpact(
            asteroid.radius, 0.52 - asteroid.x, 0.5 - asteroid.y, -3, 1.5);
        assert.notEqual(offsets.at(-1), centreImpact.offsetN);
    }
    assert.notEqual(offsets[0], offsets[1], 'opposite contact points hit opposite sides');
});

test('a fatal solo crash keeps the asteroid and today\'s game-over behavior', () => {
    const h = harness({ lives: 1 });
    const asteroid = rock(h);
    const ship = ram(h);

    h.checkCollisions();

    assert.equal(h.game.state, 'gameover');
    assert.equal(h.game.lives, 0);
    assert.equal(ship.resets, 0);
    assert.deepEqual(h.game.astervoids, [asteroid], 'the asteroid survives the final crash');
    assert.deepEqual(h.game.bullets, [], 'and no equivalent shot is fired');
    assert.deepEqual(kinds(h), ['ship-explosion', 'ship-cue', 'hud']);
    assert.equal(h.game.score, 0);
    assert.equal(h.game.soloXp, 0);
});

test('a survivable session crash into an owned asteroid commits one durable winner rather than self-crediting', async () => {
    const h = harness({ session: true });
    const asteroid = rock(h, { syncObjectId: ASTEROID_ID });
    const ship = ram(h);

    h.checkCollisions();

    assert.equal(ship.resets, 1);
    assert.deepEqual(kinds(h), [
        'ship-explosion', 'ship-update', 'owned-cue', 'split', 'create-bullet',
    ]);
    const [, cueAsteroid, cueBullet] = find(h, 'owned-cue');
    assert.equal(cueAsteroid, asteroid);
    assert.equal(cueBullet.x, 0.505);
    assert.equal(cueBullet.y, 0.498);
    assert.equal(ship.score, 0, 'a bullet never self-credits the winning owner receipt');
    const [, createdBullet, createdData] = find(h, 'create-bullet');
    assert.equal(createdBullet, cueBullet);
    assert.equal(createdData.pendingHit, true, 'the attributed claim exists before asynchronous replacement');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.objectSync.getObject(ASTEROID_ID), undefined);
    h.retireConfirmedPendingBullets(ME);
    assert.deepEqual(h.game.bullets, [], 'an accepted replacement retires its pending crash claim');
    assert.equal(h.network.calls.filter(call => call.method === 'replace').length, 1);
    const winners = h.objectSync.getObjectsByType('gameEffect');
    assert.equal(winners.length, 1);
    assert.equal(winners[0].data.kind, constants.GAME_EFFECT_KIND.BREAK_RECEIPT);
    assert.equal(winners[0].data.claimId, createdData.damageId);
    assert.equal(winners[0].data.participantId, PARTICIPANT);
    assert.equal(winners[0].data.points, h.config.POINTS_SMALL);
    assert.equal(h.ensureOwnedGameEffectAnchor(winners[0]), false);
    await h.objectSync.flushUpdates();
    assert.equal(h.isGameEffectReady(winners[0]), true, 'accepted immutable deadlines precede consumption');
    const ledger = {
        processedHits: {}, processedScores: {}, countedParticipants: { [PARTICIPANT]: 1 },
        participantScores: { [PARTICIPANT]: 0 }, participantNumbers: { [PARTICIPANT]: 1 },
        participantTags: { [PARTICIPANT]: 'CrashPilot' }, participantXp: { [PARTICIPANT]: 0 },
        processedEffects: {},
    };
    const next = h.calculateGameState({ lives: 3, peakShipCount: 1 }, ledger,
        [{ id: SHIP_ID, data: ship }], { lives: 3, state: 'playing' },
        h.config.EXTRA_LIFE_SCORE_THRESHOLD, winners);
    assert.equal(next.groupScore, h.config.POINTS_SMALL);
    assert.equal(next.participantXp[PARTICIPANT], 10);
    const repeated = h.calculateGameState(next, next, [],
        { lives: next.lives, state: 'playing' }, h.config.EXTRA_LIFE_SCORE_THRESHOLD, winners);
    assert.equal(repeated.groupScore, next.groupScore);
    assert.equal(repeated.participantXp[PARTICIPANT], 10);
});

test('a survivable session crash into a peer asteroid claims the hit on the wire', () => {
    const h = harness({ session: true });
    const asteroid = rock(h, { syncObjectId: ASTEROID_ID, owner: PEER });
    const ship = ram(h);

    h.checkCollisions();

    assert.equal(ship.resets, 1);
    assert.deepEqual(h.game.astervoids, [asteroid],
        'only the asteroid owner may remove it');
    assert.equal(h.game.bullets.length, 1, 'the claim stays in flight');

    const [claim] = h.game.bullets;
    assert.equal(claim.pendingHit, true);
    assert.equal(claim.hitTargetId, ASTEROID_ID);
    assert.equal(claim.ownerMemberId, ME);

    // The claim must ride the creation payload: the crash bullet has no synced
    // object yet, so a later update alone would never reach the owner.
    const [, createdBullet, createdData] = find(h, 'create-bullet');
    assert.equal(createdBullet, claim);
    assert.equal(createdData.pendingHit, true);
    assert.equal(createdData.hitTargetId, ASTEROID_ID);
    assert.equal(createdData.pendingPoints ?? 0, 0, 'the claim cannot self-credit asteroid points');
    assert.equal(createdData.damageId, claim.damageId);
    assert.equal(guidUtils.isGuid(createdData.damageId), true);
    assert.equal(createdData.participantId, PARTICIPANT);
    assert.equal(createdData.shipId, SHIP_ID);
    const impact = h.computeBulletAsteroidImpact(claim, asteroid);
    assert.equal(createdData.hitBulletAngle, impact.bulletAngle);
    assert.equal(createdData.hitOffsetN, impact.offsetN);
    assert.equal(createdData.hitImpactTorque, impact.impactTorque);
    assert.ok(kinds(h).includes('cue'), 'the shooter sees its own impact immediately');
});

test('a predicted-fatal session crash leaves the asteroid untouched', () => {
    const h = harness({ session: true, fatal: true });
    const asteroid = rock(h, { syncObjectId: ASTEROID_ID, owner: PEER });
    const ship = ram(h);

    h.checkCollisions();

    assert.ok(ship.deathHold, 'precondition: the wreck is holding');
    assert.equal(ship.resets, 0);
    assert.deepEqual(h.game.astervoids, [asteroid]);
    assert.deepEqual(h.game.bullets, []);
    assert.deepEqual(kinds(h), ['ship-explosion', 'ship-update', 'death-hold']);
});

test('a held wreck and an invulnerable respawn never re-crash', () => {
    for (const mutate of [ship => { ship.deathHold = { hitCount: 1 }; },
        ship => { ship.invulnerable = 60; }]) {
        const h = harness({ lives: 3 });
        const asteroid = rock(h);
        const ship = ram(h);
        mutate(ship);
        h.checkCollisions();
        assert.deepEqual(h.game.astervoids, [asteroid]);
        assert.deepEqual(h.events, []);
    }
});
