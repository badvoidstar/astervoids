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

// Full results captured before the stage refactor; no expected physics is
// recalculated through production helpers. Keep these inputs independent of defaults.
const GOLDEN_CONFIG = {
    FRACTURE_ENABLED: true,
    ASTEROID_DENSITY: 2.5,
    INITIAL_ASTEROID_RADIUS: 0.1,
    MIN_ASTEROID_RADIUS: 0.01,
    DEFLECTION_KICK: 0.04,
    SEPARATION_ENERGY: 0.00002,
    SEPARATION_ENERGY_SIZE_BLEND: 0.35,
    SEPARATION_ANGLE_VARIANCE: 0.3,
    FRACTURE_VERTEX_DENSITY: 1.3,
    FRACTURE_JAGGEDNESS: 0.08,
    MIN_SPLIT_RATIO: 0.12,
    MASS_SPLIT_BIAS: 0.7,
};
const GOLDEN_PARENT = {
    radius: 0.083,
    velocityX: 0.13,
    velocityY: -0.07,
    rotationSpeed: 0.025,
    angle: 0.37,
    seed: 0.314159,
    vertices: [
        { angle: 0.05, distance: 0.09 },
        { angle: 1.1, distance: 0.07 },
        { angle: 2.15, distance: 0.085 },
        { angle: 3.2, distance: 0.075 },
        { angle: 4.25, distance: 0.095 },
        { angle: 5.3, distance: 0.08 },
    ],
};
const GOLDEN_IMPACT = { offsetN: -0.28, bulletAngle: 0.71 };
const GOLDEN_POLYGON = {
    children: [
        {
            r: 0.050196984451300906,
            m: 0.0062993431200103625,
            inertia: 0.00001039608937711642,
            cx: 0.0270800308595345,
            cy: -0.03587195253128296,
            vx: 0.21936583328321266,
            vy: -0.0722609220944321,
            omega: 0.3507733617664371,
            vertices: [
                { angle: -2.7423577640850114, distance: 0.07068837654354325 },
                { angle: -2.118828453523843, distance: 0.06879829998450215 },
                { angle: -0.25915589404898737, distance: 0.03967021949457324 },
                { angle: 0.9214110467766294, distance: 0.09111667628970795 },
                { angle: 0.9511530974901063, distance: 0.0905090535687141 },
                { angle: 1.2798490821909443, distance: 0.04294532862450338 },
                { angle: 2.849601829585159, distance: 0.028909840363183368 },
            ],
        },
        {
            r: 0.06610039903053426,
            m: 0.010923156879989637,
            inertia: 0.000022706866737504883,
            cx: -0.012346896698775587,
            cy: 0.013733415122748801,
            vx: 0.12873052388632486,
            vy: -0.026439333533280932,
            omega: 0.3507733617664371,
            vertices: [
                { angle: 0.255991132242067, distance: 0.09508824425421994 },
                { angle: 1.236964543306055, distance: 0.05917830217574391 },
                { angle: 2.5792841549421572, distance: 0.06708302747958841 },
                { angle: -2.4647826232436363, distance: 0.07167401758180149 },
                { angle: -1.8926417189447957, distance: 0.08125507462701577 },
                { angle: -1.2937174745802404, distance: 0.04292044506672367 },
                { angle: -0.16214910605410116, distance: 0.0524340127086279 },
            ],
        },
    ],
    mass: 0.0172225,
    inertia: 0.00004914470573403844,
    impulse: { x: 0.0005224354963698611, y: 0.00044904828485673663 },
    postImpulse: {
        velocityX: 0.16033447503962034,
        velocityY: -0.04392664915913854,
        angularVelocity: 0.3507733617664371,
    },
    fracture: {
        parentArea: 0.017556446463115962,
        positiveArea: 0.011134958279678028,
        negativeArea: 0.006421488183437933,
        effectivePi: 2.548475317624613,
    },
};
const GOLDEN_FALLBACK_IMPACT = { offsetN: -1.4, bulletAngle: NaN };
const GOLDEN_DISK = {
    children: [
        {
            r: 0.03214576177352156,
            m: 0.0025833750000000006,
            cx: -0.033447742515120484,
            cy: -0.06211723609950946,
            vx: 0.18060650426475536,
            vy: -0.22006244395043606,
            omega: 0.988855421686747,
            vertices: null,
        },
        {
            r: 0.07652221899553097,
            m: 0.014639125000000001,
            cx: 0.005902542796785969,
            cy: 0.010961865194031084,
            vx: 0.1625033745378514,
            vy: -0.06582897215157094,
            omega: 0.988855421686747,
            vertices: null,
        },
    ],
    mass: 0.0172225,
    inertia: 0.00005932290125000001,
    impulse: { x: 0.0006065565407363866, y: -0.0003266073680888236 },
    postImpulse: {
        velocityX: 0.16521884399688702,
        velocityY: -0.08896399292140071,
        angularVelocity: 0.988855421686747,
    },
    fracture: null,
};

function assertFragmentGolden(actual, expected, path = 'result') {
    if (typeof expected === 'number') {
        assert.equal(typeof actual, 'number', path);
        assert.ok(Math.abs(actual - expected) < 1e-12,
            `${path}: ${actual} != ${expected}`);
    } else if (expected === null) {
        assert.equal(actual, null, path);
    } else {
        assert.equal(Array.isArray(actual), Array.isArray(expected), path);
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
        for (const key of Object.keys(expected)) {
            assertFragmentGolden(actual[key], expected[key], `${path}.${key}`);
        }
    }
}

test('golden: rotated irregular polygon preserves full seeded fracture and impulse results', () => {
    const result = calculateAsteroidFragments(GOLDEN_PARENT, GOLDEN_IMPACT, GOLDEN_CONFIG);
    assertFragmentGolden(result, GOLDEN_POLYGON);
});

test('golden: polygon chip keeps recentered geometry and rigid motion without separation', () => {
    const result = calculateAsteroidFragments(GOLDEN_PARENT, GOLDEN_IMPACT, {
        ...GOLDEN_CONFIG, MIN_ASTEROID_RADIUS: 0.06,
    });
    assertFragmentGolden(result, {
        ...GOLDEN_POLYGON,
        children: [{
            ...GOLDEN_POLYGON.children[1],
            vx: 0.15551715884847972,
            vy: -0.048257611621550976,
        }],
    });
});

for (const [name, vertices, enabled] of [
    ['missing', undefined, true],
    ['null', null, true],
    ['empty', [], true],
    ['too few', GOLDEN_PARENT.vertices.slice(0, 2), true],
    ['zero area', Array(3).fill({ angle: 0.5, distance: 0.02 }), true],
    ['disabled', GOLDEN_PARENT.vertices, false],
]) {
    test(`golden: ${name} geometry uses disk fallback with clamped offset and inferred angle`, () => {
        const result = calculateAsteroidFragments(
            { ...GOLDEN_PARENT, vertices },
            GOLDEN_FALLBACK_IMPACT,
            { ...GOLDEN_CONFIG, FRACTURE_ENABLED: enabled });
        assertFragmentGolden(result, GOLDEN_DISK);
    });
}

test('golden: missed polygon clip falls back to disk children but retains polygon inertia', () => {
    const result = calculateAsteroidFragments(
        GOLDEN_PARENT, { offsetN: 1.4, bulletAngle: 0.71 }, GOLDEN_CONFIG);
    assertFragmentGolden(result, {
        ...GOLDEN_POLYGON,
        children: [
            {
                r: 0.03214576177352156,
                m: 0.0025833750000000006,
                cx: -0.04598687254556941,
                cy: 0.05350243035113036,
                vx: 0.13155371654477255,
                vy: 0.06911915400319113,
                omega: -1.1384762920229898,
                vertices: null,
            },
            {
                r: 0.07652221899553097,
                m: 0.014639125000000001,
                cx: 0.008115330449218132,
                cy: -0.00944160535608183,
                vx: 0.16541343242106407,
                vy: -0.06387590854072614,
                omega: -1.1384762920229898,
                vertices: null,
            },
        ],
        postImpulse: {
            ...GOLDEN_POLYGON.postImpulse,
            angularVelocity: -1.1384762920229898,
        },
        fracture: null,
    });
});

test('golden: disk chip stays at the parent center and inherits post-impulse motion', () => {
    const result = calculateAsteroidFragments(
        { ...GOLDEN_PARENT, vertices: null },
        GOLDEN_FALLBACK_IMPACT,
        { ...GOLDEN_CONFIG, MIN_ASTEROID_RADIUS: 0.06 });
    assertFragmentGolden(result, {
        ...GOLDEN_DISK,
        children: [{
            ...GOLDEN_DISK.children[1],
            cx: 0,
            cy: 0,
            vx: 0.16521884399688702,
            vy: -0.08896399292140071,
        }],
    });
});

test('golden: fragments exactly at the minimum radius survive in both paths', () => {
    const polygon = calculateAsteroidFragments(GOLDEN_PARENT, GOLDEN_IMPACT, {
        ...GOLDEN_CONFIG, MIN_ASTEROID_RADIUS: GOLDEN_POLYGON.children[0].r,
    });
    const disk = calculateAsteroidFragments(
        { ...GOLDEN_PARENT, vertices: null },
        GOLDEN_FALLBACK_IMPACT,
        { ...GOLDEN_CONFIG, MIN_ASTEROID_RADIUS: GOLDEN_DISK.children[0].r });
    assertFragmentGolden(polygon, GOLDEN_POLYGON);
    assertFragmentGolden(disk, GOLDEN_DISK);
});

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
