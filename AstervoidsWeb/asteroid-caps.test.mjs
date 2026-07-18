// Unit tests for the production cap helper used by Asteroid.update().
//
// Run with: node --test AstervoidsWeb/asteroid-caps.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    SHARED_DEFAULTS,
    CONFIG_CONTROLS,
    DEBUG_OVERRIDABLE_KEYS,
} = require('./wwwroot/js/game-config.js');
const {
    clampAsteroidMotion,
} = require('./wwwroot/js/asteroid-fracture.js');
const ASTEROID_MAX_SPEED = SHARED_DEFAULTS.ASTEROID_MAX_SPEED;
const ASTEROID_MAX_SPIN = SHARED_DEFAULTS.ASTEROID_MAX_SPIN;

function clampSpeed(vx, vy, maxSpeed) {
    const result = clampAsteroidMotion(vx, vy, 0, maxSpeed, 0);
    return { vx: result.velocityX, vy: result.velocityY };
}

function clampSpin(rs, maxSpin) {
    return clampAsteroidMotion(0, 0, rs, 0, maxSpin).rotationSpeed;
}

test('CONFIG.ASTEROID_MAX_SPEED defaults to 0.4 (half SHIP_MAX_SPEED, same units)', () => {
    assert.equal(ASTEROID_MAX_SPEED, 0.4);
});

test('CONFIG.ASTEROID_MAX_SPIN defaults to π/6 ≈ 5 rotations per second', () => {
    assert.ok(Math.abs(ASTEROID_MAX_SPIN - Math.PI / 6) < 1e-12);
    // 5 rot/s → 5·2π rad/s ÷ 60 frames/s = π/6 rad/frame.
    const rotPerSec = ASTEROID_MAX_SPIN * 60 / (2 * Math.PI);
    assert.ok(Math.abs(rotPerSec - 5) < 1e-9, `expected 5 rot/s, got ${rotPerSec}`);
});

test('clampSpeed: under-cap velocity is unchanged', () => {
    const { vx, vy } = clampSpeed(0.3, -0.4, 0.8); // |v| = 0.5
    assert.equal(vx, 0.3);
    assert.equal(vy, -0.4);
});

test('clampSpeed: over-cap velocity is scaled to exactly the cap, direction preserved', () => {
    const vx0 = 6, vy0 = 8; // |v| = 10
    const { vx, vy } = clampSpeed(vx0, vy0, 1.0);
    const speed = Math.sqrt(vx * vx + vy * vy);
    assert.ok(Math.abs(speed - 1.0) < 1e-12, `magnitude ${speed} != 1`);
    // Direction (unit vector) preserved.
    assert.ok(Math.abs(vx / speed - vx0 / 10) < 1e-12);
    assert.ok(Math.abs(vy / speed - vy0 / 10) < 1e-12);
});

test('clampSpeed: cap of 0 disables (no clamp)', () => {
    const { vx, vy } = clampSpeed(100, -200, 0);
    assert.equal(vx, 100);
    assert.equal(vy, -200);
});

test('clampSpin: under-cap rotationSpeed is unchanged', () => {
    assert.equal(clampSpin(0.1, 0.5), 0.1);
    assert.equal(clampSpin(-0.4, 0.5), -0.4);
});

test('clampSpin: over-cap rotationSpeed is clamped, sign preserved', () => {
    assert.equal(clampSpin(2.5, 0.5), 0.5);
    assert.equal(clampSpin(-2.5, 0.5), -0.5);
});

test('clampSpin: cap of 0 disables (no clamp)', () => {
    assert.equal(clampSpin(99, 0), 99);
    assert.equal(clampSpin(-99, 0), -99);
});

test('default cap is half the ship cap (deliberate — asteroids cap tighter)', () => {
    assert.equal(
        ASTEROID_MAX_SPEED,
        SHARED_DEFAULTS.SHIP_MAX_SPEED / 2);
});

test('debug controls register both asteroid caps', () => {
    const keys = new Set(CONFIG_CONTROLS.map(control => control.key));
    assert.ok(keys.has('ASTEROID_MAX_SPEED'));
    assert.ok(keys.has('ASTEROID_MAX_SPIN'));
});

test('DEBUG_OVERRIDABLE_KEYS allow-lists both new caps', () => {
    assert.ok(DEBUG_OVERRIDABLE_KEYS.includes('ASTEROID_MAX_SPEED'));
    assert.ok(DEBUG_OVERRIDABLE_KEYS.includes('ASTEROID_MAX_SPIN'));
});
