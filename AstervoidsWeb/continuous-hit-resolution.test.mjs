import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const collision = require('./wwwroot/js/collision-geometry.js');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const WireSchemas = require('./wwwroot/js/game-wire-schemas.js');
const rectangle = (x, y) => [
    { x: -x, y: -y }, { x, y: -y }, { x, y }, { x: -x, y },
];
const pose = (x, y = 0, angle = 0) => ({ x, y, angle });
const polygon = (start, end = start, vertices = rectangle(1, 10)) => ({ start, end, vertices });
const circle = (start, end = start, radius = 1) => ({ start, end, radius });

test('production schemas retain claim correlation and exact fracture-parent transforms', () => {
    SchemaCodec.replaceAll(WireSchemas.SCHEMAS);
    const claim = {
        hitClaimId: '11111111-1111-1111-1111-111111111111',
        hitTargetOwnerId: '22222222-2222-2222-2222-222222222222',
        hitTargetVersion: 123,
        hitClaimAt: 123456789.125,
        hitX: -0.0023456789, hitY: 1.0023456789, hitAngle: 6.543210987,
    };
    const bulletSchema = SchemaCodec.get(3);
    assert.deepEqual(SchemaCodec.decode(bulletSchema, SchemaCodec.encode(bulletSchema, claim)), claim);
    const parent = { parentX: 0.123456789, parentY: -0.00345678, parentAngle: 0.23456789 };
    const asteroidSchema = SchemaCodec.get(2);
    assert.deepEqual(SchemaCodec.decode(asteroidSchema, SchemaCodec.encode(asteroidSchema, parent)), parent);
    assert.equal(WireSchemas.selectSchemaId({ type: 'hitResult' }, 'replace'), 0);
});

test('moving circle returns the first surface contact, not the end-of-step offset', () => {
    const hit = collision.movingCirclePolygonTOI(
        circle(pose(0), pose(100)), polygon(pose(50)));
    assert.ok(Math.abs(hit.time - 0.48) < 0.0002);
    assert.deepEqual(hit.contact, { x: 49, y: 0 });
    assert.ok(hit.distance <= hit.tolerance);
    assert.ok(hit.evaluations < 100);
});

test('relative motion catches an asteroid moving through a stationary bullet', () => {
    const hit = collision.movingCirclePolygonTOI(
        circle(pose(0)), polygon(pose(10), pose(-10)));
    assert.ok(Math.abs(hit.time - 0.4) < 0.0002);
    assert.ok(Math.abs(hit.secondPose.x - 2) < hit.tolerance + 0.001);
});

test('rotation-only contact is detected even though both endpoint polygons miss', () => {
    const motion = polygon(pose(0), pose(0, 0, Math.PI), rectangle(0.1, 20));
    const hit = collision.movingCirclePolygonTOI(circle(pose(10), pose(10), 0.1), motion);
    assert.ok(hit && hit.time > 0.48 && hit.time < 0.5);
    assert.ok(hit.secondPose.angle > 1.5);
});

test('continuous circles detect thin, concave and repeated-edge polygons', () => {
    const shard = [{ x: 0, y: -15 }, { x: 0.001, y: 15 }, { x: 0.002, y: -15 }];
    const hit = collision.movingCirclePolygonTOI(
        circle(pose(0), pose(100), 0.01), polygon(pose(50), pose(50), [shard[0], ...shard]));
    assert.ok(hit && Math.abs(hit.time - 0.5) < 0.001);
    const concave = [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 },
        { x: 2, y: 2 }, { x: 2, y: 10 }, { x: 0, y: 10 },
    ];
    assert.equal(collision.movingCirclePolygonTOI(
        circle(pose(5, 5)), polygon(pose(0), pose(0), concave)), null);
});

test('inclusive tangency and bounded near-miss rejection', () => {
    const motion = polygon(pose(50), pose(50), rectangle(10, 10));
    assert.ok(collision.movingCirclePolygonTOI(circle(pose(0, 11), pose(100, 11)), motion));
    assert.equal(collision.movingCirclePolygonTOI(
        circle(pose(0, 11.02), pose(100, 11.02)), motion), null);
});

test('wrap motion checks both seam sides without sweeping across the center', () => {
    const wrap = { width: 100, height: 100, marginX: 1, marginY: 1 };
    const shot = { ...circle(pose(100, 50), pose(0, 50), 0.1), wrap };
    assert.equal(collision.movingCirclePolygonTOI(shot,
        polygon(pose(50, 50), pose(50, 50), rectangle(1, 1))), null);
    const before = collision.movingCirclePolygonTOI(shot,
        polygon(pose(100.7, 50), pose(100.7, 50), rectangle(0.1, 1)));
    const after = collision.movingCirclePolygonTOI(shot,
        polygon(pose(-0.3, 50), pose(-0.3, 50), rectangle(0.1, 1)));
    assert.ok(before && before.time < 0.5);
    assert.ok(after && after.time > 0.5);
});

test('full ship polygons detect edge-only crossings and swept thin obstacles', () => {
    assert.equal(collision.polygonPolygonCollision(rectangle(10, 1), rectangle(1, 10)), true);
    const ship = polygon(pose(0), pose(100), [
        { x: 2, y: 0 }, { x: -1, y: -1 }, { x: -1, y: 1 },
    ]);
    const hit = collision.movingPolygonTOI(ship,
        polygon(pose(50), pose(50), rectangle(0.01, 20)));
    assert.ok(hit && Math.abs(hit.time - 0.4799) < 0.0002);
    assert.ok(collision.movingPolygonTOI(
        polygon(pose(0), pose(0, 0, Math.PI), rectangle(0.1, 20)),
        polygon(pose(10), pose(10), rectangle(0.1, 0.1))));
});

function gameHarness({ session = true, replace = null } = {}) {
    let now = 0, epoch = 1, sequence = 0;
    const records = new Map();
    const calls = { splits: [], deleted: [], cues: [], score: 0, replacements: [] };
    const game = {
        bullets: [], astervoids: [], multiplayer: {}, score: 0, lives: 3,
        state: 'playing', ship: { memberId: 'me', score: 0, invulnerable: 1 },
    };
    const CONFIG = {
        BULLET_RADIUS: 0.001, BULLET_LIFETIME: 60, SHIP_SIZE: 0.02, TARGET_FPS: 60,
        EXTRA_LIFE_SCORE_THRESHOLD: 10000, ASTEROID_LARGE_THRESHOLD: 0.08,
        ASTEROID_MEDIUM_THRESHOLD: 0.04, MIN_ASTEROID_RADIUS: 0.01,
    };
    const ObjectSync = {
        getObject: id => records.get(id),
        getObjectsByType: type => [...records.values()].filter(object => object.data.type === type),
        updateObject: () => true,
        deleteObject: async id => { calls.deleted.push(id); records.delete(id); },
        replaceObject: async (...args) => { calls.replacements.push(args); return replace ? replace(...args) : []; },
    };
    const globals = {
        game, CONFIG, ObjectSync, AstervoidsCollision: collision,
        OBJECT_TYPES: { BULLET: 'bullet', ASTEROID: 'asteroid' },
        SessionClient: { getCurrentMember: () => ({ id: 'me' }), getSessionEpoch: () => epoch },
        RemoteObjects: { serverNowMs: () => 100000 + now },
        performance: { now: () => now },
        simulationTiming: { presentationDelayMs: 100 },
        crypto: { randomUUID: () => `claim-${++sequence}` },
        isSessionMode: () => session,
        getPoseTiming: (offset = 0) => ({ sampleAt: 100000 + now + offset }),
        getSimulationStepMs: () => 1000 / 60,
        getGameWidth: () => 1000, getGameHeight: () => 1000,
        getReferenceDimension: () => 1000,
        fromNormalizedX: x => x * 1000, fromNormalizedY: y => y * 1000,
        fromNormalizedSize: r => r * 1000,
        wrapMarginX: r => r, wrapMarginY: r => r,
        emitOwnedAsteroidImpactCue: (...args) => calls.cues.push(args),
        getShipByMemberId: () => game.ship,
        splitAsteroid: (...args) => { calls.splits.push(args); return replace ? replace(...args) : true; },
        emitShipStateChanged: () => calls.score++,
        deleteSyncedBullet: bullet => {
            calls.deleted.push(bullet.syncObjectId);
            records.delete(bullet.syncObjectId);
        },
        CollisionEffects: { startAsteroidHit: (...args) => calls.cues.push(args) },
        AudioSystem: { playExplosion: () => {} },
        countExtraLivesForScore: () => 0,
        announceExtraLifeAward: () => {},
        handleShipHit: () => {},
        _error: () => {},
    };
    const functions = loadInlineGameFunctions([
        'Bullet', 'computeBulletImpact', 'getCollisionMotion', 'getHitClaimState',
        'beginBulletHit', 'isHitClaimCurrent', 'resolveOwnedHitClaim', 'maintainHitClaims', 'checkCollisions',
        'checkShipAsteroidCollision', 'replaceSyncedAsteroid',
    ], globals);
    return {
        ...functions, game, records, calls, globals,
        time: value => { now = value; }, epoch: value => { epoch = value; },
        asteroid(x, owner = 'me', id = `asteroid-${x}`) {
            const asteroid = {
                x, y: 0.5, angle: 0, radius: 0.01, boundRadius: 0.011,
                velocityX: 0, velocityY: 0, rotationSpeed: 0, syncObjectId: id,
                _collisionPrevX: x, _collisionPrevY: 0.5, _collisionPrevAngle: 0,
                getWorldVertices: () => rectangle(1, 10).map(v => ({ x: v.x + x * 1000, y: v.y + 500 })),
                getPoints: () => 100,
            };
            game.astervoids.push(asteroid);
            records.set(id, { id, version: 1, ownerMemberId: owner, data: { type: 'asteroid' } });
            return asteroid;
        },
        bullet(id = 'bullet') {
            const bullet = new functions.Bullet(0.1, 0.5, 0.3, 0, 0, 'me');
            bullet._collisionPrevX = 0;
            bullet.syncObjectId = id;
            game.bullets.push(bullet);
            records.set(id, { id, ownerMemberId: 'me', data: bullet.toSyncData() });
            return bullet;
        },
    };
}

const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('production chooses earliest TOI irrespective of asteroid array order', () => {
    for (const order of [[0.03, 0.08], [0.08, 0.03]]) {
        const h = gameHarness();
        for (const x of order) h.asteroid(x, 'remote');
        const bullet = h.bullet();
        h.checkCollisions();
        assert.equal(bullet.hitTargetId, 'asteroid-0.03');
        assert.ok(bullet.x < 0.03, 'claim position is first contact, not endpoint');
        assert.ok(bullet.hitClaimAt < 100000);
    }
});

test('production impact lever and torque are measured at contact, including target spin', () => {
    const h = gameHarness();
    const asteroid = h.asteroid(0.05, 'remote');
    asteroid.rotationSpeed = 0.01;
    const bullet = h.bullet();
    h.checkCollisions();
    assert.ok(Math.abs(bullet.hitImpactTorque) > 0,
        'surface-relative rotational velocity contributes to the impact');
    assert.equal(bullet.hitX, 0.05);
    assert.ok(Number.isFinite(bullet.toHitData().hitClaimAt));
    assert.equal(bullet.toHitData().hitClaimId, bullet.hitClaimId);
});

test('same-owner async hits reserve one target and never pre-award duplicate points', async () => {
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const h = gameHarness({ replace: () => response });
    h.asteroid(0.05);
    h.bullet('one'); h.bullet('two');
    h.checkCollisions();
    await microtasks();
    h.checkCollisions();
    assert.equal(h.calls.splits.length, 1);
    assert.equal(h.game.ship.score, 0);
    finish(true);
    await microtasks();
    h.maintainHitClaims();
    h.maintainHitClaims();
    assert.equal(h.game.ship.score, 100);
    assert.equal(h.game.bullets.length, 1, 'losing claim is not confirmed by target disappearance');
    h.records.delete('asteroid-0.05');
    h.time(15001);
    h.maintainHitClaims();
    assert.equal(h.game.bullets.length, 0);
    assert.equal(h.game.ship.score, 100);
});

test('disappearance, unrelated claim results and wrong shooter never award a pending claim', () => {
    const h = gameHarness();
    h.asteroid(0.05, 'remote');
    const bullet = h.bullet();
    h.checkCollisions();
    h.records.delete(bullet.hitTargetId);
    h.records.set('unrelated', {
        id: 'unrelated', ownerMemberId: 'remote',
        data: { type: 'hitResult', hitClaimId: 'somebody-else', hitTargetId: bullet.hitTargetId,
            hitShooterId: 'me', hitPoints: 100, hitExpiresAt: 130000 },
    });
    h.records.set('wrong-shooter', {
        id: 'wrong-shooter', ownerMemberId: 'remote',
        data: { type: 'hitResult', hitClaimId: bullet.hitClaimId, hitTargetId: bullet.hitTargetId,
            hitShooterId: 'other', hitPoints: 100, hitExpiresAt: 130000 },
    });
    bullet.lifetime = -100;
    assert.equal(bullet.isExpired(), false);
    assert.equal(bullet.toHitData().lifetime, 0, 'pending lifetime must not wrap through unsigned wire encoding');
    h.maintainHitClaims();
    assert.equal(h.game.bullets.length, 1);
    assert.equal(h.game.ship.score, 0);
    h.time(15000);
    h.maintainHitClaims();
    assert.equal(h.game.bullets.length, 0);
    assert.equal(h.game.ship.score, 0);
});

test('durable snapshot result settles a late claim after bullet lifetime and child deletion', () => {
    const h = gameHarness();
    h.asteroid(0.05, 'remote');
    const bullet = h.bullet();
    h.checkCollisions();
    h.records.delete(bullet.hitTargetId);
    bullet.lifetime = 0;
    h.time(5000);
    h.records.set('result', {
        id: 'result', ownerMemberId: 'me',
        data: { type: 'hitResult', hitClaimId: bullet.hitClaimId, hitTargetId: bullet.hitTargetId,
            hitShooterId: 'me', hitPoints: 100, hitExpiresAt: 130000 },
    });
    h.maintainHitClaims();
    h.maintainHitClaims();
    assert.equal(h.game.ship.score, 100);
    assert.deepEqual(h.calls.deleted, ['bullet']);
    h.time(30001);
    h.maintainHitClaims();
    assert.ok(h.calls.deleted.includes('result'));
});

test('failed replacement retries without scoring, and a migrated target is never mutated by old owner', async () => {
    let attempt = 0;
    const h = gameHarness({ replace: () => { attempt++; return false; } });
    const asteroid = h.asteroid(0.05);
    h.bullet();
    h.checkCollisions();
    await microtasks();
    h.maintainHitClaims();
    assert.equal(attempt, 1);
    assert.equal(h.game.ship.score, 0);
    h.time(600);
    h.maintainHitClaims();
    await microtasks();
    assert.equal(attempt, 2);
    h.records.get(asteroid.syncObjectId).ownerMemberId = 'new-owner';
    h.time(1200);
    h.maintainHitClaims();
    await microtasks();
    assert.equal(attempt, 2);
});

test('in-flight hit response from a previous session epoch cannot award or reserve new session state', async () => {
    let finish;
    const h = gameHarness({ replace: () => new Promise(resolve => { finish = resolve; }) });
    h.asteroid(0.05); h.bullet();
    h.checkCollisions();
    await microtasks();
    h.epoch(2);
    h.game.bullets.length = 0;
    h.records.clear();
    h.maintainHitClaims();
    finish(true);
    await microtasks();
    assert.equal(h.game.ship.score, 0);
    assert.equal(h.game.multiplayer.hitClaims.results.size, 0);
});

test('atomic replacement includes a durable result even for final childless destruction', async () => {
    const h = gameHarness();
    const asteroid = h.asteroid(0.05);
    const result = { type: 'hitResult', hitClaimId: 'claim', hitTargetId: asteroid.syncObjectId };
    assert.equal(await h.replaceSyncedAsteroid(asteroid, [], 'me', result), true);
    assert.deepEqual(h.calls.replacements[0], [asteroid.syncObjectId, [result], 'Session', 'me']);
    const child = {
        sampleAt: 98765, parentX: 0.4, parentY: 0.3, parentAngle: 0.7,
        clampMotion() {}, toSyncData: () => ({ type: 'asteroid', sampleAt: 100000 }),
    };
    await h.replaceSyncedAsteroid(asteroid, [child], 'me', result);
    assert.equal(h.calls.replacements[1][1][0].sampleAt, 98765, 'TOI child pose keeps its own sample time');
    assert.equal(h.calls.replacements[1][1][0].parentX, 0.4);
    assert.equal(h.calls.replacements[1][1][0].parentY, 0.3);
    assert.equal(h.calls.replacements[1][1][0].parentAngle, 0.7);
});

test('the production minimum-radius split uses the same atomic result instead of a plain deletion', async () => {
    const h = gameHarness();
    const asteroid = h.asteroid(0.05);
    const { splitAsteroid } = loadInlineGameFunctions(['splitAsteroid'], {
        ...h.globals,
        getEffectiveAsteroidAspectScales: () => ({ radiusScale: 1, speedScale: 1 }),
        replaceSyncedAsteroid: h.replaceSyncedAsteroid,
    });
    const result = { type: 'hitResult', hitClaimId: 'claim' };
    assert.equal(await splitAsteroid(asteroid, 'me', null, null, result), true);
    assert.deepEqual(h.calls.replacements[0][1], [result]);
    const failed = gameHarness({ replace: () => null });
    assert.equal(await failed.replaceSyncedAsteroid(asteroid, [], 'me', result), false);
    assert.equal(asteroid.replacementStartedPerf, undefined);
});

test('a hung RPC reservation expires with its claim rather than permanently immunizing the target', async () => {
    const h = gameHarness({ replace: () => new Promise(() => {}) });
    h.asteroid(0.05); h.bullet('old');
    h.checkCollisions();
    await microtasks();
    h.time(15001);
    h.maintainHitClaims();
    assert.equal(h.game.multiplayer.hitClaims.reservations.size, 0);
    h.bullet('new');
    h.checkCollisions();
    await microtasks();
    assert.equal(h.calls.splits.length, 2);
    assert.equal(h.game.ship.score, 0);
});

test('new target owner can settle a surviving claim, attributed to the canonical bullet owner', async () => {
    const h = gameHarness();
    const asteroid = h.asteroid(0.05, 'old-owner');
    const bullet = h.bullet();
    h.checkCollisions();
    const data = { ...bullet.toSyncData(), ownerMemberId: 'forged-data-owner' };
    h.records.set('remote-claim', { id: 'remote-claim', ownerMemberId: 'shooter', data });
    h.records.delete(bullet.syncObjectId);
    h.game.bullets.length = 0;
    h.records.get(asteroid.syncObjectId).ownerMemberId = 'me';
    h.records.get(asteroid.syncObjectId).version = 2;
    h.records.get(asteroid.syncObjectId).ownershipMigrationVersion = 2;
    h.maintainHitClaims();
    await microtasks();
    assert.equal(h.calls.splits.length, 1);
    assert.equal(h.calls.splits[0][4].hitShooterId, 'shooter');
    assert.equal(h.game.ship.score, 0);
});

test('claims label the target scene TOI, not the shooter clock or its previous pose sample', () => {
    const h = gameHarness();
    const asteroid = h.asteroid(0.05, 'remote');
    asteroid._collisionPrevSampleAt = 99950;
    const bullet = h.bullet();
    bullet._collisionPrevSampleAt = 99980;
    h.checkCollisions();
    const time = (0.05 * 1000 - 1 - 1) / 100;
    assert.equal(bullet.hitClaimAt, 99850 + (99900 - 99850) * time);
    assert.equal(bullet.hitTargetOwnerId, 'remote');
    assert.equal(bullet.hitTargetVersion, 1);
});

test('claims reject future versions, unproven owner changes and reset-anchor discontinuities', () => {
    const h = gameHarness();
    const claim = { hitTargetVersion: 5, hitTargetOwnerId: 'old' };
    assert.equal(h.isHitClaimCurrent(claim, { ownerMemberId: 'old', version: 4 }), false);
    assert.equal(h.isHitClaimCurrent(claim, { ownerMemberId: 'new', version: 6 }), false);
    assert.equal(h.isHitClaimCurrent(claim, {
        ownerMemberId: 'new', version: 7, ownershipMigrationVersion: 6,
    }), true);
    assert.equal(h.isHitClaimCurrent(claim, {
        ownerMemberId: 'old', version: 7, simulationAnchorReset: true, simulationCanonicalVersion: 6,
    }), false);
    assert.equal(h.isHitClaimCurrent(claim, {
        ownerMemberId: 'new', version: 7, ownershipMigrationVersion: 6, simulationAnchorReset: true,
    }), false);
});

test('explicit simulation discontinuities do not become field-crossing sweeps', () => {
    const h = gameHarness();
    const bullet = h.bullet();
    bullet._collisionDiscontinuity = true;
    const motion = h.getCollisionMotion(bullet, 0.001);
    assert.deepEqual(motion.start, motion.end);
});
