// Regression: asteroid wrap must use the polygon's true bounding radius
// (max vertex distance from center), NOT the design radius. Jagged spawn
// asteroids have vertices reaching up to (1 + ASTEROID_JAGGEDNESS) ×
// radius, and fracture-shard polygons can be even more elongated. Wrapping
// on `radius` makes the asteroid disappear while a slice of its silhouette
// is still on screen — perceived as "the wrap fires too early" by ~30 px
// on a typical 720-tall canvas.
//
// This test pins the invariant that a wrap is triggered exactly when the
// LEADING EDGE OF THE VISIBLE POLYGON crosses the off-screen edge by zero
// pixels, regardless of viewport aspect ratio. It also covers fracture
// children whose explicit vertex list extends further than `radius`.
//
// Run with: node --test AstervoidsWeb/wrap-bound-radius.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const CONFIG = { ...require('./wwwroot/js/game-config.js').SHARED_DEFAULTS };
const AstervoidsWireCodec = require('./wwwroot/js/astervoids-wire-codec.js');
const OBJECT_TYPES = { ASTEROID: 'asteroid', SHIP: 'ship', BULLET: 'bullet' };
const viewport = { width: 1920, height: 1080 };
const production = loadInlineGameFunctions([
    'Asteroid', 'wrapNormalized', 'wrapMarginX', 'wrapMarginY',
    'velocityToNormalizedDeltaX', 'velocityToNormalizedDeltaY', 'getRemoteBoundingRadius',
], {
    CONFIG,
    OBJECT_TYPES,
    AstervoidsWireCodec,
    AstervoidsFracture: require('./wwwroot/js/asteroid-fracture.js'),
    getGameWidth: () => viewport.width,
    getGameHeight: () => viewport.height,
    getReferenceDimension: () => Math.min(viewport.width, viewport.height),
    getEffectiveAsteroidAspectScales: () => ({ speedScale: 1 }),
    randomRange: () => 0,
});
const { wrapNormalized, Asteroid, getRemoteBoundingRadius } = production;

function wrapMarginX(radius, W, H) {
    viewport.width = W;
    viewport.height = H;
    return production.wrapMarginX(radius);
}

function wrapMarginY(radius, W, H) {
    viewport.width = W;
    viewport.height = H;
    return production.wrapMarginY(radius);
}

// A stationary production asteroid whose polygon extends beyond its design
// radius. Calling update checks the actual choice of wrap radius, not a mirror.
function asteroidWrapWithBound(x, y, boundRadius, W, H) {
    viewport.width = W;
    viewport.height = H;
    const asteroid = new Asteroid(x, y, boundRadius / 2, 0, 0, 0, [
        { angle: 0, distance: boundRadius },
    ]);
    asteroid.update(0);
    return { x: asteroid.x, y: asteroid.y };
}

// Mirror of the OLD (buggy) Asteroid.update wrap logic — only kept for the
// regression docs assertions below.
function asteroidWrapWithRadius(x, y, radius, W, H) {
    return {
        x: wrapNormalized(x, wrapMarginX(radius, W, H)),
        y: wrapNormalized(y, wrapMarginY(radius, W, H)),
    };
}

function maxVertexDistance(vertices) {
    return vertices.reduce((m, v) => v.distance > m ? v.distance : m, 0);
}

function generateJaggedShape(radius, seed, vertexCount = 10, jaggedness = 0.4) {
    CONFIG.ASTEROID_VERTICES = vertexCount;
    CONFIG.ASTEROID_JAGGEDNESS = jaggedness;
    return Asteroid.prototype.generateShape.call({ radius, seed });
}

test('wrap fires exactly when the visible polygon clears the right edge (landscape)', () => {
    const W = 1920, H = 1080; // 16:9
    const refDim = Math.min(W, H); // 1080
    const radius = 0.083;
    const vertices = generateJaggedShape(radius, 12345);
    const boundR = maxVertexDistance(vertices);
    assert.ok(boundR > radius, 'jagged shape must extend past design radius');
    assert.ok(boundR <= radius * 1.4001, 'jagged shape capped at (1 + jaggedness) × radius');

    // Place the asteroid so its leftmost visible vertex is exactly at the
    // right screen edge (W). Center is at center_pixel = W + boundR_pixels;
    // normalized x = center_pixel / W = 1 + boundR · refDim / W.
    const wrapMomentX = 1 + wrapMarginX(boundR, W, H);
    // Anything strictly less should NOT wrap; anything strictly more SHOULD.
    const justBelow = wrapMomentX - 1e-9;
    const justAbove = wrapMomentX + 1e-3;

    const below = asteroidWrapWithBound(justBelow, 0.5, boundR, W, H);
    const above = asteroidWrapWithBound(justAbove, 0.5, boundR, W, H);

    assert.equal(below.x, justBelow, 'pre-wrap value must pass through unchanged');
    assert.ok(above.x < 0, 'post-wrap value must come out the left side (negative)');
});

test('OLD radius-based wrap (regression doc) fires while polygon is still visible', () => {
    const W = 1920, H = 1080;
    const radius = 0.083;
    const vertices = generateJaggedShape(radius, 12345);
    const boundR = maxVertexDistance(vertices);
    const refDim = Math.min(W, H);

    // Old wrap used `radius` not boundR. At wrap moment the center is
    // (radius · refDim) past edge; leftmost visible vertex is still
    // (boundR - radius) · refDim INSIDE the screen.
    const oldWrapMoment = 1 + wrapMarginX(radius, W, H);
    const centerPixelAtWrap = oldWrapMoment * W;
    const leftmostVisiblePixel = centerPixelAtWrap - boundR * refDim;
    const visibleStillInsidePixels = W - leftmostVisiblePixel;

    assert.ok(visibleStillInsidePixels > 5,
        `old wrap leaves ~${visibleStillInsidePixels.toFixed(1)} px still on screen — bug`);
    assert.ok(visibleStillInsidePixels < 40,
        `magnitude bounded by jaggedness (≤ JAGGEDNESS · radius · refDim ≈ 36 px on 1080-tall canvas)`);
});

test('wrap is symmetric in pixels across both axes (16:9 landscape)', () => {
    const W = 1920, H = 1080;
    const refDim = Math.min(W, H); // 1080
    const radius = 0.05;
    const vertices = generateJaggedShape(radius, 99);
    const boundR = maxVertexDistance(vertices);

    // Wrap-trigger center positions in PIXELS for each axis.
    const wrapXNorm = 1 + wrapMarginX(boundR, W, H);
    const wrapYNorm = 1 + wrapMarginY(boundR, W, H);
    const wrapXPixel = wrapXNorm * W;
    const wrapYPixel = wrapYNorm * H;
    const overshootXPixel = wrapXPixel - W;
    const overshootYPixel = wrapYPixel - H;

    assert.ok(Math.abs(overshootXPixel - overshootYPixel) < 1e-6,
        `pixel overshoot at wrap must be equal on both axes (X=${overshootXPixel}, Y=${overshootYPixel})`);
    assert.ok(Math.abs(overshootXPixel - boundR * refDim) < 1e-6,
        'overshoot in pixels equals boundRadius × refDim');
});

test('wrap is symmetric in pixels across both axes (portrait 9:16)', () => {
    const W = 1080, H = 1920;
    const refDim = Math.min(W, H); // 1080
    const radius = 0.05;
    const vertices = generateJaggedShape(radius, 7);
    const boundR = maxVertexDistance(vertices);

    const overshootXPixel = (1 + wrapMarginX(boundR, W, H)) * W - W;
    const overshootYPixel = (1 + wrapMarginY(boundR, W, H)) * H - H;

    assert.ok(Math.abs(overshootXPixel - overshootYPixel) < 1e-6,
        `pixel overshoot at wrap must be equal on both axes (X=${overshootXPixel}, Y=${overshootYPixel})`);
});

test('fracture-shard polygon (long sliver) wraps based on max vertex distance, not area-equivalent radius', () => {
    const W = 1600, H = 900;
    // A long thin sliver: most vertices clustered near the center, but a few
    // reach far out. Area-equivalent disk radius is small, but the actual
    // bounding extent is much larger.
    const sliverVertices = [
        { angle: 0,            distance: 0.25 },
        { angle: Math.PI * 0.1, distance: 0.05 },
        { angle: Math.PI,      distance: 0.05 },
        { angle: Math.PI * 1.1, distance: 0.05 },
    ];
    const areaEquivRadius = 0.06; // small — what `radius` would be for a sliver
    const boundR = maxVertexDistance(sliverVertices);
    assert.ok(boundR > 4 * areaEquivRadius, 'sliver bound radius dominates the area-equivalent radius');

    // Old (buggy) wrap on areaEquivRadius would fire much too early.
    const oldWrapNorm = 1 + wrapMarginX(areaEquivRadius, W, H);
    const newWrapNorm = 1 + wrapMarginX(boundR, W, H);
    assert.ok(newWrapNorm > oldWrapNorm, 'new wrap must occur AFTER old wrap');

    // The new wrap moment must keep the visible polygon fully off-screen.
    const refDim = Math.min(W, H);
    const centerPxAtWrap = newWrapNorm * W;
    const leftmostVisiblePx = centerPxAtWrap - boundR * refDim;
    assert.ok(leftmostVisiblePx >= W - 1e-6,
        'leftmost visible vertex must be at or past the right edge at wrap moment');
});

test('receiver getBoundingRadius for asteroid uses vertices when available', () => {
    const ASTEROID = 'asteroid';
    CONFIG.ASTEROID_JAGGEDNESS = 0.4;

    // With vertices: use vertex max.
    const verts = [
        { angle: 0, distance: 0.10 },
        { angle: 1, distance: 0.12 },
        { angle: 2, distance: 0.08 },
    ];
    assert.equal(getRemoteBoundingRadius({ type: ASTEROID, radius: 0.083, vertices: verts }), 0.12);
    const packed = getRemoteBoundingRadius({
        type: ASTEROID, radius: 0.083, vertices: AstervoidsWireCodec.packAsteroidVertices(verts),
    });
    assert.ok(Math.abs(packed - 0.12) <= 1 / 65535);

    // Without vertices: fall back to radius × (1 + JAGGEDNESS).
    const fallback = getRemoteBoundingRadius({ type: ASTEROID, radius: 0.083 });
    assert.ok(Math.abs(fallback - 0.083 * 1.4) < 1e-9, `fallback was ${fallback}`);

    // Empty vertex array: fall back too.
    const empty = getRemoteBoundingRadius({ type: ASTEROID, radius: 0.10, vertices: [] });
    assert.ok(Math.abs(empty - 0.10 * 1.4) < 1e-9);
});

test('receiver bound estimate is >= sender boundRadius for spawn asteroids (no snap on wrap-cross)', () => {
    // The receiver's wrap-detection range is `1 + 2 · wrapMargin(receiverR)`;
    // it MUST be at least as large as the sender's actual extended range,
    // otherwise the receiver mistakes a wrap-crossing for a snap-worthy jump.
    // Validate the inequality holds for many random seeds.
    const ASTEROID_JAGGEDNESS = 0.4;
    const radius = 0.083;
    for (let seed = 1; seed < 200; seed++) {
        const verts = generateJaggedShape(radius, seed, 10, ASTEROID_JAGGEDNESS);
        const senderBoundR = maxVertexDistance(verts);
        const receiverFallback = getRemoteBoundingRadius({ type: OBJECT_TYPES.ASTEROID, radius });
        assert.ok(receiverFallback >= senderBoundR - 1e-9,
            `seed=${seed}: fallback ${receiverFallback} < sender ${senderBoundR}`);
    }
});
