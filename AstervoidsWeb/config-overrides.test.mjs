import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    SHARED_DEFAULTS,
    CONFIG_CONTROLS,
    DEBUG_OVERRIDABLE_KEYS,
    DEBUG_CONFIG_STORAGE_KEY,
    SESSION_CONFIG_KEYS,
    coerceConfigOverrideValue,
    applyUrlConfigOverrides,
    applyStoredDebugConfigOverrides,
    applyLiveConfigOverride,
    applySessionConfigMetadata,
    buildSessionConfigMetadata,
    countExtraLivesForScore,
} = require('./wwwroot/js/game-config.js');

test('persisted debug overrides apply synchronously from shared storage', () => {
    const cfg = {
        ASTEROID_DIFFICULTY_FACTOR: SHARED_DEFAULTS.ASTEROID_DIFFICULTY_FACTOR,
        SHIP_MAX_SPEED: SHARED_DEFAULTS.SHIP_MAX_SPEED,
    };
    const storage = {
        getItem(key) {
            assert.equal(key, DEBUG_CONFIG_STORAGE_KEY);
            return JSON.stringify({
                ASTEROID_DIFFICULTY_FACTOR: 1.4,
                SHIP_MAX_SPEED: 2,
                UNKNOWN_KEY: 99,
            });
        },
    };

    applyStoredDebugConfigOverrides(cfg, storage);

    assert.equal(cfg.ASTEROID_DIFFICULTY_FACTOR, 1.4);
    assert.equal(cfg.SHIP_MAX_SPEED, 2);
    assert.equal(cfg.UNKNOWN_KEY, undefined);
});

test('invalid persisted debug state leaves configuration unchanged', () => {
    const cfg = { ASTEROID_DIFFICULTY_FACTOR: 0.8 };
    applyStoredDebugConfigOverrides(cfg, { getItem: () => '{invalid' });
    assert.equal(cfg.ASTEROID_DIFFICULTY_FACTOR, 0.8);
});

test('debug controls derive defaults from the shared runtime values', () => {
    for (const control of CONFIG_CONTROLS) {
        const expected = typeof SHARED_DEFAULTS[control.key] === 'boolean'
            ? Number(SHARED_DEFAULTS[control.key])
            : SHARED_DEFAULTS[control.key];
        assert.equal(control.default, expected, control.key);
    }
});

test('analog thrust maximum is available as a debug override', () => {
    const control = CONFIG_CONTROLS.find(item => item.key === 'ANALOG_THRUST_MAX');
    assert.deepEqual(
        control && {
            default: control.default,
            min: control.min,
            max: control.max,
            step: control.step,
        },
        { default: 1.5, min: 0, max: 5, step: 0.1 });
    assert.ok(DEBUG_OVERRIDABLE_KEYS.includes('ANALOG_THRUST_MAX'));

    const cfg = { ANALOG_THRUST_MAX: 1.5 };
    applyUrlConfigOverrides(cfg, '?cfg.ANALOG_THRUST_MAX=2.5');
    assert.equal(cfg.ANALOG_THRUST_MAX, 2.5);
});

test('extra-life score threshold is configurable and session-locked', () => {
    assert.equal(SHARED_DEFAULTS.EXTRA_LIFE_SCORE_THRESHOLD, 10000);
    const control = CONFIG_CONTROLS.find(
        item => item.key === 'EXTRA_LIFE_SCORE_THRESHOLD');
    assert.deepEqual(
        control && {
            default: control.default,
            min: control.min,
            max: control.max,
            step: control.step,
        },
        { default: 10000, min: 0, max: 100000, step: 100 });
    assert.ok(DEBUG_OVERRIDABLE_KEYS.includes('EXTRA_LIFE_SCORE_THRESHOLD'));
    assert.ok(SESSION_CONFIG_KEYS.includes('EXTRA_LIFE_SCORE_THRESHOLD'));

    const cfg = { EXTRA_LIFE_SCORE_THRESHOLD: 10000 };
    applyUrlConfigOverrides(cfg, '?cfg.EXTRA_LIFE_SCORE_THRESHOLD=25000');
    assert.equal(cfg.EXTRA_LIFE_SCORE_THRESHOLD, 25000);

    const joinerCfg = { EXTRA_LIFE_SCORE_THRESHOLD: 10000 };
    applySessionConfigMetadata(
        { config: { EXTRA_LIFE_SCORE_THRESHOLD: 25000 } },
        joinerCfg);
    assert.equal(joinerCfg.EXTRA_LIFE_SCORE_THRESHOLD, 25000);
});

test('separation angle variance is configurable with a pi/8 default', () => {
    assert.equal(SHARED_DEFAULTS.SEPARATION_ANGLE_VARIANCE, Math.PI / 8);
    const control = CONFIG_CONTROLS.find(
        item => item.key === 'SEPARATION_ANGLE_VARIANCE');
    assert.equal(control?.min, 0);
    assert.equal(control?.max, Math.PI);
    assert.ok(DEBUG_OVERRIDABLE_KEYS.includes('SEPARATION_ANGLE_VARIANCE'));

    const cfg = { SEPARATION_ANGLE_VARIANCE: Math.PI / 8 };
    applyUrlConfigOverrides(cfg, '?cfg.SEPARATION_ANGLE_VARIANCE=0.25');
    assert.equal(cfg.SEPARATION_ANGLE_VARIANCE, 0.25);
});

test('score milestones count only enabled whole-score thresholds', () => {
    assert.equal(countExtraLivesForScore(9999, 10000), 0);
    assert.equal(countExtraLivesForScore(10000, 10000), 1);
    assert.equal(countExtraLivesForScore(30099, 10000), 3);
    assert.equal(countExtraLivesForScore(-100, 10000), 0);
    assert.equal(countExtraLivesForScore(10000, 0), 0);
    assert.equal(countExtraLivesForScore(10000, -1), 0);
    assert.equal(countExtraLivesForScore(10000, 'invalid'), 0);
});

test('ship movement defaults and debug bounds split keyboard and analog controls', () => {
    assert.equal(SHARED_DEFAULTS.SHIP_KEYBOARD_TURN_SPEED, 0.125);
    assert.equal(SHARED_DEFAULTS.SHIP_ANALOG_TURN_SPEED, 0.3);
    assert.equal(SHARED_DEFAULTS.ANALOG_RECTILINEAR_TURN_GAIN, 1.0);
    assert.equal(SHARED_DEFAULTS.ANALOG_RECTILINEAR_TURN_DEADZONE_PX, 16);
    assert.equal(SHARED_DEFAULTS.ANALOG_RECTILINEAR_THRUST_DEADZONE_PX, 16);
    assert.equal(SHARED_DEFAULTS.ANALOG_POLAR_TURN_GAIN, 2.0);
    assert.equal(SHARED_DEFAULTS.ANALOG_THRUST_GAIN, 2.0);
    assert.equal(SHARED_DEFAULTS.SHIP_MAX_SPEED, 1.0);

    const keyboardTurnSpeed =
        CONFIG_CONTROLS.find(item => item.key === 'SHIP_KEYBOARD_TURN_SPEED');
    const analogTurnSpeed =
        CONFIG_CONTROLS.find(item => item.key === 'SHIP_ANALOG_TURN_SPEED');
    const maxSpeed = CONFIG_CONTROLS.find(item => item.key === 'SHIP_MAX_SPEED');
    assert.equal(keyboardTurnSpeed?.max, 0.6);
    assert.equal(analogTurnSpeed?.max, 0.6);
    assert.equal(maxSpeed?.max, 6.0);
});

test('debug controls state calibrated anchor and velocity units', () => {
    const controls = new Map(CONFIG_CONTROLS.map(control => [control.key, control]));

    const asteroidSpeed = controls.get('ASTEROID_MAX_SPEED');
    assert.equal(asteroidSpeed?.label, 'Asteroid max linear speed (ref-dim/s)');
    assert.equal(asteroidSpeed?.fmt(0.4), '0.400 ref-dim/s');

    const shipSpeed = controls.get('SHIP_MAX_SPEED');
    assert.equal(shipSpeed?.label, 'Ship max linear speed (ref-dim/s)');
    assert.match(shipSpeed?.help ?? '', /0 disables the cap/);
    assert.equal(shipSpeed?.fmt(1), '1.000 ref-dim/s');

    const rectTurnDeadzone = controls.get('ANALOG_RECTILINEAR_TURN_DEADZONE_PX');
    assert.equal(
        rectTurnDeadzone?.label,
        'Analog rectilinear turn dead-zone (CSS px @ 390px gameplay ref)');
    assert.equal(rectTurnDeadzone?.fmt(16), '16 px @ 390');

    const rectTurnGain = controls.get('ANALOG_RECTILINEAR_TURN_GAIN');
    assert.equal(rectTurnGain?.label, 'Analog rectilinear rotation-offset gain');
    assert.equal(rectTurnGain?.fmt(0.5), '0.50 rad/radius');
    assert.match(rectTurnGain?.help ?? '', /relative heading offset, clamped to ±π/);

    const polarDeadzone = controls.get('ANALOG_POLAR_DEADZONE_PX');
    assert.match(polarDeadzone?.help ?? '', /polar brake remains active/);

    const polarThreshold = controls.get('ANALOG_POLAR_THRESHOLD_PX');
    assert.match(polarThreshold?.help ?? '', /ends the radial turn ramp/);

    const massSplitBias = controls.get('MASS_SPLIT_BIAS');
    assert.equal(massSplitBias?.label, 'Legacy disk-split mass bias');
    assert.match(massSplitBias?.help ?? '', /Only used when polygon fracture/);

    const brakeGain = controls.get('ANALOG_BRAKE_GAIN');
    assert.equal(brakeGain?.label, 'Brake-input gain (analog + keyboard)');
    assert.equal(brakeGain?.fmt(1.5), '1.50x');
});

test('URL overrides: no params preserves defaults', () => {
    const cfg = { FRACTURE_ENABLED: false, FRACTURE_JAGGEDNESS: 0.35 };
    applyUrlConfigOverrides(cfg, '');
    assert.equal(cfg.FRACTURE_ENABLED, false);
    assert.equal(cfg.FRACTURE_JAGGEDNESS, 0.35);
});

test('URL overrides: booleans parse true/false/1/0/on/off', () => {
    const cases = [
        ['?cfg.FRACTURE_ENABLED=true', true],
        ['?cfg.FRACTURE_ENABLED=1', true],
        ['?cfg.FRACTURE_ENABLED=on', true],
        ['?cfg.FRACTURE_ENABLED=false', false],
        ['?cfg.FRACTURE_ENABLED=0', false],
        ['?cfg.FRACTURE_ENABLED=off', false],
    ];
    for (const [query, expected] of cases) {
        const cfg = { FRACTURE_ENABLED: false };
        applyUrlConfigOverrides(cfg, query);
        assert.equal(cfg.FRACTURE_ENABLED, expected, `query ${query}`);
    }
});

test('URL overrides: numeric values are parsed and applied', () => {
    const cfg = { FRACTURE_ENABLED: false, FRACTURE_JAGGEDNESS: 0.35 };
    applyUrlConfigOverrides(cfg, '?cfg.FRACTURE_JAGGEDNESS=0.6');
    assert.equal(cfg.FRACTURE_JAGGEDNESS, 0.6);
});

test('session metadata: creator config is serializable and joiner adopts it', () => {
    const keys = ['FRACTURE_ENABLED'];
    const creatorCfg = { FRACTURE_ENABLED: true };
    const sessionMetadata = { config: buildSessionConfigMetadata(creatorCfg, keys) };
    const joinerCfg = { FRACTURE_ENABLED: false };
    applySessionConfigMetadata(sessionMetadata, joinerCfg, keys);
    assert.equal(joinerCfg.FRACTURE_ENABLED, true);
});

test('session metadata locks seeded asteroid shape parameters', () => {
    const keys = ['ASTEROID_VERTICES', 'ASTEROID_JAGGEDNESS'];
    const creatorCfg = {
        ASTEROID_VERTICES: 11,
        ASTEROID_JAGGEDNESS: 0.42
    };
    const joinerCfg = {
        ASTEROID_VERTICES: 7,
        ASTEROID_JAGGEDNESS: 0.1
    };

    applySessionConfigMetadata(
        { config: buildSessionConfigMetadata(creatorCfg, keys) },
        joinerCfg,
        keys);

    assert.deepEqual(joinerCfg, creatorCfg);
});

test('session metadata precedence: session config wins over local URL-derived value', () => {
    const keys = ['FRACTURE_ENABLED'];
    const cfg = { FRACTURE_ENABLED: false };
    applyUrlConfigOverrides(cfg, '?cfg.FRACTURE_ENABLED=1');
    assert.equal(cfg.FRACTURE_ENABLED, true);
    applySessionConfigMetadata({ config: { FRACTURE_ENABLED: false } }, cfg, keys);
    assert.equal(cfg.FRACTURE_ENABLED, false);
});

test('live debug updates cannot replace active session configuration', () => {
    const cfg = { FRACTURE_ENABLED: false };
    const localBaseline = { FRACTURE_ENABLED: false };

    const configChanged = applyLiveConfigOverride(
        cfg,
        localBaseline,
        'FRACTURE_ENABLED',
        true,
        true);

    assert.equal(configChanged, false);
    assert.equal(cfg.FRACTURE_ENABLED, false);
    assert.equal(localBaseline.FRACTURE_ENABLED, true);
});

test('live debug updates become effective after leaving a session', () => {
    const cfg = { FRACTURE_ENABLED: false };
    const localBaseline = { FRACTURE_ENABLED: false };

    applyLiveConfigOverride(
        cfg,
        localBaseline,
        'FRACTURE_ENABLED',
        true,
        true);
    cfg.FRACTURE_ENABLED = localBaseline.FRACTURE_ENABLED;

    assert.equal(cfg.FRACTURE_ENABLED, true);
});

test('live debug updates still apply non-session settings during a session', () => {
    const cfg = { SHIP_MAX_SPEED: 1 };
    const localBaseline = {};

    const configChanged = applyLiveConfigOverride(
        cfg,
        localBaseline,
        'SHIP_MAX_SPEED',
        2,
        true);

    assert.equal(configChanged, true);
    assert.equal(cfg.SHIP_MAX_SPEED, 2);
});

test('URL overrides: string-typed config accepts arbitrary string values', () => {
    const cfg = { SIM_MODE: 'deterministic' };
    applyUrlConfigOverrides(cfg, '?cfg.SIM_MODE=buffered');
    assert.equal(cfg.SIM_MODE, 'buffered');
    applyUrlConfigOverrides(cfg, '?cfg.SIM_MODE=custom');
    assert.equal(cfg.SIM_MODE, 'custom');
});

test('URL overrides: empty string-typed value is rejected (keeps current value)', () => {
    const cfg = { SIM_MODE: 'deterministic' };
    applyUrlConfigOverrides(cfg, '?cfg.SIM_MODE=');
    assert.equal(cfg.SIM_MODE, 'deterministic');
});

test('string-typed config: numeric / boolean raw values are stringified', () => {
    // The debug BroadcastChannel may send a Number for sliders; the
    // session metadata path may carry a Boolean from an older client. Both
    // are coerced into the string-typed slot rather than silently dropped.
    const cfg = { SIM_MODE: 'deterministic' };
    assert.equal(coerceConfigOverrideValue(42, cfg.SIM_MODE), '42');
    assert.equal(coerceConfigOverrideValue(true, cfg.SIM_MODE), 'true');
    assert.equal(coerceConfigOverrideValue(false, cfg.SIM_MODE), 'false');
    assert.equal(coerceConfigOverrideValue(NaN, cfg.SIM_MODE), undefined);
    assert.equal(coerceConfigOverrideValue(null, cfg.SIM_MODE), undefined);
});

test('session metadata: string-typed config round-trips creator → joiner', () => {
    const keys = ['SIM_MODE'];
    const creatorCfg = { SIM_MODE: 'buffered' };
    const sessionMetadata = { config: buildSessionConfigMetadata(creatorCfg, keys) };
    const joinerCfg = { SIM_MODE: 'deterministic' };
    applySessionConfigMetadata(sessionMetadata, joinerCfg, keys);
    assert.equal(joinerCfg.SIM_MODE, 'buffered');
});
