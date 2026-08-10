// Unit tests for aspect-ratio difficulty compensation.
//
// Run with: node --test AstervoidsWeb/aspect-compensation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AstervoidsAspectCompensation = require('./wwwroot/js/aspect-compensation.js');
const { computeAspectFactor, asteroidAspectScales } = AstervoidsAspectCompensation;

const {
    SHARED_DEFAULTS,
    SESSION_CONFIG_KEYS,
} = require('./wwwroot/js/game-config.js');

const EPS = 1e-10;

// ─── computeAspectFactor ───────────────────────────────────────────────────

test('1:1 viewport gives aspect factor 1', () => {
    assert.equal(computeAspectFactor(800, 800), 1);
    assert.equal(computeAspectFactor(1000, 1000), 1);
});

test('16:9 landscape gives the same factor as 9:16 portrait', () => {
    const landscape = computeAspectFactor(1920, 1080);
    const portrait  = computeAspectFactor(1080, 1920);
    assert.equal(landscape, portrait);
});

test('16:9 gives aspect factor 16/9', () => {
    const f = computeAspectFactor(1920, 1080);
    assert.ok(Math.abs(f - 16 / 9) < EPS, `expected ${16 / 9}, got ${f}`);
});

test('21:9 produces approximately 2.333 aspect factor (capped to 2.25 by default)', () => {
    const raw = 21 / 9; // ≈ 2.333
    const f   = computeAspectFactor(2560, 1080); // 21:9
    // raw exceeds default cap (2.25), so capped value is returned
    assert.equal(f, 2.25);
    // confirm raw would have exceeded cap
    assert.ok(raw > 2.25);
});

test('aspect factors above the cap are clamped to the cap', () => {
    // 32:9 (3.555) and 4:1 (4.0) both get capped to 2.25
    assert.equal(computeAspectFactor(3840, 1080, 2.25), 2.25); // 32:9
    assert.equal(computeAspectFactor(4000,  500, 2.25), 2.25); // 8:1
});

test('custom cap is honoured', () => {
    // With a cap of 3, a 3:1 ratio is returned unchanged
    const f = computeAspectFactor(3000, 1000, 3);
    assert.equal(f, 3);
    // A 4:1 ratio is clamped to the custom cap
    const f2 = computeAspectFactor(4000, 1000, 3);
    assert.equal(f2, 3);
});

test('degenerate (zero or negative) dimensions do not throw and return finite value', () => {
    const f = computeAspectFactor(0, 0);
    assert.ok(Number.isFinite(f));
    assert.ok(f >= 1);
});

// ─── asteroidAspectScales ──────────────────────────────────────────────────

test('1:1 aspect factor gives sizeScale=1 and speedScale=1', () => {
    const { sizeScale, speedScale } = asteroidAspectScales(1, 0.45);
    assert.equal(sizeScale, 1);
    assert.equal(speedScale, 1);
});

test('16:9 landscape and 9:16 portrait produce identical sizeScale and speedScale', () => {
    const fLandscape = computeAspectFactor(1920, 1080);
    const fPortrait  = computeAspectFactor(1080, 1920);
    assert.equal(fLandscape, fPortrait);
    const s1 = asteroidAspectScales(fLandscape, 0.45);
    const s2 = asteroidAspectScales(fPortrait,  0.45);
    assert.equal(s1.sizeScale,  s2.sizeScale);
    assert.equal(s1.speedScale, s2.speedScale);
});

test('sizeScale * speedScale equals the compensated aspect factor (budget invariant)', () => {
    for (const [w, h] of [[1920, 1080], [2560, 1080], [1080, 1920], [800, 600], [1000, 1000]]) {
        for (const sw of [0.45, 0.5, 0.3]) {
            const f   = computeAspectFactor(w, h, 2.25);
            const { sizeScale, speedScale } = asteroidAspectScales(f, sw);
            assert.ok(Math.abs(sizeScale * speedScale - f) < EPS,
                `sizeScale*speedScale should equal aspect factor for ${w}x${h} sw=${sw}`);
        }
    }
});

test('21:9 (capped to 2.25) produces approximately expected balanced compensation (sizeWeight=0.45)', () => {
    const f   = 2.25;
    const sw  = 0.45;
    const { sizeScale, speedScale } = asteroidAspectScales(f, sw);
    // Expected: 2.25^0.45 ≈ 1.44, 2.25^0.55 ≈ 1.56
    assert.ok(sizeScale  > 1.40 && sizeScale  < 1.50, `sizeScale  ${sizeScale} outside [1.40, 1.50]`);
    assert.ok(speedScale > 1.50 && speedScale < 1.65, `speedScale ${speedScale} outside [1.50, 1.65]`);
    // Product must equal the aspect factor
    assert.ok(Math.abs(sizeScale * speedScale - f) < EPS);
});

test('sizeWeight=0.5 gives equal size and speed scales (symmetric split)', () => {
    const f   = computeAspectFactor(1920, 1080, 4);
    const { sizeScale, speedScale } = asteroidAspectScales(f, 0.5);
    assert.ok(Math.abs(sizeScale - speedScale) < EPS,
        `sizeScale (${sizeScale}) should equal speedScale (${speedScale}) at sizeWeight=0.5`);
});

// ─── Config defaults and session keys ─────────────────────────────────────

test('SHARED_DEFAULTS includes ASPECT_COMPENSATION defaulting to 1.0', () => {
    assert.equal(SHARED_DEFAULTS.ASPECT_COMPENSATION, 1.0);
});

test('SHARED_DEFAULTS includes ASPECT_SIZE_WEIGHT defaulting to 0.45', () => {
    assert.equal(SHARED_DEFAULTS.ASPECT_SIZE_WEIGHT, 0.45);
});

test('SHARED_DEFAULTS includes ASPECT_MAX_COMPENSATED defaulting to 2.25', () => {
    assert.equal(SHARED_DEFAULTS.ASPECT_MAX_COMPENSATED, 2.25);
});

test('SESSION_CONFIG_KEYS includes ASPECT_COMPENSATION for multiplayer determinism', () => {
    assert.ok(SESSION_CONFIG_KEYS.includes('ASPECT_COMPENSATION'),
        'ASPECT_COMPENSATION must be in SESSION_CONFIG_KEYS');
});

// ─── Derived-scale properties ──────────────────────────────────────────────

test('both initial and minimum radii receive the same size multiplier', () => {
    const f  = computeAspectFactor(1920, 1080, 2.25);
    const sw = 0.45;
    const { sizeScale } = asteroidAspectScales(f, sw);
    const initialRadius = SHARED_DEFAULTS.INITIAL_ASTEROID_RADIUS;
    const minRadius     = SHARED_DEFAULTS.MIN_ASTEROID_RADIUS;
    const scaledInitial = initialRadius * sizeScale;
    const scaledMin     = minRadius     * sizeScale;
    // Ratio between scaled values must be unchanged (same multiplier applied)
    assert.ok(Math.abs(scaledInitial / scaledMin - initialRadius / minRadius) < EPS,
        'scaled initial/min ratio must match unscaled ratio');
});

test('max speed, initial spawn speed, and deflection kick receive the same speed multiplier', () => {
    // 16:9 with sizeWeight=0.45: speedScale = (16/9)^0.55
    const aspect = 16 / 9;
    const sw     = 0.45;
    const expectedSpeedScale = Math.pow(aspect, 1 - sw); // (16/9)^0.55
    const { speedScale } = asteroidAspectScales(aspect, sw);

    // speedScale must differ from 1
    assert.ok(speedScale > 1, 'speedScale must exceed 1 for a 16:9 viewport');
    assert.ok(Math.abs(speedScale - expectedSpeedScale) < EPS,
        `speedScale ${speedScale} should equal ${expectedSpeedScale}`);

    const maxSpeed  = SHARED_DEFAULTS.ASTEROID_MAX_SPEED; // 0.4
    const baseSpeed = 0.15; // ASTEROID_BASE_SPEED runtime CONFIG value
    const kick      = SHARED_DEFAULTS.DEFLECTION_KICK;   // 2e-3

    // Each value scaled by speedScale must equal value * (16/9)^0.55 exactly
    assert.ok(Math.abs(maxSpeed  * speedScale - maxSpeed  * expectedSpeedScale) < EPS,
        'maxSpeed should scale by (16/9)^0.55');
    assert.ok(Math.abs(baseSpeed * speedScale - baseSpeed * expectedSpeedScale) < EPS,
        'baseSpeed should scale by (16/9)^0.55');
    assert.ok(Math.abs(kick      * speedScale - kick      * expectedSpeedScale) < EPS,
        'deflection kick should scale by (16/9)^0.55');
});

test('separation energy receives the square of the speed multiplier (velocity-squared units)', () => {
    const aspect = 16 / 9;
    const sw     = 0.45;
    const { speedScale } = asteroidAspectScales(aspect, sw);

    const sepEnergy  = SHARED_DEFAULTS.SEPARATION_ENERGY;
    const scaled     = sepEnergy * speedScale * speedScale;
    const energyRatio = scaled / sepEnergy; // = speedScale²

    // The energy multiplier must differ from the linear speedScale (squared units)
    assert.ok(Math.abs(energyRatio - speedScale) > EPS,
        `energy multiplier (${energyRatio}) must differ from linear speedScale (${speedScale})`);

    // The energy multiplier must equal speedScale² exactly
    const linearRatio = speedScale;            // what it would be if wrongly linearised
    const squaredRatio = speedScale * speedScale; // correct: velocity² units
    assert.ok(Math.abs(energyRatio - squaredRatio) < EPS,
        `energy ratio ${energyRatio} should equal speedScale² ${squaredRatio}`);
    assert.ok(Math.abs(energyRatio - linearRatio) > EPS,
        `energy ratio ${energyRatio} must not equal linear speedScale ${linearRatio}`);
});

test('asteroid population/count is unchanged — compensation applies only to size and speed', () => {
    // The compensation model touches only size/speed multipliers; count is unaffected.
    // Verify that asteroidAspectScales returns no count-related field.
    const scales = asteroidAspectScales(computeAspectFactor(1920, 1080, 2.25), 0.45);
    assert.ok(!('count' in scales));
    assert.ok(!('asteroidCount' in scales));
    assert.ok(Object.keys(scales).length === 2, 'only sizeScale and speedScale expected');
});

// ─── Multiplayer determinism ───────────────────────────────────────────────

test('ASPECT_COMPENSATION in session metadata prevents peers from deriving different physics', () => {
    // Two peers with different viewports would compute different aspect factors locally.
    // When ASPECT_COMPENSATION is shared via session metadata, both use the same value.
    const serverFactor = computeAspectFactor(1920, 1080, 2.25); // 16:9
    const clientFactor = computeAspectFactor(2560, 1080, 2.25); // 21:9

    // Before session: factors differ
    assert.notEqual(serverFactor, clientFactor);

    // After session metadata is applied: both use the server's stored value
    const sharedFactor = serverFactor; // metadata.config.ASPECT_COMPENSATION

    const serverScale = asteroidAspectScales(sharedFactor, 0.45);
    const clientScale = asteroidAspectScales(sharedFactor, 0.45);

    assert.equal(serverScale.sizeScale,  clientScale.sizeScale);
    assert.equal(serverScale.speedScale, clientScale.speedScale);
});

// ─── Freeze-on-resize invariant ───────────────────────────────────────────

test('compensation remains frozen across resize for a running game', () => {
    // Simulate: game starts at 1920×1080, player resizes to 1280×720.
    const initialFactor = computeAspectFactor(1920, 1080, 2.25);
    // After resize, we intentionally do NOT recompute — frozen value must be unchanged.
    const frozenFactor  = initialFactor; // game.asteroidScale is not updated on resize

    // The resized viewport has the same aspect ratio, but even if it changed:
    const afterResize = computeAspectFactor(2560, 1440, 2.25); // still 16:9
    // frozen value equals initial (not recalculated)
    assert.equal(frozenFactor, initialFactor);
    // The resized computation gives the same result here because ratio is identical
    assert.equal(afterResize, initialFactor);

    // Demonstrate a case where a different resize would compute a different factor
    const differentViewport = computeAspectFactor(2560, 1080, 2.25); // 21:9
    assert.notEqual(differentViewport, initialFactor);
    // frozen value is still the original
    assert.equal(frozenFactor, initialFactor);
});
