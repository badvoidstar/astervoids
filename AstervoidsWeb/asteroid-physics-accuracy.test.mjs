/**
 * Tests for the four asteroid-physics accuracy improvements:
 *   1. Radius-calibrated parent mass (baseline-preserving)
 *   2. True centroidal polygon moment of inertia
 *   3. Actual polygon-boundary impact point and resulting torque/spin
 *   4. Fragment-specific inertia and mass conservation
 *
 * Run with:  node --test AstervoidsWeb/asteroid-physics-accuracy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AstervoidsConfig = require('./wwwroot/js/game-config.js');
const AstervoidsFracture = require('./wwwroot/js/asteroid-fracture.js');

const {
    polygonArea,
    polygonMomentOfInertia,
    polygonRayIntersect,
    verticesFromXY,
    calculateAsteroidFragments,
} = AstervoidsFracture;

const CONFIG = AstervoidsConfig.SHARED_DEFAULTS;
const FRACTURE_ON = { ...CONFIG, FRACTURE_ENABLED: true };
const FRACTURE_OFF = { ...CONFIG, FRACTURE_ENABLED: false };

// ── Polygon helpers ───────────────────────────────────────────────────────────

function regularPolygon(R, n = 10, phase = 0.07) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + phase;
        out.push({ x: Math.cos(a) * R, y: Math.sin(a) * R });
    }
    return out;
}

function makeAsteroid(verts, R, vx = 0, vy = 0, omega = 0) {
    return {
        radius: R,
        velocityX: vx,
        velocityY: vy,
        rotationSpeed: omega,
        angle: 0,
        seed: 0,
        vertices: verticesFromXY(verts),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GOAL 1: Radius-calibrated parent mass
// ─────────────────────────────────────────────────────────────────────────────

test('Goal1: regular-polygon mass equals legacy disk mass (baseline calibration)', () => {
    // Parent mass is density * R² regardless of polygon area.
    const R = 0.083;
    const density = CONFIG.ASTEROID_DENSITY;
    const legacyMass = density * R * R;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0, bulletAngle: 0 }, FRACTURE_ON);
    assert.ok(
        Math.abs(result.mass - legacyMass) < 1e-12,
        `mass=${result.mass} legacyMass=${legacyMass}`);
});

test('Goal1: irregular polygon mass uses radius rather than actual area', () => {
    // Build a rectangle (width=2R, height=R/2) — area = R² vs circle ~π R².
    // It still has mass = density * R² despite the different area.
    const R = 0.083;
    const density = CONFIG.ASTEROID_DENSITY;
    const legacyMass = density * R * R;

    // Right-angled rectangle centred on origin.
    const rect = [
        { x: -R, y: -R / 4 }, { x: R, y: -R / 4 },
        { x: R, y:  R / 4 }, { x: -R, y:  R / 4 },
    ];
    const result = calculateAsteroidFragments(
        makeAsteroid(rect, R), { offsetN: 0, bulletAngle: 0 }, FRACTURE_ON);
    // Still calibrated: mass = density * R²
    assert.ok(
        Math.abs(result.mass - legacyMass) < 1e-12,
        `mass=${result.mass} legacyMass=${legacyMass}`);
});

test('Goal1: fallback mass for missing vertices equals legacy disk', () => {
    const R = 0.083;
    const density = CONFIG.ASTEROID_DENSITY;
    const legacyMass = density * R * R;
    const ast = { radius: R, velocityX: 0, velocityY: 0, rotationSpeed: 0,
                  angle: 0, seed: 0, vertices: null };
    const result = calculateAsteroidFragments(
        ast, { offsetN: 0, bulletAngle: 0 }, FRACTURE_ON);
    assert.ok(
        Math.abs(result.mass - legacyMass) < 1e-12,
        `fallback mass=${result.mass} should equal ${legacyMass}`);
});

test('Goal1: fallback mass for empty vertices equals legacy disk', () => {
    const R = 0.083;
    const density = CONFIG.ASTEROID_DENSITY;
    const legacyMass = density * R * R;
    const ast = { radius: R, velocityX: 0, velocityY: 0, rotationSpeed: 0,
                  angle: 0, seed: 0, vertices: [] };
    const result = calculateAsteroidFragments(
        ast, { offsetN: 0, bulletAngle: 0 }, FRACTURE_ON);
    assert.ok(
        Math.abs(result.mass - legacyMass) < 1e-12,
        `fallback mass (empty verts)=${result.mass} should equal ${legacyMass}`);
});

test('Goal1: fracture-disabled path still uses disk mass', () => {
    const R = 0.083;
    const density = CONFIG.ASTEROID_DENSITY;
    const legacyMass = density * R * R;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0, bulletAngle: 0 }, FRACTURE_OFF);
    assert.ok(
        Math.abs(result.mass - legacyMass) < 1e-12,
        `disk-split mass=${result.mass} should equal ${legacyMass}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GOAL 2: True centroidal polygon moment of inertia
// ─────────────────────────────────────────────────────────────────────────────

test('Goal2: polygonMomentOfInertia – unit square analytical value', () => {
    // Centroidal I of a unit square with mass M:
    //   I = M/12 * (w² + h²) = M/12 * (1+1) = M/6
    // Our polygon is [0,0]..[1,0]..[1,1]..[0,1], centroid at (0.5,0.5).
    // polygonMomentOfInertia receives the polygon in LOCAL coords (already
    // centred), so shift to centred: [−0.5,−0.5]..[0.5,−0.5] etc.
    const M = 1;
    const centred = [
        { x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 },
        { x: 0.5, y:  0.5 }, { x: -0.5, y:  0.5 },
    ];
    const I = polygonMomentOfInertia(centred, M, 1);
    const expected = M / 6;
    assert.ok(
        Math.abs(I - expected) < 1e-12,
        `I=${I} expected=${expected}`);
});

test('Goal2: polygonMomentOfInertia – unit square origin-centred polygon', () => {
    // Same as above but pass the origin-offset polygon; function must apply
    // parallel-axis correction to return centroidal inertia.
    const M = 1;
    const origin = [
        { x: 0, y: 0 }, { x: 1, y: 0 },
        { x: 1, y: 1 }, { x: 0, y: 1 },
    ];
    const I = polygonMomentOfInertia(origin, M, 1);
    const expected = M / 6;
    assert.ok(
        Math.abs(I - expected) < 1e-12,
        `I (origin polygon)=${I} expected=${expected}`);
});

test('Goal2: polygon inertia less than disk approximation for regular polygon', () => {
    // For a regular polygon the true inertia is less than the disk (which
    // overcounts vertices at the circumradius).
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const M = CONFIG.ASTEROID_DENSITY * R * R;
    const I = polygonMomentOfInertia(parent, M, R);
    const diskI = 0.5 * M * R * R;
    // Regular polygon: I < 0.5 M R² (polygon inscribed in circle ⇒ less area)
    assert.ok(I < diskI, `polygon I=${I} should be < disk I=${diskI}`);
    assert.ok(I > 0, `polygon I must be positive`);
});

test('Goal2: polygonMomentOfInertia fallback for null polygon', () => {
    const M = 1, R = 1;
    const I = polygonMomentOfInertia(null, M, R);
    assert.ok(Math.abs(I - 0.5 * M * R * R) < 1e-12,
        `null polygon should return disk fallback`);
});

test('Goal2: polygonMomentOfInertia fallback for degenerate (2-vertex) polygon', () => {
    const M = 1, R = 1;
    const I = polygonMomentOfInertia([{ x: 0, y: 0 }, { x: 1, y: 0 }], M, R);
    assert.ok(Math.abs(I - 0.5 * M * R * R) < 1e-12,
        `degenerate polygon should return disk fallback`);
});

test('Goal2: polygon inertia used in calculateAsteroidFragments (not disk)', () => {
    // Verify the inertia returned from calculateAsteroidFragments is NOT
    // equal to the disk value 0.5*M*R² for a non-circular polygon.
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0, bulletAngle: 0 }, FRACTURE_ON);
    const diskI = 0.5 * result.mass * R * R;
    assert.notEqual(result.inertia, diskI);
    assert.ok(result.inertia > 0);
});

test('Goal2: fallback to disk inertia when no polygon available', () => {
    const R = 0.083;
    const ast = { radius: R, velocityX: 0, velocityY: 0, rotationSpeed: 0,
                  angle: 0, seed: 0, vertices: null };
    const result = calculateAsteroidFragments(
        ast, { offsetN: 0, bulletAngle: 0 }, FRACTURE_ON);
    const diskI = 0.5 * result.mass * R * R;
    assert.ok(Math.abs(result.inertia - diskI) < 1e-12,
        `no-vertex fallback inertia should equal disk`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GOAL 3: Actual polygon-boundary impact point
// ─────────────────────────────────────────────────────────────────────────────

test('Goal3: polygonRayIntersect – head-on ray hits circle-like polygon at -R', () => {
    // For a head-on ray through the origin on a regular 10-gon of radius R,
    // the entry intersection should have x ≈ -R and y ≈ 0.
    const R = 0.083;
    const poly = regularPolygon(R, 10, 0); // no phase for clean geometry
    const hit = polygonRayIntersect(poly, 0, 0, 1, 0); // ray along +x from origin
    assert.ok(hit !== null, 'should find intersection');
    // Entry intersection must be behind origin (x < 0) at approximately -R
    assert.ok(hit.x < 0, `hit.x=${hit.x} should be < 0`);
    assert.ok(Math.abs(hit.x + R) < R * 0.15,
        `hit.x=${hit.x} should be near -R=${-R}`);
    assert.ok(Math.abs(hit.y) < R * 0.15, `hit.y=${hit.y} should be near 0`);
});

test('Goal3: polygonRayIntersect – offset ray hits correct edge', () => {
    // Ray along +x, offset by R/2 in y → should hit left edge of polygon.
    const R = 0.083;
    const poly = regularPolygon(R, 10, 0);
    const hit = polygonRayIntersect(poly, 0, R / 2, 1, 0);
    assert.ok(hit !== null, 'offset ray should find intersection');
    assert.ok(hit.x < 0, 'entry should be on left side');
    assert.ok(Math.abs(hit.y - R / 2) < R * 0.05,
        `hit.y=${hit.y} should be near ${R/2}`);
});

test('Goal3: polygonRayIntersect – ray entirely outside polygon returns null', () => {
    const R = 0.083;
    const poly = regularPolygon(R, 10, 0);
    // Ray offset far outside the polygon
    const hit = polygonRayIntersect(poly, 0, 2 * R, 1, 0);
    assert.equal(hit, null, 'miss ray should return null');
});

test('Goal3: polygonRayIntersect – null for degenerate polygon', () => {
    const hit = polygonRayIntersect([{ x: 0, y: 0 }], 0, 0, 1, 0);
    assert.equal(hit, null);
});

test('Goal3: polygon impact point produces torque for off-centre hit', () => {
    // Hit a regular 10-gon off-centre (offsetN=0.5). The impact point should
    // be on the polygon boundary and produce non-zero torque → spin.
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R, 0, 0, 0),
        { offsetN: 0.5, bulletAngle: 0 }, // bullet along +x, offset up
        FRACTURE_ON);
    // Off-centre hit must produce angular velocity change.
    assert.ok(
        Math.abs(result.postImpulse.angularVelocity) > 0,
        `off-centre polygon hit should produce spin, got ${result.postImpulse.angularVelocity}`);
});

test('Goal3: head-on hit (offsetN=0) on symmetric polygon produces near-zero spin', () => {
    // Symmetric head-on hit on a regular polygon centred at origin should
    // produce ~zero torque (impact point at x≈-R, y≈0 → torque≈0).
    const R = 0.083;
    const parent = regularPolygon(R, 10, 0); // no phase offset for symmetry
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R, 0, 0, 0),
        { offsetN: 0, bulletAngle: 0 },
        FRACTURE_ON);
    // Torque ≈ impact.x * impulse.y - impact.y * impulse.x
    // impact.y ≈ 0, impulse.y=0 → torque ≈ 0
    assert.ok(
        Math.abs(result.postImpulse.angularVelocity) < 1e-6,
        `head-on spin=${result.postImpulse.angularVelocity} should be ~0`);
});

test('Goal3: determinism – identical inputs produce identical impact results', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const params = [makeAsteroid(parent, R, 0.01, -0.02, 0.1),
                    makeAsteroid(parent, R, 0.01, -0.02, 0.1)];
    const impact = { offsetN: 0.3, bulletAngle: Math.PI / 6 };
    const r1 = calculateAsteroidFragments(params[0], impact, FRACTURE_ON);
    const r2 = calculateAsteroidFragments(params[1], impact, FRACTURE_ON);
    assert.equal(r1.postImpulse.angularVelocity, r2.postImpulse.angularVelocity);
    assert.equal(r1.postImpulse.velocityX, r2.postImpulse.velocityX);
    assert.equal(r1.postImpulse.velocityY, r2.postImpulse.velocityY);
});

// ─────────────────────────────────────────────────────────────────────────────
// GOAL 4: Fragment-specific inertia
// ─────────────────────────────────────────────────────────────────────────────

test('Goal4: fracture children carry inertia field', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0.2, bulletAngle: 0 }, FRACTURE_ON);
    assert.equal(result.children.length, 2);
    for (const child of result.children) {
        assert.ok(typeof child.inertia === 'number' && child.inertia > 0,
            `child.inertia=${child.inertia} should be a positive number`);
    }
});

test('Goal4: fragment inertia differs from equivalent-disk approximation', () => {
    // For non-circular fragments the polygon inertia differs from 0.5*m*r²
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0.2, bulletAngle: 0 }, FRACTURE_ON);
    for (const child of result.children) {
        const diskI = 0.5 * child.m * child.r * child.r;
        // The fragment inertia should differ from the disk by more than floating-point noise.
        assert.ok(Math.abs(child.inertia - diskI) > 1e-12,
            `child inertia=${child.inertia} should differ from disk=${diskI}`);
    }
});

test('Goal4: mass conservation with fragment-specific inertia', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R, 0.05, -0.02, 0.02),
        { offsetN: 0.3, bulletAngle: Math.PI / 4 }, FRACTURE_ON);
    const totalM = result.children.reduce((a, c) => a + c.m, 0);
    assert.ok(Math.abs(totalM - result.mass) < 1e-12,
        `Σm=${totalM} M=${result.mass}`);
});

test('Goal4: angular momentum (no separation energy) with fragment-specific inertia', () => {
    // Without separation energy, all child angular momentum should equal
    // the parent's post-impact spin + orbital angular momentum.
    // (Separation kick adds energy and can change angular momentum if
    //  its direction is not purely radial relative to the fracture centre.)
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const vx = 0.05, vy = -0.02, omega = 0.5;
    const noSepConfig = { ...FRACTURE_ON, SEPARATION_ENERGY: 0 };
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R, vx, vy, omega),
        { offsetN: 0.3, bulletAngle: Math.PI / 4 }, noSepConfig);

    const Lparent_spin = result.inertia * omega;
    const dL = (result.postImpulse.angularVelocity - omega) * result.inertia;

    // Children angular momentum: spin + orbital about parent origin.
    const Lafter_children = result.children.reduce((a, c) => {
        const I_c = c.inertia ?? (0.5 * c.m * c.r * c.r);
        const Lspin = I_c * c.omega;
        const Lorbit = c.cx * (c.m * c.vy) - c.cy * (c.m * c.vx);
        return a + Lspin + Lorbit;
    }, 0);

    const expected = Lparent_spin + dL;
    assert.ok(Math.abs(Lafter_children - expected) < 1e-9,
        `L_after=${Lafter_children} expected=${expected}`);
});

test('Goal4: 1-child path carries inertia field', () => {
    const R = 0.03;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0.95, bulletAngle: 0 }, FRACTURE_ON);
    assert.equal(result.children.length, 1,
        'glancing hit should produce 1-child branch');
    const child = result.children[0];
    assert.ok(typeof child.inertia === 'number' && child.inertia > 0,
        `1-child inertia=${child.inertia} should be positive`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: legacy disk-split (FRACTURE_OFF) still works as before
// ─────────────────────────────────────────────────────────────────────────────

test('Regression: legacy disk-split mass conservation', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R, 0.1, -0.05, 0.01),
        { offsetN: 0.2, bulletAngle: Math.PI / 4 }, FRACTURE_OFF);
    const totalM = result.children.reduce((a, c) => a + c.m, 0);
    assert.ok(Math.abs(totalM - result.mass) < 1e-12,
        `legacy Σm=${totalM} M=${result.mass}`);
});

test('Regression: legacy disk-split linear momentum conservation', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const vx = 0.1, vy = -0.05;
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R, vx, vy, 0),
        { offsetN: 0.2, bulletAngle: Math.PI / 4 }, FRACTURE_OFF);
    const px = result.children.reduce((a, c) => a + c.m * c.vx, 0);
    const py = result.children.reduce((a, c) => a + c.m * c.vy, 0);
    assert.ok(Math.abs(px - (result.mass * vx + result.impulse.x)) < 1e-12);
    assert.ok(Math.abs(py - (result.mass * vy + result.impulse.y)) < 1e-12);
});

test('Regression: legacy disk-split children have null vertices', () => {
    const R = 0.083;
    const parent = regularPolygon(R, 10);
    const result = calculateAsteroidFragments(
        makeAsteroid(parent, R), { offsetN: 0.2, bulletAngle: 0 }, FRACTURE_OFF);
    for (const child of result.children) {
        assert.equal(child.vertices, null);
    }
});
