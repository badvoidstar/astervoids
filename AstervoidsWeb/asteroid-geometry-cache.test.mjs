import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const collision = require('./wwwroot/js/collision-geometry.js');
const fracture = require('./wwwroot/js/asteroid-fracture.js');
const wire = require('./wwwroot/js/astervoids-wire-codec.js');

function harness({ session = false, width = 1000, height = 1000 } = {}) {
    const viewport = { width, height };
    const calls = { cos: 0, sin: 0, deltas: 0, broad: [], narrow: [], events: [] };
    const math = Object.create(Math);
    for (const name of ['cos', 'sin']) {
        math[name] = value => {
            calls[name]++;
            return Math[name](value);
        };
    }
    const config = {
        TARGET_FPS: 60,
        ASTEROID_VERTICES: 10, ASTEROID_JAGGEDNESS: 0.4,
        ASTEROID_MAX_SPEED: 0.4, ASTEROID_MAX_SPIN: Math.PI / 6,
        ASTEROID_LARGE_THRESHOLD: 0.067, ASTEROID_MEDIUM_THRESHOLD: 0.034,
        POINTS_LARGE: 20, POINTS_MEDIUM: 50, POINTS_SMALL: 100,
        BULLET_RADIUS: 0.0033, SHIP_SIZE: 0.025,
        EXTRA_LIFE_SCORE_THRESHOLD: 10000,
    };
    const game = {
        astervoids: [], bullets: [], ship: null, state: 'playing',
        score: 0, lives: 3, multiplayer: { processedPendingBullets: new Set() },
    };
    const objects = new Map();
    const production = loadInlineGameFunctions([
        'Asteroid', 'rescaleAsteroidForAspectChange', 'getReferenceDimension',
        'fromNormalizedX', 'fromNormalizedY', 'fromNormalizedSize',
        'velocityToNormalizedDeltaX', 'velocityToNormalizedDeltaY',
        'wrapMarginX', 'wrapMarginY', 'wrapNormalized', 'drawAsteroidsBatched',
        'checkCollisions', 'checkShipAsteroidCollision', 'computeBulletImpact',
    ], {
        Math: math, CONFIG: config, game,
        getGameWidth: () => viewport.width,
        getGameHeight: () => viewport.height,
        getEffectiveAsteroidAspectScales: () => ({ speedScale: 1 }),
        randomRange: () => 0,
        AstervoidsFracture: fracture,
        AstervoidsWireCodec: wire,
        AstervoidsCollision: {
            ...collision,
            wrappedDelta(...args) {
                calls.deltas++;
                return collision.wrappedDelta(...args);
            },
            sweptCircleIntersectsCircle(start, end, bounds) {
                calls.broad.push({
                    start, end, bounds,
                    snapshot: { start: { ...start }, end: { ...end }, bounds: { ...bounds } },
                });
                return collision.sweptCircleIntersectsCircle(start, end, bounds);
            },
            sweptCirclePolygonCollision(start, end, vertices) {
                calls.narrow.push(vertices);
                return collision.sweptCirclePolygonCollision(start, end, vertices);
            },
        },
        pointInPolygon: collision.pointInPolygon,
        OBJECT_TYPES: { ASTEROID: 'asteroid', BULLET: 'bullet' },
        SessionClient: { getCurrentMember: () => ({ id: 'local' }) },
        isSessionMode: () => session,
        ObjectSync: {
            getObject: id => objects.get(id),
            getObjectsByType: type => [...objects.values()].filter(obj => obj.type === type),
            updateObject: (...args) => calls.events.push(['update', ...args]),
        },
        CollisionEffects: {
            startAsteroidHit: (...args) => calls.events.push(['cue', ...args]),
        },
        splitAsteroid: (...args) => calls.events.push(['split', ...args]),
        emitOwnedAsteroidImpactCue: (...args) => calls.events.push(['owned-cue', ...args]),
        deleteSyncedBullet: bullet => calls.events.push(['delete', bullet]),
        emitShipStateChanged: () => calls.events.push(['ship-update']),
        handleShipHit: ship => calls.events.push(['ship-hit', ship]),
        getShipByMemberId: () => null,
        countExtraLivesForScore: (score, threshold) => Math.floor(score / threshold),
        announceExtraLifeAward: () => calls.events.push(['extra-life']),
        AudioSystem: { playExplosion: size => calls.events.push(['explosion', size]) },
        _error: error => { throw error; },
    });
    return { ...production, viewport, calls, config, game, objects };
}

function polar(points) {
    return points.map(([x, y]) => ({ angle: Math.atan2(y, x), distance: Math.hypot(x, y) }));
}

function rock(h, x = 0.5, y = 0.5, halfWidth = 0.01, halfHeight = halfWidth) {
    const asteroid = new h.Asteroid(x, y, halfWidth, 0, 0, 123, polar([
        [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
        [halfWidth, halfHeight], [-halfWidth, halfHeight],
    ]));
    asteroid.angle = 0;
    return asteroid;
}

function bullet(x, y, previousX = x, previousY = y) {
    return {
        x, y, _collisionPrevX: previousX, _collisionPrevY: previousY,
        velocityX: 0.2, velocityY: 0, ownerMemberId: 'local',
        toUpdateData() { return { pendingHit: this.pendingHit, hitTargetId: this.hitTargetId }; },
    };
}

// Independent pre-cache polar transform, not a second collision implementation.
function expectedWorld(asteroid, viewport) {
    const ref = Math.min(viewport.width, viewport.height);
    return asteroid.vertices.map(v => ({
        x: asteroid.x * viewport.width + Math.cos(v.angle + asteroid.angle) * v.distance * ref,
        y: asteroid.y * viewport.height + Math.sin(v.angle + asteroid.angle) * v.distance * ref,
    }));
}

function assertGeometry(asteroid, viewport, buffer, points) {
    const actual = asteroid.getWorldVertices();
    if (buffer) assert.equal(actual, buffer, 'reuse the world array');
    const expected = expectedWorld(asteroid, viewport);
    assert.equal(actual.length, expected.length);
    actual.forEach((point, i) => {
        if (points?.[i]) assert.equal(point, points[i], 'reuse each world point');
        assert.ok(Math.abs(point.x - expected[i].x) < 1e-10, `vertex ${i} x`);
        assert.ok(Math.abs(point.y - expected[i].y) < 1e-10, `vertex ${i} y`);
    });
    return actual;
}

test('moving seeded and fracture shapes reuse buffers with one rotation, not per-vertex trig', () => {
    const h = harness();
    for (const vertices of [null, polar([[-0.06, -0.001], [0.09, 0], [-0.05, 0.002]])]) {
        const asteroid = new h.Asteroid(0.2, 0.4, 0.08, 0.1, -0.1, 456, vertices);
        const authoritative = structuredClone(asteroid.vertices);
        const buffer = assertGeometry(asteroid, h.viewport);
        const points = buffer.slice();
        for (const angle of [0, 0.7, -2.4, 20 * Math.PI, 1000]) {
            asteroid.fromSyncData({ x: asteroid.x + 0.02, y: asteroid.y - 0.01, angle });
            const before = { cos: h.calls.cos, sin: h.calls.sin };
            assertGeometry(asteroid, h.viewport, buffer, points);
            assert.equal(h.calls.cos - before.cos, 1);
            assert.equal(h.calls.sin - before.sin, 1);
            assertGeometry(asteroid, h.viewport, buffer, points);
            assert.equal(h.calls.cos - before.cos, 1, 'unchanged pose performs no trig');
            assert.equal(h.calls.sin - before.sin, 1);
        }
        asteroid.rotationSpeed = 0.01;
        asteroid.update();
        assertGeometry(asteroid, h.viewport, buffer, points);
        assert.deepEqual(asteroid.vertices, authoritative, 'movement never mutates polar geometry');
    }
});

test('viewport resizing refreshes world points without rebuilding local offsets', () => {
    const h = harness({ width: 1200, height: 600 });
    const asteroid = rock(h);
    const buffer = assertGeometry(asteroid, h.viewport);
    const points = buffer.slice();
    for (const [width, height] of [[1800, 600], [600, 1800], [800, 800], [390, 844]]) {
        Object.assign(h.viewport, { width, height });
        const before = { cos: h.calls.cos, sin: h.calls.sin };
        assertGeometry(asteroid, h.viewport, buffer, points);
        assert.equal(h.calls.cos - before.cos, 1);
        assert.equal(h.calls.sin - before.sin, 1);
    }
});

test('aspect rescale and explicit shape edits invalidate same-pose caches and update bounds', () => {
    const h = harness();
    const asteroid = rock(h);
    const buffer = assertGeometry(asteroid, h.viewport);
    const points = buffer.slice();
    const originalDistance = asteroid.vertices[0].distance;
    asteroid.velocityX = 0.1;
    asteroid.velocityY = -0.2;
    h.rescaleAsteroidForAspectChange(asteroid, 1.5, 2);
    assert.equal(asteroid.radius, 0.015);
    assert.equal(asteroid.boundRadius, originalDistance * 1.5);
    assert.equal(asteroid.velocityX, 0.2);
    assert.equal(asteroid.velocityY, -0.4);
    assertGeometry(asteroid, h.viewport, buffer, points);

    asteroid.vertices[0].distance = 0.12;
    asteroid.vertices[1].angle += 0.3;
    asteroid.rebuildShapeCache();
    assert.equal(asteroid.boundRadius, 0.12);
    assertGeometry(asteroid, h.viewport, buffer, points);

    asteroid.vertices.push({ angle: 4, distance: 0.3 });
    asteroid.rebuildShapeCache();
    assert.equal(asteroid.boundRadius, 0.3);
    assertGeometry(asteroid, h.viewport, buffer, points);

    asteroid.vertices = asteroid.vertices.slice(0, 3);
    asteroid.rebuildShapeCache();
    assert.equal(asteroid.boundRadius, 0.12);
    assertGeometry(asteroid, h.viewport, buffer, points);
});

test('wire round trips preserve authoritative polar order independently of geometry caches', () => {
    const h = harness();
    const asteroid = rock(h, 0.4, 0.5, 0.003, 0.12);
    const original = structuredClone(asteroid.vertices);
    const packed = asteroid.toSyncData().vertices;
    const restored = h.Asteroid.fromSyncData(asteroid.toSyncData());
    assert.deepEqual(restored.vertices, wire.unpackAsteroidVertices(packed));
    assertGeometry(restored, h.viewport);
    assert.notEqual(restored.getWorldVertices(), asteroid.getWorldVertices());
    assert.notEqual(restored.getWorldVertices()[0], asteroid.getWorldVertices()[0]);
    assert.equal(restored.boundRadius, Math.max(...restored.vertices.map(v => v.distance)));
    asteroid.fromSyncData({ x: 0.8, angle: 2 });
    assertGeometry(asteroid, h.viewport);
    assert.deepEqual(asteroid.vertices, original);
    assert.deepEqual(asteroid.toSyncData().vertices, packed);
    const seeded = new h.Asteroid(0.5, 0.5, 0.1, 0, 0, 456);
    assert.equal('vertices' in seeded.toSyncData(), false);
    const buffer = seeded.getWorldVertices();
    const points = buffer.slice();
    seeded.radius = 0.2;
    seeded.seed = 789;
    seeded.vertices = seeded.generateShape();
    seeded.rebuildShapeCache();
    assertGeometry(seeded, h.viewport, buffer, points);
});

test('drawing and bullet/ship collisions consume the same refreshed geometry', () => {
    const h = harness();
    const asteroid = rock(h);
    const buffer = asteroid.getWorldVertices();
    const paths = [];
    const ctx = {
        beginPath() {}, closePath() {}, stroke() {},
        moveTo(x, y) { paths.push({ x, y }); },
        lineTo(x, y) { paths.push({ x, y }); },
    };
    asteroid.fromSyncData({ x: 0.51, y: 0.49, angle: 0.7 });
    h.drawAsteroidsBatched(ctx, [asteroid]);
    assert.deepEqual(paths, buffer);
    paths.length = 0;
    asteroid.draw(ctx);
    assert.deepEqual(paths, buffer);
    h.game.astervoids.push(asteroid);
    assert.equal(h.checkShipAsteroidCollision({
        x: asteroid.x, y: asteroid.y, getVertices: () => [
            { x: 510, y: 490 }, { x: 511, y: 490 }, { x: 510, y: 491 },
        ],
    }), true);
    h.game.bullets.push(bullet(asteroid.x, asteroid.y));
    asteroid._collisionPrevX = asteroid.x;
    asteroid._collisionPrevY = asteroid.y;
    h.checkCollisions();
    assert.equal(h.calls.narrow[0], buffer);
    assert.equal(h.game.bullets.length, 0);
});

test('collision setup is per bullet and scratch objects are reused across rejected pairs', () => {
    const h = harness();
    h.game.bullets.push(bullet(0.1, 0.1, 0.09), bullet(0.2, 0.1, 0.19));
    h.game.astervoids.push(rock(h, 0.6, 0.8), rock(h, 0.7, 0.8), rock(h, 0.8, 0.8));
    h.checkCollisions();
    assert.equal(h.calls.broad.length, 6);
    assert.equal(h.calls.deltas, 2 * 2 + 2 * 6, 'bullet deltas computed once per bullet');
    assert.equal(h.calls.narrow.length, 0, 'broad misses never refresh polygon geometry');
    const first = h.calls.broad[0];
    for (const pair of h.calls.broad) {
        assert.equal(pair.start, first.start);
        assert.equal(pair.end, first.end);
        assert.equal(pair.bounds, first.bounds);
    }
    assert.deepEqual(h.calls.broad.map(pair => pair.snapshot.end.x), [200, 200, 200, 100, 100, 100]);
    assert.deepEqual(h.calls.broad.map(pair => pair.snapshot.bounds.x), [800, 700, 600, 800, 700, 600]);
    assert.equal(h.game.bullets.length, 2);
});

test('collisions preserve reverse bullet/asteroid order and one target per bullet', () => {
    const h = harness();
    const asteroids = [rock(h), rock(h), rock(h)];
    const bullets = [bullet(0.5, 0.5), bullet(0.5, 0.5)];
    h.game.astervoids.push(...asteroids);
    h.game.bullets.push(...bullets);
    h.checkCollisions();
    const cues = h.calls.events.filter(event => event[0] === 'cue');
    assert.deepEqual(cues.map(event => [event[1], event[2]]), [
        [bullets[1], asteroids[2]], [bullets[0], asteroids[1]],
    ]);
    assert.deepEqual(h.game.astervoids, [asteroids[0]]);
    assert.equal(h.game.bullets.length, 0);
    assert.equal(h.game.score, 200);
});

test('production relative sweep catches moving asteroids and rejects co-moving near misses', () => {
    for (const shouldHit of [true, false]) {
        const h = harness();
        const asteroid = rock(h, shouldHit ? 0.45 : 0.3, 0.5);
        asteroid._collisionPrevX = shouldHit ? 0.65 : 0.1;
        h.game.astervoids.push(asteroid);
        h.game.bullets.push(shouldHit ? bullet(0.6, 0.5, 0.5) : bullet(0.4, 0.5, 0.2));
        h.checkCollisions();
        assert.equal(h.game.bullets.length, shouldHit ? 0 : 1);
    }
});

test('production sweep catches thin shards beyond their design disk radius', () => {
    const h = harness();
    const asteroid = rock(h, 0.5, 0.5, 0.001, 0.14);
    h.game.astervoids.push(asteroid);
    h.game.bullets.push(bullet(0.6, 0.62, 0.4));
    h.checkCollisions();
    assert.equal(h.game.bullets.length, 0);
    assert.equal(h.calls.narrow.length, 1);
});

test('production narrow phase keeps stationary tangency inclusive and rejects near misses', () => {
    for (const shouldHit of [true, false]) {
        const h = harness();
        h.config.BULLET_RADIUS = 0.005;
        h.game.astervoids.push(rock(h));
        h.game.bullets.push(bullet(shouldHit ? 0.515 : 0.515001, 0.5));
        h.checkCollisions();
        assert.equal(h.calls.narrow.length, 1, 'both cases pass the conservative broad phase');
        assert.equal(h.game.bullets.length, shouldHit ? 0 : 1);
    }
});

test('bullet and asteroid wraps never create a false sweep across the field', () => {
    for (const axis of ['x', 'y']) {
        for (const reverse of [false, true]) {
            const h = harness({ width: 1200, height: 800 });
            const shot = bullet(0.5, 0.5);
            const margin = axis === 'x'
                ? h.wrapMarginX(h.config.BULLET_RADIUS) : h.wrapMarginY(h.config.BULLET_RADIUS);
            const previous = reverse ? -margin + 0.001 : 1 + margin - 0.001;
            const current = reverse ? 1 + margin - 0.001 : -margin + 0.001;
            shot[axis] = current;
            shot[axis === 'x' ? '_collisionPrevX' : '_collisionPrevY'] = previous;
            h.game.bullets.push(shot);
            h.game.astervoids.push(rock(h));
            h.checkCollisions();
            assert.equal(h.game.bullets.length, 1, 'wrapped bullet misses center');
            const edge = rock(h, shot.x, shot.y);
            h.game.astervoids.push(edge);
            h.checkCollisions();
            assert.equal(h.game.bullets.length, 0, 'wrapped bullet still hits at edge');

            const h2 = harness({ width: 800, height: 1200 });
            const asteroid = rock(h2);
            const asteroidMargin = axis === 'x'
                ? h2.wrapMarginX(asteroid.boundRadius) : h2.wrapMarginY(asteroid.boundRadius);
            asteroid[axis] = reverse ? 1 + asteroidMargin - 0.001 : -asteroidMargin + 0.001;
            asteroid[axis === 'x' ? '_collisionPrevX' : '_collisionPrevY'] =
                reverse ? -asteroidMargin + 0.001 : 1 + asteroidMargin - 0.001;
            h2.game.bullets.push(bullet(0.5, 0.5));
            h2.game.astervoids.push(asteroid);
            h2.checkCollisions();
            assert.equal(h2.game.bullets.length, 1, 'wrapped asteroid misses center');
        }
    }
});

test('session collision filtering and owner-specific hit flow remain unchanged', () => {
    for (const owner of ['local', 'remote']) {
        const h = harness({ session: true });
        const asteroid = rock(h);
        asteroid.syncObjectId = 'asteroid';
        h.objects.set('asteroid', { id: 'asteroid', ownerMemberId: owner });
        const shot = bullet(0.5, 0.5);
        shot.syncObjectId = 'shot';
        const foreign = { ...bullet(0.5, 0.5), ownerMemberId: 'remote' };
        const pending = { ...bullet(0.5, 0.5), pendingHit: true, hitTargetId: 'asteroid' };
        h.game.bullets.push(shot, foreign, pending);
        h.game.astervoids.push(asteroid);
        h.checkCollisions();
        assert.equal(h.calls.broad.length, 1, 'foreign and pending bullets are excluded');
        if (owner === 'local') {
            assert.deepEqual(h.calls.events.map(event => event[0]), ['owned-cue', 'delete', 'split']);
            assert.deepEqual(h.game.bullets, [foreign, pending]);
        } else {
            assert.equal(shot.pendingHit, true);
            assert.equal(shot.hitTargetId, 'asteroid');
            assert.equal(h.game.bullets.length, 3);
            assert.deepEqual(h.calls.events.map(event => event[0]), ['cue', 'update']);
        }
    }
});
