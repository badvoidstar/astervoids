import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const productionSource = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');
const {
    pointInPolygon,
    circlePolygonCollision,
    sweptCircleIntersectsCircle,
    sweptCirclePolygonCollision,
    wrappedDelta,
} = require('./wwwroot/js/collision-geometry.js');

function circle(x, y, radius = 1) {
    return { x, y, radius };
}

const square = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
];

test('shared polygon test handles interior, exterior, and concave shapes', () => {
    assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
    assert.equal(pointInPolygon({ x: 11, y: 5 }, square), false);
    assert.equal(pointInPolygon({ x: 0, y: 0 }, []), false);
    const concave = [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 },
        { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 },
    ];
    assert.equal(pointInPolygon({ x: 2, y: 8 }, concave), true);
    assert.equal(pointInPolygon({ x: 8, y: 8 }, concave), false);
});

test('stationary circle collision includes edges and corner tangencies, not near misses', () => {
    assert.equal(circlePolygonCollision(circle(5, 5, 0), square), true);
    assert.equal(circlePolygonCollision(circle(-1, 5), square), true);
    assert.equal(circlePolygonCollision(circle(-1.001, 5), square), false);
    assert.equal(circlePolygonCollision(circle(-3, -4, 5), square), true);
    assert.equal(circlePolygonCollision(circle(-3, -4, 4.999), square), false);
    for (const vertex of square) {
        assert.equal(circlePolygonCollision(circle(vertex.x, vertex.y, 0), square), true);
    }
});

test('stationary collision handles empty polygons and repeated zero-length edges', () => {
    assert.equal(circlePolygonCollision(circle(0, 0), []), false);
    const repeated = [square[0], ...square, square[0]];
    assert.equal(circlePolygonCollision(circle(-1, 5), repeated), true);
    assert.equal(circlePolygonCollision(circle(-2, 5), repeated), false);
    assert.equal(circlePolygonCollision(circle(-3, -4, 5), [{ x: 0, y: 0 }]), true);
    assert.equal(circlePolygonCollision(circle(-3, -4, 4), [{ x: 0, y: 0 }]), false);
});

test('zero-length sweeps agree with stationary circle collisions', () => {
    for (const point of [circle(5, 5), circle(-1, 5), circle(-2, 5),
        circle(-3, -4, 5), circle(10, 10, 0)]) {
        assert.equal(
            circlePolygonCollision(point, square.slice().reverse()),
            circlePolygonCollision(point, square));
        assert.equal(
            sweptCirclePolygonCollision(point, point, square),
            circlePolygonCollision(point, square));
    }
});

test('fast bullets sweep through asteroids between frame endpoints', () => {
    const asteroid = [
        { x: 40, y: -10 },
        { x: 60, y: -10 },
        { x: 60, y: 10 },
        { x: 40, y: 10 },
    ];
    const start = circle(0, 0);
    const end = circle(100, 0);

    assert.equal(sweptCircleIntersectsCircle(start, end, circle(50, 0, 15)), true);
    assert.equal(sweptCirclePolygonCollision(start, end, asteroid), true);
});

test('sweep detects thin fracture shards', () => {
    const shard = [
        { x: 49.8, y: -20 },
        { x: 50.2, y: 20 },
        { x: 50.4, y: -20 },
    ];

    assert.equal(
        sweptCirclePolygonCollision(circle(0, 0, 0.5), circle(100, 0, 0.5), shard),
        true);
});

test('swept broad and narrow phases reject near misses', () => {
    const asteroid = [
        { x: 40, y: 5 },
        { x: 60, y: 5 },
        { x: 60, y: 15 },
        { x: 40, y: 15 },
    ];
    const start = circle(0, 0);
    const end = circle(100, 0);

    assert.equal(sweptCircleIntersectsCircle(start, end, circle(50, 10, 5)), false);
    assert.equal(sweptCirclePolygonCollision(start, end, asteroid), false);
});

test('relative sweep accounts for asteroid translation during the step', () => {
    const bulletPrevious = 0;
    const bulletCurrent = 4;
    const asteroidPrevious = 6;
    const asteroidCurrent = 3;
    const bulletDelta = bulletCurrent - bulletPrevious;
    const asteroidDelta = asteroidCurrent - asteroidPrevious;
    const relativeStart = bulletCurrent - bulletDelta + asteroidDelta;
    const asteroid = [
        { x: 2.5, y: -1 },
        { x: 3.5, y: -1 },
        { x: 3.5, y: 1 },
        { x: 2.5, y: 1 },
    ];

    assert.equal(
        sweptCirclePolygonCollision(
            circle(relativeStart, 0, 0.1),
            circle(bulletCurrent, 0, 0.1),
            asteroid),
        true);
});

test('wrap-aware sweep stays at the screen edge instead of crossing the field', () => {
    const margin = 0.005;
    const previous = 1.004;
    const current = -0.003;
    const delta = wrappedDelta(previous, current, margin);
    const start = current - delta;
    const centerAsteroid = [
        { x: 0.45, y: 0.45 },
        { x: 0.55, y: 0.45 },
        { x: 0.55, y: 0.55 },
        { x: 0.45, y: 0.55 },
    ];
    const edgeAsteroid = [
        { x: -0.004, y: 0.45 },
        { x: 0.004, y: 0.45 },
        { x: 0.004, y: 0.55 },
        { x: -0.004, y: 0.55 },
    ];

    assert.ok(Math.abs(delta - 0.003) < 1e-12);
    assert.equal(
        sweptCirclePolygonCollision(circle(start, 0.5, 0.001), circle(current, 0.5, 0.001), centerAsteroid),
        false);
    assert.equal(
        sweptCirclePolygonCollision(circle(start, 0.5, 0.001), circle(current, 0.5, 0.001), edgeAsteroid),
        true);
});

test('wrap delta uses half of the margin-extended range', () => {
    assert.equal(wrappedDelta(0, 0.55, 0.1), 0.55);
    assert.ok(Math.abs(wrappedDelta(0, 0.65, 0.1) + 0.55) < 1e-12);
});

test('production tracks step poses and applies swept broad and narrow phases', () => {
    assert.match(productionSource, /bullet\._collisionPrevX = bullet\.x;/);
    assert.match(productionSource, /asteroid\._collisionPrevX = asteroid\.x;/);
    assert.match(productionSource, /AstervoidsCollision\.wrappedDelta\(/);
    assert.match(productionSource, /AstervoidsCollision\.sweptCircleIntersectsCircle\(/);
    assert.match(productionSource, /AstervoidsCollision\.sweptCirclePolygonCollision\(/);
});
