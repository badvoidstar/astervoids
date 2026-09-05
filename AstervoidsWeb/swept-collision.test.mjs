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
    sweptCircleIntersectsCircle,
    sweptCirclePolygonCollision,
    wrappedDelta,
} = require('./wwwroot/js/collision-geometry.js');

function circle(x, y, radius = 1) {
    return { x, y, radius };
}

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
