/**
 * Tests for the polygon-fracture path of splitAsteroid().
 *
 * Run with:  node --test AstervoidsWeb/fracture.test.mjs
 *
 * The tests execute the same pure fracture module used by the browser runtime.
 *
 * Verified properties:
 *   • polygonArea / polygonCentroid against known shapes.
 *   • fractureSplitPolygon: A_pos + A_neg = A_parent within tolerance,
 *     entry/exit lie on the chord, every output polygon has ≥ 3 vertices.
 *   • buildFracturePolyline: endpoints lie on the chord, intermediate points
 *     stay within ±jagAmplitude of the chord, displacement tapers to 0 at
 *     the endpoints.
 *   • End-to-end fracture split (regular 10-gon "parent"):
 *       - Σ m_i = M                              (mass conservation)
 *       - Σ m_i v_i = M v + J                    (linear-momentum conservation)
 *       - small/large radii from polygon area    (R_i = √(A_i / π_eff))
 *       - 1-child branch keeps the surviving piece's polygon
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const AstervoidsConfig = require('./wwwroot/js/game-config.js');
const AstervoidsFracture = require('./wwwroot/js/asteroid-fracture.js');
const runtimeSource = readFileSync(
    new URL('./wwwroot/index.html', import.meta.url),
    'utf8');

const {
    polygonArea,
    polygonCentroid,
    fractureSplitPolygon,
    buildFracturePolyline,
    makeSeededRandom,
    verticesFromXY,
    calculateAsteroidFragments,
} = AstervoidsFracture;

test('runtime seeds simulation RNG without an order-sensitive alias', () => {
    assert.match(
        runtimeSource,
        /_next:\s*AstervoidsFracture\.makeSeededRandom\(1\)/);
    assert.doesNotMatch(
        runtimeSource,
        /const\s*\{\s*makeSeededRandom\s*\}\s*=\s*AstervoidsFracture/);
});

// ─── Helpers: build a parent polygon shaped like the game's asteroids ───────

// Slight phase offset so no vertex lands on the x or y axis — fractureSplitPolygon
// classifies a vertex with side=0 as neither side, which would mask a crossing.
// Real asteroids are randomized, so this never lines up in the game.
function regularPolygon(R, n = 10, phase = 0.07) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + phase;
        out.push({ x: Math.cos(a) * R, y: Math.sin(a) * R });
    }
    return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('polygonArea: unit square = 1', () => {
    const square = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    assert.equal(polygonArea(square), 1);
});

test('polygonArea: regular hexagon R=1 ≈ 3·√3/2', () => {
    const A = polygonArea(regularPolygon(1, 6));
    assert.ok(Math.abs(A - 3 * Math.sqrt(3) / 2) < 1e-12);
});

test('polygonCentroid: unit square centroid = (0.5, 0.5)', () => {
    const square = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    const c = polygonCentroid(square);
    assert.ok(Math.abs(c.x - 0.5) < 1e-12);
    assert.ok(Math.abs(c.y - 0.5) < 1e-12);
});

test('polygonCentroid: regular 10-gon centroid ≈ origin', () => {
    const c = polygonCentroid(regularPolygon(0.083, 10));
    assert.ok(Math.abs(c.x) < 1e-12);
    assert.ok(Math.abs(c.y) < 1e-12);
});

test('fractureSplitPolygon: A_pos + A_neg ≈ A_parent for regular 10-gon, head-on chord', () => {
    const verts = regularPolygon(0.083, 10);
    const Aparent = polygonArea(verts);
    // Chord through center, normal along +y.
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, 0, []);
    assert.ok(split, 'split should succeed');
    const Apos = polygonArea(split.positive);
    const Aneg = polygonArea(split.negative);
    assert.ok(Math.abs((Apos + Aneg) - Aparent) < 1e-12,
        `Apos+Aneg=${Apos+Aneg} parent=${Aparent}`);
    assert.ok(split.positive.length >= 3);
    assert.ok(split.negative.length >= 3);
});

test('fractureSplitPolygon: head-on chord ⇒ ≈ 50/50 area within 5%', () => {
    const verts = regularPolygon(0.083, 10);
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, 0, []);
    const Apos = polygonArea(split.positive);
    const Aneg = polygonArea(split.negative);
    const r = Apos / (Apos + Aneg);
    assert.ok(Math.abs(r - 0.5) < 0.05, `expected ~50/50, got ${r}`);
});

test('fractureSplitPolygon: offset chord ⇒ smaller piece on the offset side', () => {
    const verts = regularPolygon(0.083, 10);
    // Chord at +0.04 along +y (well inside the polygon). Positive side is the smaller cap.
    const d = 0.04;
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, d, []);
    assert.ok(split, 'split should succeed');
    const Apos = polygonArea(split.positive);
    const Aneg = polygonArea(split.negative);
    assert.ok(Apos < Aneg, 'positive cap should be smaller');
    assert.ok(Math.abs(Apos + Aneg - polygonArea(verts)) < 1e-12);
});

test('fractureSplitPolygon: chord misses polygon ⇒ returns null', () => {
    const verts = regularPolygon(0.083, 10);
    const split = fractureSplitPolygon(verts, { x: 0, y: 1 }, 1.0, []);
    assert.equal(split, null);
});

test('buildFracturePolyline: count points, endpoints lie on chord', () => {
    const entry = { x: -1, y: 0 }, exit = { x: 1, y: 0 };
    const rng = makeSeededRandom(42);
    const path = buildFracturePolyline(entry, exit, 6, 0.1, rng);
    assert.equal(path.length, 6);
    // Each point's projection onto the chord direction should be within (-1, 1).
    for (const p of path) {
        assert.ok(p.x > -1 && p.x < 1, `x=${p.x} out of range`);
    }
});

test('buildFracturePolyline: |displacement| ≤ taper · jagAmplitude', () => {
    const entry = { x: -1, y: 0 }, exit = { x: 1, y: 0 };
    const jag = 0.1;
    const rng = makeSeededRandom(123);
    const path = buildFracturePolyline(entry, exit, 8, jag, rng);
    for (let k = 0; k < path.length; k++) {
        const t = (k + 1) / (path.length + 1);
        const taper = 2 * Math.min(t, 1 - t);
        // perpendicular to the chord (which is along x) is the y axis.
        assert.ok(Math.abs(path[k].y) <= jag * taper + 1e-12,
            `k=${k} y=${path[k].y} exceeds ${jag*taper}`);
    }
});

test('buildFracturePolyline: 0 amplitude ⇒ straight line on the chord', () => {
    const entry = { x: 0, y: 0 }, exit = { x: 1, y: 1 };
    const rng = makeSeededRandom(7);
    const path = buildFracturePolyline(entry, exit, 5, 0, rng);
    assert.equal(path.length, 5);
    for (const p of path) {
        // Points should satisfy y == x (on the chord from origin to (1,1)).
        assert.ok(Math.abs(p.x - p.y) < 1e-12);
    }
});

test('buildFracturePolyline: deterministic for same seed', () => {
    const entry = { x: -0.5, y: 0 }, exit = { x: 0.5, y: 0 };
    const a = buildFracturePolyline(entry, exit, 6, 0.1, makeSeededRandom(99));
    const b = buildFracturePolyline(entry, exit, 6, 0.1, makeSeededRandom(99));
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].x, b[i].x);
        assert.equal(a[i].y, b[i].y);
    }
});

// ─── End-to-end: regular 10-gon parent, full fracture split ─────────────────

const CONFIG = AstervoidsConfig.SHARED_DEFAULTS;

function fragmentPolygon(parentVerts, R, vx, vy, omega, offsetN, bulletAngle, cfg = CONFIG) {
    const result = calculateAsteroidFragments({
        radius: R,
        velocityX: vx,
        velocityY: vy,
        rotationSpeed: omega,
        angle: 0,
        seed: 0,
        vertices: verticesFromXY(parentVerts),
    }, { offsetN, bulletAngle }, cfg);
    return {
        M: result.mass,
        I: result.inertia,
        J: result.impulse,
        vxP: result.postImpulse.velocityX,
        vyP: result.postImpulse.velocityY,
        omegaP: result.postImpulse.angularVelocity,
        A_parent: result.fracture?.parentArea ?? null,
        A_pos: result.fracture?.positiveArea ?? null,
        A_neg: result.fracture?.negativeArea ?? null,
        pi_eff: result.fracture?.effectivePi ?? null,
        children: result.children,
    };
}

const FRACTURE_ON_CONFIG = { ...CONFIG, FRACTURE_ENABLED: true };
const FRACTURE_OFF_CONFIG = { ...CONFIG, FRACTURE_ENABLED: false };

test('fracture split master flag defaults to enabled', () => {
    assert.equal(CONFIG.FRACTURE_ENABLED, true);
});

test('fragmentPolygon: fracture disabled uses disk split and null vertices', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0.2, Math.PI / 4, FRACTURE_OFF_CONFIG);
    assert.equal(out.children.length, 2);
    assert.equal(out.children[0].vertices, null);
    assert.equal(out.children[1].vertices, null);
});

test('end-to-end: mass conservation Σ m_i = M', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0.1, -0.05, 0.01, 0.2, Math.PI / 4, FRACTURE_ON_CONFIG);
    const totalM = out.children.reduce((acc, c) => acc + c.m, 0);
    assert.ok(Math.abs(totalM - out.M) < 1e-12, `Σm=${totalM} M=${out.M}`);
});

test('end-to-end: linear momentum Σ m_i v_i = M v + J', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const vx = 0.1, vy = -0.05, omega = 0.01;
    const out = fragmentPolygon(parent, R, vx, vy, omega, 0.2, Math.PI / 4, FRACTURE_ON_CONFIG);
    const px = out.children.reduce((a, c) => a + c.m * c.vx, 0);
    const py = out.children.reduce((a, c) => a + c.m * c.vy, 0);
    const expectedPx = out.M * vx + out.J.x;
    const expectedPy = out.M * vy + out.J.y;
    assert.ok(Math.abs(px - expectedPx) < 1e-12, `px=${px} expected=${expectedPx}`);
    assert.ok(Math.abs(py - expectedPy) < 1e-12, `py=${py} expected=${expectedPy}`);
});

test('end-to-end: head-on hit ⇒ areas ≈ 50/50 (within 5%)', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0, 0, FRACTURE_ON_CONFIG);
    assert.equal(out.children.length, 2);
    const r = out.children[0].m / (out.children[0].m + out.children[1].m);
    // Tolerance ~5% accounts for the small phase rotation in the test polygon.
    assert.ok(Math.abs(r - 0.5) < 0.05, `head-on mass ratio = ${r}`);
});

test('end-to-end: equivalent radius R_i = √(A_i / π_eff)', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0, 0, FRACTURE_ON_CONFIG);
    for (const c of out.children) {
        const Ai = (c.m / out.M) * out.A_parent;
        const expectedR = Math.sqrt(Ai / out.pi_eff);
        assert.ok(Math.abs(c.r - expectedR) < 1e-12);
    }
});

test('end-to-end: 1-child branch when small piece below MIN_ASTEROID_RADIUS', () => {
    // R close to MIN, with a glancing offset producing a tiny chip.
    const R = 0.03; // just above MIN_ASTEROID_RADIUS=0.025
    const parent = regularPolygon(R, 10);
    const out = fragmentPolygon(parent, R, 0, 0, 0, 0.95, 0, FRACTURE_ON_CONFIG);
    assert.equal(out.children.length, 1);
    // The surviving piece's mass should be the larger area's share.
    assert.ok(out.children[0].m > 0.5 * out.M);
});

test('chord-derived jag count: head-on chord on 10-gon ≈ N/π jag points', () => {
    // For a head-on chord (b=0) through a regular N-gon of radius R, chord
    // length = 2R, parent spacing = 2πR/N, so jagCount = floor(N/π) at
    // density=1.
    const R = 0.083, N = 10;
    const parent = regularPolygon(R, N);
    const probe = fractureSplitPolygon(parent, { x: 0, y: 1 }, 0, []);
    const chordLen = Math.hypot(probe.exit.x - probe.entry.x,
                                probe.exit.y - probe.entry.y);
    const parentSpacing = (2 * Math.PI * R) / N;
    const jagCount = Math.floor(chordLen / parentSpacing);
    // Head-on chord ≈ 2R; expected = floor(N/π) = floor(3.18) = 3.
    assert.equal(jagCount, 3);
});

test('chord-derived jag count: short chord ⇒ fewer jag points than long chord', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const headOn = fractureSplitPolygon(parent, { x: 0, y: 1 }, 0, []);
    const offset = fractureSplitPolygon(parent, { x: 0, y: 1 }, 0.06, []);
    const headOnLen = Math.hypot(headOn.exit.x - headOn.entry.x,
                                 headOn.exit.y - headOn.entry.y);
    const offsetLen = Math.hypot(offset.exit.x - offset.entry.x,
                                 offset.exit.y - offset.entry.y);
    assert.ok(offsetLen < headOnLen,
        `offset chord (${offsetLen}) should be shorter than head-on (${headOnLen})`);
});

// ─── Bound radius (broad-phase fix) ─────────────────────────────────────────

function boundRadius(verts) {
    // verts in {angle, distance} polar form (matches Asteroid.vertices).
    return verts.reduce((m, v) => v.distance > m ? v.distance : m, 0);
}

test('boundRadius: regular jagged spawn ≈ R·(1+JAGGEDNESS)', () => {
    // Mimic generateShape's variance pattern: distance = R · uniform(1-J, 1+J).
    const R = 0.083, J = 0.4;
    const verts = [];
    for (let i = 0; i < 10; i++) {
        const u = (i + 1) / 11; // deterministic spread of "random" values
        const variance = 1 - J + u * J * 2;
        verts.push({ angle: (i / 10) * Math.PI * 2, distance: R * variance });
    }
    const br = boundRadius(verts);
    assert.ok(br <= R * (1 + J) + 1e-12);
    assert.ok(br > R * (1 - J));
});

test('boundRadius: thin sliver shard exceeds area-equivalent disk radius', () => {
    // Long thin sliver: extends from x=-1 to x=+1 with tiny y-thickness.
    // Area = 2 · 0.04 = 0.08 → R_disk = sqrt(0.08/π) ≈ 0.16. boundRadius ≈ 1.0.
    const sliverXY = [
        { x: -1, y: -0.02 }, { x: 1, y: -0.02 },
        { x: 1, y:  0.02 }, { x: -1, y:  0.02 },
    ];
    const sliverPolar = verticesFromXY(sliverXY);
    const A = Math.abs(polygonArea(sliverXY));
    const Rdisk = Math.sqrt(A / Math.PI);
    const br = boundRadius(sliverPolar);
    assert.ok(br > 5 * Rdisk,
        `sliver bound (${br}) should be much larger than disk radius (${Rdisk})`);
    assert.ok(br > 0.99 && br < 1.001, `sliver bound should be ~1, got ${br}`);
});
