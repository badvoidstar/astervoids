// Unit tests for the production cap helper used by Asteroid.update().
//
// Run with: node --test AstervoidsWeb/asteroid-caps.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'wwwroot/index.html'), 'utf8');
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

function sourceBetween(startMarker, endMarker) {
    const start = html.indexOf(startMarker);
    assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
    const end = html.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
    return html.slice(start, end);
}

function assertBefore(source, first, second) {
    const firstIndex = source.indexOf(first);
    const secondIndex = source.indexOf(second);
    assert.notEqual(firstIndex, -1, `missing source fragment: ${first}`);
    assert.notEqual(secondIndex, -1, `missing source fragment: ${second}`);
    assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test('CONFIG.ASTEROID_MAX_SPEED defaults to 0.4 (same units as SHIP_MAX_SPEED)', () => {
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

test('synced asteroid captures apply motion limits before serialization', () => {
    const createSource = sourceBetween(
        'async function createSyncedAsteroid',
        'function syncLocalAstervoids');
    assertBefore(createSource, 'asteroid.clampMotion()', 'asteroid.toSyncData()');

    const updateSource = sourceBetween(
        'function syncLocalAstervoids',
        'async function deleteSyncedAsteroid');
    assertBefore(updateSource, 'asteroid.clampMotion()', 'SendGate.shouldSend(');
    assertBefore(updateSource, 'asteroid.clampMotion()', 'asteroid.toUpdateData()');

    const replaceSource = sourceBetween(
        'async function replaceSyncedAsteroid',
        'function togglePause');
    assertBefore(replaceSource, 'child.clampMotion()', 'child.toSyncData()');
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
