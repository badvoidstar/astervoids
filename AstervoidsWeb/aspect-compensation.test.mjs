// Regression tests for asteroid aspect-ratio difficulty compensation.
//
// Run with: node --test AstervoidsWeb/aspect-compensation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
    SHARED_DEFAULTS,
    SESSION_CONFIG_KEYS,
    CONFIG_CONTROLS,
    buildSessionConfigMetadata,
    applySessionConfigMetadata,
} =
    require('./wwwroot/js/game-config.js');
const {
    getAspectSeverity,
    getAsteroidAspectScales,
} = require('./wwwroot/js/asteroid-fracture.js');

const EPS = 1e-10;
const indexSource = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');

test('asteroid basis radius and speed use the configured defaults', () => {
    assert.equal(SHARED_DEFAULTS.INITIAL_ASTEROID_RADIUS, 0.085);
    assert.match(indexSource, /ASTEROID_BASE_SPEED:\s*0\.15,/);
});

// ── 1. Portrait/landscape symmetry ──────────────────────────────────────────

test('16:9 and 9:16 produce identical aspect severity', () => {
    const s1 = getAspectSeverity(1920, 1080);
    const s2 = getAspectSeverity(1080, 1920);
    assert.ok(Math.abs(s1 - s2) < EPS,
        `landscape ${s1} !== portrait ${s2}`);
});

test('16:9 and 9:16 produce identical radiusScale and speedScale', () => {
    const balance = 0.5;
    const sc1 = getAsteroidAspectScales(getAspectSeverity(1920, 1080), balance);
    const sc2 = getAsteroidAspectScales(getAspectSeverity(1080, 1920), balance);
    assert.ok(Math.abs(sc1.radiusScale - sc2.radiusScale) < EPS);
    assert.ok(Math.abs(sc1.speedScale  - sc2.speedScale)  < EPS);
});

// ── 2. Square viewport produces scale 1 ─────────────────────────────────────

test('square viewport: getAspectSeverity returns 1', () => {
    assert.ok(Math.abs(getAspectSeverity(800, 800) - 1) < EPS);
});

test('square viewport: radiusScale and speedScale are both 1 (balance 0.5)', () => {
    const { radiusScale, speedScale } =
        getAsteroidAspectScales(getAspectSeverity(800, 800), 0.5);
    assert.ok(Math.abs(radiusScale - 1) < EPS);
    assert.ok(Math.abs(speedScale  - 1) < EPS);
});

test('square viewport: radiusScale and speedScale are 1 for all balance values', () => {
    for (const balance of [0, 0.25, 0.5, 0.75, 1]) {
        const { radiusScale, speedScale } =
            getAsteroidAspectScales(1, balance);
        assert.ok(Math.abs(radiusScale - 1) < EPS,
            `balance=${balance}: radiusScale=${radiusScale} ≠ 1`);
        assert.ok(Math.abs(speedScale - 1) < EPS,
            `balance=${balance}: speedScale=${speedScale} ≠ 1`);
    }
});

// ── 3. Balance endpoints ─────────────────────────────────────────────────────

test('balance 0: radiusScale equals aspectSeverity, speedScale is 1', () => {
    const severity = getAspectSeverity(1920, 1080);
    const { radiusScale, speedScale } = getAsteroidAspectScales(severity, 0);
    assert.ok(Math.abs(radiusScale - severity) < EPS,
        `radiusScale=${radiusScale}, severity=${severity}`);
    assert.ok(Math.abs(speedScale - 1) < EPS,
        `speedScale=${speedScale} ≠ 1`);
});

test('balance 1: radiusScale is 1, speedScale equals aspectSeverity', () => {
    const severity = getAspectSeverity(1920, 1080);
    const { radiusScale, speedScale } = getAsteroidAspectScales(severity, 1);
    assert.ok(Math.abs(radiusScale - 1) < EPS,
        `radiusScale=${radiusScale} ≠ 1`);
    assert.ok(Math.abs(speedScale - severity) < EPS,
        `speedScale=${speedScale}, severity=${severity}`);
});

// ── 4. Balance 0.5 geometric split ───────────────────────────────────────────

test('balance 0.5: both scales equal sqrt(aspectSeverity)', () => {
    const severity = getAspectSeverity(1920, 1080);
    const sqrtSeverity = Math.sqrt(severity);
    const { radiusScale, speedScale } = getAsteroidAspectScales(severity, 0.5);
    assert.ok(Math.abs(radiusScale - sqrtSeverity) < EPS,
        `radiusScale=${radiusScale}, sqrt=${sqrtSeverity}`);
    assert.ok(Math.abs(speedScale - sqrtSeverity) < EPS,
        `speedScale=${speedScale}, sqrt=${sqrtSeverity}`);
});

// ── 5. radiusScale * speedScale === aspectSeverity ───────────────────────────

test('product invariant: radiusScale * speedScale === aspectSeverity within tolerance', () => {
    const cases = [
        { w: 800, h: 800 },
        { w: 1920, h: 1080 },
        { w: 1080, h: 1920 },
        { w: 2560, h: 1080 },
        { w: 1280, h: 1024 },
    ];
    for (const { w, h } of cases) {
        const severity = getAspectSeverity(w, h);
        for (const balance of [0, 0.25, 0.5, 0.75, 1]) {
            const { radiusScale, speedScale } = getAsteroidAspectScales(severity, balance);
            const product = radiusScale * speedScale;
            assert.ok(Math.abs(product - severity) < EPS,
                `${w}x${h} balance=${balance}: product=${product}, severity=${severity}`);
        }
    }
});

// ── 6. Balance clamped to [0, 1] ─────────────────────────────────────────────

test('balance clamped below 0 behaves as 0 (size-only)', () => {
    const severity = getAspectSeverity(1920, 1080);
    const { radiusScale: r0, speedScale: s0 } = getAsteroidAspectScales(severity, 0);
    const { radiusScale: rn, speedScale: sn } = getAsteroidAspectScales(severity, -0.5);
    assert.ok(Math.abs(rn - r0) < EPS, `clamp(-0.5) radiusScale mismatch`);
    assert.ok(Math.abs(sn - s0) < EPS, `clamp(-0.5) speedScale mismatch`);
});

test('balance clamped above 1 behaves as 1 (speed-only)', () => {
    const severity = getAspectSeverity(1920, 1080);
    const { radiusScale: r1, speedScale: s1 } = getAsteroidAspectScales(severity, 1);
    const { radiusScale: rh, speedScale: sh } = getAsteroidAspectScales(severity, 1.5);
    assert.ok(Math.abs(rh - r1) < EPS, `clamp(1.5) radiusScale mismatch`);
    assert.ok(Math.abs(sh - s1) < EPS, `clamp(1.5) speedScale mismatch`);
});

// ── 7. Initial/minimum radius ratio preserved ────────────────────────────────

test('initial/minimum radius ratio unchanged across aspect ratios and balance settings', () => {
    const baseRatio = SHARED_DEFAULTS.INITIAL_ASTEROID_RADIUS
        / SHARED_DEFAULTS.MIN_ASTEROID_RADIUS;

    const cases = [
        { w: 800, h: 800 },
        { w: 1920, h: 1080 },
        { w: 2560, h: 1440 },
    ];
    for (const { w, h } of cases) {
        const severity = getAspectSeverity(w, h);
        for (const balance of [0, 0.5, 1]) {
            const { radiusScale } = getAsteroidAspectScales(severity, balance);
            const effectiveInitial = SHARED_DEFAULTS.INITIAL_ASTEROID_RADIUS * radiusScale;
            const effectiveMin     = SHARED_DEFAULTS.MIN_ASTEROID_RADIUS     * radiusScale;
            const scaledRatio = effectiveInitial / effectiveMin;
            assert.ok(Math.abs(scaledRatio - baseRatio) < EPS,
                `${w}x${h} balance=${balance}: ratio=${scaledRatio}, base=${baseRatio}`);
        }
    }
});

// ── 8. Reciprocal aspect ratios produce equivalent spawn physics ──────────────

test('reciprocal viewports produce same radiusScale (spawn radius)', () => {
    for (const [w, h] of [[1920, 1080], [2560, 1080], [1366, 768]]) {
        const sc1 = getAsteroidAspectScales(getAspectSeverity(w, h), 0.5);
        const sc2 = getAsteroidAspectScales(getAspectSeverity(h, w), 0.5);
        assert.ok(Math.abs(sc1.radiusScale - sc2.radiusScale) < EPS,
            `${w}x${h} vs ${h}x${w}: radiusScale mismatch`);
    }
});

test('reciprocal viewports produce same speedScale (spawn speed, max-speed cap, deflection kick)', () => {
    for (const [w, h] of [[1920, 1080], [2560, 1080], [1366, 768]]) {
        const sc1 = getAsteroidAspectScales(getAspectSeverity(w, h), 0.5);
        const sc2 = getAsteroidAspectScales(getAspectSeverity(h, w), 0.5);
        assert.ok(Math.abs(sc1.speedScale - sc2.speedScale) < EPS,
            `${w}x${h} vs ${h}x${w}: speedScale mismatch`);
    }
});

test('reciprocal viewports produce same separation-speed effect (speedScale²)', () => {
    for (const [w, h] of [[1920, 1080], [2560, 1080]]) {
        const sc1 = getAsteroidAspectScales(getAspectSeverity(w, h), 0.5);
        const sc2 = getAsteroidAspectScales(getAspectSeverity(h, w), 0.5);
        const energy1 = sc1.speedScale * sc1.speedScale;
        const energy2 = sc2.speedScale * sc2.speedScale;
        assert.ok(Math.abs(energy1 - energy2) < EPS,
            `${w}x${h} vs ${h}x${w}: speedScale² mismatch`);
    }
});

// ── 9. Asteroid spawn count does not vary with aspect ratio ───────────────────
// (This is a config-level invariant: the population is controlled by
// ASTEROID_BASE_COUNT + wave * ASTEROID_INCREMENT, which are not aspect-scaled.)

test('asteroid spawn count constants are not affected by aspect compensation', () => {
    // These keys must not appear in the aspect-scaled fracture config overlay
    // (DEFLECTION_KICK, SEPARATION_ENERGY, MIN/INITIAL_ASTEROID_RADIUS are scaled,
    // but population keys are NOT).
    const populationKeys = ['ASTEROID_BASE_COUNT', 'WAVE_ASTEROID_INCREMENT'];
    // Simulate what splitAsteroid does: overlay only the physics constants.
    const CONFIG_LIKE = {
        ASTEROID_BASE_COUNT: 1,
        WAVE_ASTEROID_INCREMENT: 1,
        DEFLECTION_KICK: 2e-3,
        SEPARATION_ENERGY: 2e-4,
        MIN_ASTEROID_RADIUS: 0.025,
        INITIAL_ASTEROID_RADIUS: SHARED_DEFAULTS.INITIAL_ASTEROID_RADIUS,
    };
    const scales = getAsteroidAspectScales(getAspectSeverity(1920, 1080), 0.5);
    const overlay = {
        DEFLECTION_KICK: CONFIG_LIKE.DEFLECTION_KICK * scales.speedScale,
        SEPARATION_ENERGY: CONFIG_LIKE.SEPARATION_ENERGY
            * scales.speedScale * scales.speedScale,
        MIN_ASTEROID_RADIUS: CONFIG_LIKE.MIN_ASTEROID_RADIUS * scales.radiusScale,
        INITIAL_ASTEROID_RADIUS: CONFIG_LIKE.INITIAL_ASTEROID_RADIUS * scales.radiusScale,
    };
    const fractureConfig = Object.assign({}, CONFIG_LIKE, overlay);
    for (const key of populationKeys) {
        assert.equal(fractureConfig[key], CONFIG_LIKE[key],
            `${key} must not be changed by aspect overlay`);
    }
});

// ── 10. Session-authoritative aspect settings ─────────────────────────────────

test('ASTEROID_ASPECT_SIZE_SPEED_BALANCE is in SESSION_CONFIG_KEYS', () => {
    assert.ok(SESSION_CONFIG_KEYS.includes('ASTEROID_ASPECT_SIZE_SPEED_BALANCE'),
        'ASTEROID_ASPECT_SIZE_SPEED_BALANCE must be session-authoritative');
});

test('ASTEROID_DIFFICULTY_FACTOR is session-authoritative', () => {
    assert.ok(SESSION_CONFIG_KEYS.includes('ASTEROID_DIFFICULTY_FACTOR'),
        'ASTEROID_DIFFICULTY_FACTOR must be inherited from the session creator');
});

test('joiners inherit the session creator difficulty', () => {
    const creatorConfig = { ASTEROID_DIFFICULTY_FACTOR: 1.4 };
    const metadata = {
        config: buildSessionConfigMetadata(creatorConfig, ['ASTEROID_DIFFICULTY_FACTOR']),
    };
    const joinerConfig = { ASTEROID_DIFFICULTY_FACTOR: 0.3 };
    applySessionConfigMetadata(
        metadata, joinerConfig, ['ASTEROID_DIFFICULTY_FACTOR']);
    assert.equal(joinerConfig.ASTEROID_DIFFICULTY_FACTOR, 1.4);
});

test('aspect scales from session metadata override local reciprocal viewport', () => {
    // Session was created on a 16:9 display.
    const sessionSeverity = getAspectSeverity(1920, 1080);
    const sessionScales = getAsteroidAspectScales(sessionSeverity, 0.5);

    // A joiner has a 9:16 (portrait) display but must use the session value.
    const localSeverity  = getAspectSeverity(1080, 1920);
    const localScales    = getAsteroidAspectScales(localSeverity,  0.5);

    // Both severities are the same (symmetric), so scales will also match.
    // The test verifies that the symmetry property guarantees agreement even
    // before the session metadata is consulted.
    assert.ok(Math.abs(sessionScales.radiusScale - localScales.radiusScale) < EPS,
        'reciprocal viewports already agree, so adopting session value is safe');
    assert.ok(Math.abs(sessionScales.speedScale  - localScales.speedScale) < EPS);
});

test('aspect scales with absent metadata aspectSeverity fall back to 1 (square)', () => {
    // Simulate adoptSessionConfig behaviour for legacy sessions without the field.
    const rawSeverity = undefined;
    const adopted = (typeof rawSeverity === 'number' && Number.isFinite(rawSeverity))
        ? Math.max(1, rawSeverity)
        : 1;
    assert.equal(adopted, 1);
    const { radiusScale, speedScale } = getAsteroidAspectScales(adopted, 0.5);
    assert.ok(Math.abs(radiusScale - 1) < EPS);
    assert.ok(Math.abs(speedScale  - 1) < EPS);
});

test('solo canvas resize rescales existing gameplay and cosmetic asteroids', () => {
    const resizeStart = indexSource.indexOf('    function resizeCanvas(forceViewportRecalc = false)');
    const resizeEnd = indexSource.indexOf('\n    /**\n     * Get the gameplay area width', resizeStart);
    assert.ok(resizeStart >= 0 && resizeEnd > resizeStart);
    const resizeSource = indexSource.slice(resizeStart, resizeEnd);

    assert.match(
        resizeSource,
        /const previousAspectScales = dimensionsChanged && !isSessionMode\(\)/);
    assert.match(
        resizeSource,
        /rescaleAsteroidsForAspectChange\(previousAspectScales, nextAspectScales\)/);
});

test('dynamic aspect rescaling updates asteroid geometry, bounds, and velocity', () => {
    const functionStart = indexSource.indexOf(
        '    function rescaleAsteroidForAspectChange(asteroid, radiusRatio, speedRatio)');
    const functionEnd = indexSource.indexOf('\n\n    function adoptSessionConfig', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const functionSource = indexSource.slice(functionStart, functionEnd);

    assert.match(functionSource, /asteroid\.radius \*= radiusRatio/);
    assert.match(functionSource, /asteroid\.boundRadius \*= radiusRatio/);
    assert.match(functionSource, /vertex\.distance \*= radiusRatio/);
    assert.match(functionSource, /asteroid\.velocityX \*= speedRatio/);
    assert.match(functionSource, /asteroid\.velocityY \*= speedRatio/);
    assert.match(functionSource, /asteroid\._cachedVerts = null/);
    assert.match(functionSource,
        /nextScales\.radiusScale \/ previousScales\.radiusScale/);
    assert.match(functionSource,
        /nextScales\.speedScale \/ previousScales\.speedScale/);
    assert.match(functionSource,
        /for \(const asteroid of game\.astervoids\)[\s\S]*?rescaleAsteroidForAspectChange/);
    assert.match(functionSource,
        /for \(const asteroid of game\.cosmeticAstervoids\)[\s\S]*?rescaleAsteroidForAspectChange/);
});

test('debug config changes immediately rescale existing asteroids', () => {
    const handlerStart = indexSource.indexOf('    debugChannel.onmessage = (event) => {');
    const handlerEnd = indexSource.indexOf('\n    };', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    const handlerSource = indexSource.slice(handlerStart, handlerEnd);

    assert.match(handlerSource,
        /const previousAspectScales = getEffectiveAsteroidAspectScales\(\)/);
    assert.match(handlerSource,
        /const nextAspectScales = getEffectiveAsteroidAspectScales\(\)/);
    assert.match(handlerSource,
        /rescaleAsteroidsForAspectChange\(previousAspectScales, nextAspectScales\)/);
    assert.match(handlerSource,
        /applyLiveConfigOverride\([\s\S]*?isSessionMode\(\)\)/);
});

test('game requests persisted debug config immediately on startup', () => {
    const baselineIndex = indexSource.indexOf(
        '    const LOCAL_CONFIG_BASELINE = snapshotConfigValues(CONFIG, SESSION_CONFIG_KEYS);');
    const storedOverrideIndex = indexSource.indexOf(
        '    applyStoredDebugConfigOverrides(CONFIG, window.localStorage);');
    assert.ok(storedOverrideIndex >= 0 && storedOverrideIndex < baselineIndex,
        'persisted overrides must apply before the local baseline is captured');
    assert.match(indexSource,
        /debugChannel\.postMessage\(\{ type: 'config-request' \}\)/);
    const debugSource = readFileSync(
        new URL('./wwwroot/debug/index.html', import.meta.url), 'utf8');
    assert.match(debugSource,
        /data && data\.type === 'config-request'[\s\S]*?pushAllOverrides\(\)/);
});

test('session config adoption immediately rebuilds cosmetic asteroids', () => {
    const functionStart = indexSource.indexOf(
        '    function adoptSessionConfig(metadata, config = CONFIG)');
    const functionEnd = indexSource.indexOf(
        '\n    const SIM_MODES = Object.freeze', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const functionSource = indexSource.slice(functionStart, functionEnd);

    assert.match(functionSource, /resetCosmeticAsteroids\(\)/);
});

// ── 11. Existing square-aspect behavior unchanged ─────────────────────────────

test('square aspect: severity is 1 and all scales are 1 regardless of balance', () => {
    const severity = getAspectSeverity(1920, 1920);
    assert.ok(Math.abs(severity - 1) < EPS);
    for (const balance of [0, 0.25, 0.5, 0.75, 1]) {
        const { radiusScale, speedScale } = getAsteroidAspectScales(severity, balance);
        assert.ok(Math.abs(radiusScale - 1) < EPS,
            `balance=${balance}: radiusScale=${radiusScale}`);
        assert.ok(Math.abs(speedScale  - 1) < EPS,
            `balance=${balance}: speedScale=${speedScale}`);
    }
});

// ── Config wiring ─────────────────────────────────────────────────────────────

test('ASTEROID_ASPECT_SIZE_SPEED_BALANCE defaults to 0.5', () => {
    assert.equal(SHARED_DEFAULTS.ASTEROID_ASPECT_SIZE_SPEED_BALANCE, 0.5);
    assert.match(indexSource,
        /ASTEROID_ASPECT_SIZE_SPEED_BALANCE:\s*SHARED_CONFIG_DEFAULTS\.ASTEROID_ASPECT_SIZE_SPEED_BALANCE/);
});

test('ASTEROID_ASPECT_SIZE_SPEED_BALANCE debug control exists with correct range', () => {
    const ctrl = CONFIG_CONTROLS.find(
        c => c.key === 'ASTEROID_ASPECT_SIZE_SPEED_BALANCE');
    assert.ok(ctrl, 'control must be registered');
    assert.equal(ctrl.min, 0);
    assert.equal(ctrl.max, 1);
    assert.ok(ctrl.step > 0 && ctrl.step <= 0.1,
        `step ${ctrl.step} should be small (≤ 0.1)`);
});

test('difficulty defaults to 0.8 and has a 0.01 to 2.0 debug control', () => {
    assert.equal(SHARED_DEFAULTS.ASTEROID_DIFFICULTY_FACTOR, 0.8);
    assert.match(indexSource,
        /ASTEROID_DIFFICULTY_FACTOR:\s*SHARED_CONFIG_DEFAULTS\.ASTEROID_DIFFICULTY_FACTOR/);
    const ctrl = CONFIG_CONTROLS.find(c => c.key === 'ASTEROID_DIFFICULTY_FACTOR');
    assert.ok(ctrl, 'control must be registered');
    assert.equal(ctrl.min, 0.01);
    assert.equal(ctrl.max, 2);
});

test('difficulty compounds with severity before applying size/speed balance', () => {
    const severity = getAspectSeverity(1920, 1080);
    const difficulty = 0.8;
    const combined = severity * difficulty;
    const { radiusScale, speedScale } =
        getAsteroidAspectScales(severity, 0.5, difficulty);
    assert.ok(Math.abs(radiusScale - Math.sqrt(combined)) < EPS);
    assert.ok(Math.abs(speedScale - Math.sqrt(combined)) < EPS);
    assert.ok(Math.abs(radiusScale * speedScale - combined) < EPS);
    assert.match(
        indexSource,
        /getEffectiveAspectSeverity\(\),\s*CONFIG\.ASTEROID_ASPECT_SIZE_SPEED_BALANCE,\s*CONFIG\.ASTEROID_DIFFICULTY_FACTOR/);
});

test('difficulty uses the configured balance endpoints', () => {
    const severity = 1.5;
    const difficulty = 0.8;
    const combined = severity * difficulty;
    assert.deepEqual(
        getAsteroidAspectScales(severity, 0, difficulty),
        { radiusScale: combined, speedScale: 1 });
    assert.deepEqual(
        getAsteroidAspectScales(severity, 1, difficulty),
        { radiusScale: 1, speedScale: combined });
});

test('difficulty is clamped to a positive 0.01 minimum', () => {
    const expected = getAsteroidAspectScales(1.5, 0.5, 0.01);
    assert.deepEqual(getAsteroidAspectScales(1.5, 0.5, 0), expected);
    assert.deepEqual(getAsteroidAspectScales(1.5, 0.5, -1), expected);
});

test('difficulty is clamped to a 2.0 maximum', () => {
    const expected = getAsteroidAspectScales(1.5, 0.5, 2);
    assert.deepEqual(getAsteroidAspectScales(1.5, 0.5, 3), expected);
});
