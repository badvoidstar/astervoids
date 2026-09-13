/**
 * Tests for RemoteObjects spawn / single-snapshot extrapolation primitives
 * that survived the validAt-axis unification.
 *
 * After the unification, the receiver's bracket-search handles spawn timing
 * naturally on the validAt axis (see validAt-axis.test.mjs). The two
 * projection helpers `computeSpawnStaleness` and `projectSpawnData` remain
 * in production for one specific path: the LOCAL OWNER adopting a freshly
 * created object after the round-trip from `replaceObject`. The local game
 * physics (asteroid sim) is not interpolated, so its initial position must
 * be forward-projected from the parent's collision moment to "now."
 *
 * `getMigrationSeed` also calls `projectSpawnData` to extrapolate the
 * latest snapshot to serverNowMs() during ownership handoff.
 *
 * Single-snapshot velocity-based extrapolation (the multi-snap fallback
 * inside `_baseInterpolated`) is still capped to `MAX_EXTRAPOLATION` to
 * prevent runaway projection from a poor estimate.
 *
 * Run with:  node --test AstervoidsWeb/spawn-extrapolation.test.mjs
 *
 * `computeSpawnStaleness` and `projectSpawnData` are the PRODUCTION inline
 * functions, loaded via test-support/inline-game.mjs — not mirrors. Geometry
 * dependencies are injected as a square viewport so the reference-dimension
 * scale factor is 1 and position assertions stay arithmetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const { SHARED_DEFAULTS } = require('./wwwroot/js/game-config.js');
const { createSnapshotInterpolationPolicy } = require(
    './wwwroot/js/replication-presentation.js');

const CONFIG = {
    MAX_EXTRAPOLATION: SHARED_DEFAULTS.MAX_EXTRAPOLATION,
    TARGET_FPS: SHARED_DEFAULTS.TARGET_FPS,
};

// ── Production helpers under test ─────────────────────────────────────────
// A square viewport makes refDim / gameWidth === refDim / gameHeight === 1,
// so projection reduces to position + velocity × staleness. Bounding radius
// is 0 by default, which keeps wrap margins at 0; the wrap test below
// overrides it to exercise the radius-aware margin path.
let boundingRadius = 0;

const {
    computeSpawnStaleness,
    projectSpawnData,
    wrapNormalized,
    wrapMarginX,
    wrapMarginY,
} = loadInlineGameFunctions(
    ['computeSpawnStaleness', 'projectSpawnData', 'wrapNormalized',
        'wrapMarginX', 'wrapMarginY'],
    {
        CONFIG,
        getGameWidth: () => 1000,
        getGameHeight: () => 1000,
        getReferenceDimension: () => 1000,
        getRemoteBoundingRadius: () => boundingRadius,
    });

/**
 * projectSpawnData returns the SAME object reference when staleness is falsy
 * (a deliberate allocation-free fast path). Tests that then mutate or compare
 * keys use this helper to keep the old copy-on-read expectation explicit.
 */
function projectSpawnDataCopy(data, stalenessSec) {
    const result = projectSpawnData(data, stalenessSec);
    return result === data ? { ...data } : result;
}

/**
 * Production single-snapshot extrapolation with identity test geometry.
 * Returns null if no snaps; clamps to snap[0].data if targetTime ≤ snap[0].time;
 * otherwise extrapolates by velocity for at most MAX_EXTRAPOLATION seconds.
 */
function singleSnapExtrapolate(snap, targetTime) {
    if (!snap) return null;
    const policy = createSnapshotInterpolationPolicy({
        config: {
            ...CONFIG,
            INTERPOLATION_ENABLED: true,
            SNAPSHOT_BUFFER_SIZE: 6,
            SNAP_THRESHOLD: Infinity
        },
        nowMs: () => targetTime,
        validAtToTime: value => value,
        getDelayForMember: () => 0,
        velocityToDeltaX: value => value,
        velocityToDeltaY: value => value,
        shortestDeltaX: (from, to) => to - from,
        shortestDeltaY: (from, to) => to - from,
        wrapX: value => value,
        wrapY: value => value,
        distanceBetween: () => 0
    });
    policy.updateState('object', snap.data, 'owner', snap.time);
    return policy.getInterpolated('object', targetTime);
}

function makeSnap(data, time) {
    return {
        data: { ...data },
        time,
        velocity: { x: data.velocityX || 0, y: data.velocityY || 0 },
        rotationSpeed: data.rotationSpeed || 0,
    };
}

// ── computeSpawnStaleness ─────────────────────────────────────────────────

test('computeSpawnStaleness: positive elapsed (validAt in past) returns positive seconds', () => {
    assert.equal(computeSpawnStaleness(1500, 1200), 0.3);
});

test('computeSpawnStaleness: zero elapsed returns 0', () => {
    assert.equal(computeSpawnStaleness(1500, 1500), 0);
});

test('computeSpawnStaleness: validAt in future returns negative seconds', () => {
    // Owner's clock is ahead of receiver's NTP estimate — small negative
    // staleness is allowed (project backward).
    assert.equal(computeSpawnStaleness(1500, 1700), -0.2);
});

test('computeSpawnStaleness: clamps at +MAX_EXTRAPOLATION', () => {
    assert.equal(computeSpawnStaleness(6000, 1000), CONFIG.MAX_EXTRAPOLATION);
});

test('computeSpawnStaleness: clamps at -MAX_EXTRAPOLATION', () => {
    assert.equal(computeSpawnStaleness(1000, 6000), -CONFIG.MAX_EXTRAPOLATION);
});

test('computeSpawnStaleness: at exactly the cap returns the cap', () => {
    const capMs = CONFIG.MAX_EXTRAPOLATION * 1000;
    assert.equal(computeSpawnStaleness(1000 + capMs, 1000), CONFIG.MAX_EXTRAPOLATION);
    assert.equal(computeSpawnStaleness(1000, 1000 + capMs), -CONFIG.MAX_EXTRAPOLATION);
});

// ── projectSpawnData ──────────────────────────────────────────────────────

test('projectSpawnData: zero staleness returns data unchanged', () => {
    const data = { x: 0.5, y: 0.5, velocityX: 100, velocityY: 50, angle: 0.7, rotationSpeed: 0.1 };
    const result = projectSpawnDataCopy(data, 0);
    assert.deepEqual(result, data);
});

test('projectSpawnData: forward projection moves x/y by velocity × staleness', () => {
    const data = { x: 0.1, y: 0.2, velocityX: 0.5, velocityY: -0.2, angle: 0, rotationSpeed: 0 };
    const result = projectSpawnDataCopy(data, 0.5);
    assert.equal(result.x, 0.1 + 0.5 * 0.5, 'x = 0.1 + 0.5 * 0.5');
    assert.equal(result.y, 0.2 + -0.2 * 0.5, 'y = 0.2 + (-0.2) * 0.5');
});

test('projectSpawnData: backward projection (negative staleness) reverses motion', () => {
    const data = { x: 0.5, y: 0.2, velocityX: 0.5, velocityY: -0.2, angle: 0, rotationSpeed: 0 };
    const result = projectSpawnDataCopy(data, -0.2);
    assert.equal(result.x, 0.5 + 0.5 * -0.2, 'x = 0.5 + 0.5 * -0.2');
    assert.equal(result.y, 0.2 + -0.2 * -0.2, 'y = 0.2 + (-0.2) * -0.2');
});

test('projectSpawnData: angle advances by rotationSpeed × TARGET_FPS × staleness', () => {
    // rotationSpeed is per-frame; multiplied by TARGET_FPS to convert to per-sec.
    const data = { x: 0, y: 0, velocityX: 0, velocityY: 0, angle: 1.0, rotationSpeed: 0.1 };
    const result = projectSpawnDataCopy(data, 0.5);
    // angle = 1.0 + 0.1 * 60 * 0.5 = 1.0 + 3.0 = 4.0
    assert.equal(result.angle, 4.0);
});

test('projectSpawnData: missing velocity/angle/rotation fields default to 0', () => {
    const data = { x: 0.5, y: 0.5 };
    const result = projectSpawnDataCopy(data, 0.5);
    assert.equal(result.x, 0.5);
    assert.equal(result.y, 0.5);
    assert.equal(result.angle, 0);
});

test('projectSpawnData: preserves non-motion fields (id, ownerMemberId, etc.)', () => {
    const data = {
        x: 0.1, y: 0.1, velocityX: 0.2, velocityY: 0,
        angle: 0, rotationSpeed: 0,
        id: 'asteroid-42', ownerMemberId: 'member-A', radius: 0.05,
    };
    const result = projectSpawnDataCopy(data, 0.5);
    assert.equal(result.id, 'asteroid-42');
    assert.equal(result.ownerMemberId, 'member-A');
    assert.equal(result.radius, 0.05);
});

test('projectSpawnData: wraps past the far edge using the radius-aware margin', () => {
    // Previously unreachable: the deleted test mirror skipped wrap entirely, so
    // the production toroidal branch had no direct coverage here.
    boundingRadius = 0.05;
    try {
        const margin = wrapMarginX(0.05);
        const data = { x: 0.9, y: 0.5, velocityX: 0.4, velocityY: 0, radius: 0.05 };
        const result = projectSpawnData(data, 0.5);
        // 0.9 + 0.2 = 1.1, which is beyond 1 + margin, so it re-enters at the left.
        assert.equal(result.x, wrapNormalized(1.1, margin));
        assert.ok(result.x <= 0, 'wrapped position re-enters at the left edge');
        assert.equal(result.y, 0.5, 'y is unaffected by an x-only wrap');
    } finally {
        boundingRadius = 0;
    }
});

test('projectSpawnData: radius margin keeps a partly off-screen object unwrapped', () => {
    boundingRadius = 0.05;
    try {
        const data = { x: 0.98, y: 0.5, velocityX: 0.04, velocityY: 0, radius: 0.05 };
        const result = projectSpawnData(data, 0.5);
        // 1.0 sits inside the 1 + margin bound, so the object stays put and
        // finishes leaving the screen before reappearing.
        assert.equal(result.x, 1.0);
    } finally {
        boundingRadius = 0;
    }
});

test('projectSpawnData: wraps on the y axis using wrapMarginY', () => {
    boundingRadius = 0.05;
    try {
        const margin = wrapMarginY(0.05);
        const data = { x: 0.5, y: 0.02, velocityX: 0, velocityY: -0.4, radius: 0.05 };
        const result = projectSpawnData(data, 0.5);
        assert.equal(result.y, wrapNormalized(0.02 - 0.2, margin));
        assert.ok(result.y > 0.5, 'wrapped position re-enters near the bottom edge');
    } finally {
        boundingRadius = 0;
    }
});

// ── computeSpawnStaleness + projectSpawnData composed ─────────────────────

test('compose: spawn projection uses clamped staleness', () => {
    // Clock estimate is way off — spawn validAt looks 10s old. Clamp prevents
    // a runaway projection (would teleport asteroid 10× its expected distance).
    const serverNow = 11000;
    const validAt = 1000; // 10 seconds old
    const data = { x: 0, y: 0, velocityX: 0.1, velocityY: 0 };

    const staleness = computeSpawnStaleness(serverNow, validAt);
    assert.equal(staleness, CONFIG.MAX_EXTRAPOLATION);

    const projected = projectSpawnDataCopy(data, staleness);
    assert.equal(projected.x, 0.1 * CONFIG.MAX_EXTRAPOLATION);
});

// ── Single-snapshot velocity extrapolation (production fallback path) ─────

test('singleSnapExtrapolate: targetTime ≤ snap.time clamps to snap.data', () => {
    const snap = makeSnap({ x: 5, y: 5, velocityX: 100, velocityY: 0, angle: 0, rotationSpeed: 0 }, 1000);
    const result = singleSnapExtrapolate(snap, 900);
    assert.equal(result.x, 5);
    assert.equal(result.y, 5);
});

test('singleSnapExtrapolate: forward extrapolation by velocity', () => {
    const snap = makeSnap({ x: 5, y: 5, velocityX: 100, velocityY: 50, angle: 0, rotationSpeed: 0 }, 1000);
    const result = singleSnapExtrapolate(snap, 1500);
    // 0.5s * 100 = 50; x = 55
    assert.equal(result.x, 55);
    assert.equal(result.y, 30);
});

test('singleSnapExtrapolate: forward extrapolation includes rotation', () => {
    const snap = makeSnap({ x: 0, y: 0, velocityX: 0, velocityY: 0, angle: 0.5, rotationSpeed: 0.1 }, 1000);
    const result = singleSnapExtrapolate(snap, 1500);
    // 0.1 * 60 * 0.5 = 3.0 + 0.5 base = 3.5
    assert.equal(result.angle, 3.5);
});

test('singleSnapExtrapolate: cap at MAX_EXTRAPOLATION prevents runaway', () => {
    const snap = makeSnap({ x: 0, y: 0, velocityX: 100, velocityY: 0, angle: 0, rotationSpeed: 0 }, 1000);
    const result = singleSnapExtrapolate(snap, 6000);
    assert.equal(result.x, 100 * CONFIG.MAX_EXTRAPOLATION);
});

test('singleSnapExtrapolate: returns null for null snap', () => {
    assert.equal(singleSnapExtrapolate(null, 1000), null);
});

// ── Continuity invariant: spawn projection and bracket extrapolation match ─

test('continuity: receiver bracket-extrapolates to same x as local-owner spawn projection', () => {
    // The owner authors a snap at validAt=1000 with x=0.2, vx=0.5.
    // The local owner adopts the asteroid at serverNow=1300 (300ms RTT)
    // and forward-projects: x = 0.2 + 0.5 * 0.3 = 0.35.
    // A receiver renders the same snap at the same server-time moment
    // (renderTime equivalent to serverNow=1300) and bracket-extrapolates:
    // also x = 0.2 + 0.5 * 0.3 = 0.35. Both arrive at the same position.
    const validAt = 1000;
    const serverNow = 1300;
    const data = { x: 0.2, y: 0, velocityX: 0.5, velocityY: 0, angle: 0, rotationSpeed: 0 };

    const staleness = computeSpawnStaleness(serverNow, validAt);
    const projected = projectSpawnDataCopy(data, staleness);

    // Bracket extrapolation arm: snap.time on perf.now axis; assume perf.now == server-time
    // for this test (offset=0, delta=0). Then snap.time = 1000, targetTime = 1300.
    const snap = makeSnap(data, 1000);
    const extrapolated = singleSnapExtrapolate(snap, 1300);

    assert.equal(projected.x, extrapolated.x,
        'spawn projection (local owner) and bracket extrapolation (receiver) yield identical x');
    assert.equal(projected.y, extrapolated.y);
});

// ── Adopt-branch gate: suppress spawn projection for join-snapshot orphans ──
//
// Mirror of the gate in asteroidReplicationDescriptor.adoptOwned (index.html):
//   project iff !record.spawnHandled && !facts.joinSnapshot and either a local
//   replacement baseline exists or (record.validAt != null && clockReady)
// Split children spawned during active membership ARE projected (they were
// moving since validAt). Orphans present in the join snapshot are NOT — they
// sat idle while the session was empty, so projecting them forward by up to
// MAX_EXTRAPOLATION of velocity would teleport them on adoption.

function shouldSpawnProject(obj, facts, clockReady = true) {
    return !obj.spawnHandled
        && !facts.joinSnapshot
        && (Number.isFinite(obj.replacementBaselinePerf)
            || (obj.validAt != null && clockReady));
}

test('adopt gate: split child spawned after join IS projected', () => {
    const child = { id: 'child-fresh', validAt: 1250 };
    assert.equal(shouldSpawnProject(child, { joinSnapshot: false }), true);
});

test('adopt gate: orphan present at join is NOT projected (no teleport)', () => {
    const orphan = { id: 'orphan-1', validAt: 1000 };
    assert.equal(shouldSpawnProject(orphan, { joinSnapshot: true }), false);
});

test('adopt gate: replacement baseline projects before shared-clock bootstrap', () => {
    const child = {
        id: 'child-pre-clock',
        validAt: null,
        replacementBaselinePerf: 1250
    };
    assert.equal(
        shouldSpawnProject(child, { joinSnapshot: false }, false),
        true);
});

test('adopt gate: orphan stale by >MAX_EXTRAPOLATION would teleport if projected', () => {
    // Demonstrates the bug the gate prevents: an idle orphan whose validAt is
    // seconds old would clamp to +MAX_EXTRAPOLATION and jump forward.
    const validAt = 1000;
    const serverNow = 9000; // 8s idle
    const staleness = computeSpawnStaleness(serverNow, validAt);
    assert.equal(staleness, CONFIG.MAX_EXTRAPOLATION);
    const data = { x: 0.1, y: 0, velocityX: 0.2, velocityY: 0, angle: 0, rotationSpeed: 0 };
    const projected = projectSpawnDataCopy(data, staleness);
    // 0.4 of the play field — a visible teleport for an object that never moved.
    assert.equal(projected.x, 0.1 + 0.2 * CONFIG.MAX_EXTRAPOLATION);
    // The gate prevents this: runtime identifies an initial snapshot record.
    assert.equal(shouldSpawnProject(
        { id: 'orphan-idle', validAt },
        { joinSnapshot: true }), false);
});

test('adopt gate: spawnHandled flag still suppresses re-projection', () => {
    const obj = { id: 'child', validAt: 1250, spawnHandled: true };
    assert.equal(shouldSpawnProject(obj, { joinSnapshot: false }), false);
});

test('adopt gate: missing validAt suppresses projection', () => {
    assert.equal(shouldSpawnProject(
        { id: 'x', validAt: null },
        { joinSnapshot: false }), false);
});
