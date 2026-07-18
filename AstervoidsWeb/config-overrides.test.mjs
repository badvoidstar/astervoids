import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    SHARED_DEFAULTS,
    CONFIG_CONTROLS,
    coerceConfigOverrideValue,
    applyUrlConfigOverrides,
    applySessionConfigMetadata,
    buildSessionConfigMetadata,
} = require('./wwwroot/js/game-config.js');

test('debug controls derive defaults from the shared runtime values', () => {
    for (const control of CONFIG_CONTROLS) {
        const expected = typeof SHARED_DEFAULTS[control.key] === 'boolean'
            ? Number(SHARED_DEFAULTS[control.key])
            : SHARED_DEFAULTS[control.key];
        assert.equal(control.default, expected, control.key);
    }
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

test('URL overrides: string-typed config accepts arbitrary string values', () => {
    const cfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    applyUrlConfigOverrides(cfg, '?cfg.TOUCH_CONTROL_SCHEME=rectilinear');
    assert.equal(cfg.TOUCH_CONTROL_SCHEME, 'rectilinear');
    applyUrlConfigOverrides(cfg, '?cfg.TOUCH_CONTROL_SCHEME=classic');
    assert.equal(cfg.TOUCH_CONTROL_SCHEME, 'classic');
});

test('URL overrides: empty string-typed value is rejected (keeps current value)', () => {
    const cfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    applyUrlConfigOverrides(cfg, '?cfg.TOUCH_CONTROL_SCHEME=');
    assert.equal(cfg.TOUCH_CONTROL_SCHEME, 'polar');
});

test('string-typed config: numeric / boolean raw values are stringified', () => {
    // The debug BroadcastChannel may send a Number for sliders; the
    // session metadata path may carry a Boolean from an older client. Both
    // are coerced into the string-typed slot rather than silently dropped.
    const cfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    assert.equal(coerceConfigOverrideValue(42, cfg.TOUCH_CONTROL_SCHEME), '42');
    assert.equal(coerceConfigOverrideValue(true, cfg.TOUCH_CONTROL_SCHEME), 'true');
    assert.equal(coerceConfigOverrideValue(false, cfg.TOUCH_CONTROL_SCHEME), 'false');
    assert.equal(coerceConfigOverrideValue(NaN, cfg.TOUCH_CONTROL_SCHEME), undefined);
    assert.equal(coerceConfigOverrideValue(null, cfg.TOUCH_CONTROL_SCHEME), undefined);
});

test('session metadata: string-typed config round-trips creator → joiner', () => {
    const keys = ['TOUCH_CONTROL_SCHEME'];
    const creatorCfg = { TOUCH_CONTROL_SCHEME: 'rectilinear' };
    const sessionMetadata = { config: buildSessionConfigMetadata(creatorCfg, keys) };
    const joinerCfg = { TOUCH_CONTROL_SCHEME: 'polar' };
    applySessionConfigMetadata(sessionMetadata, joinerCfg, keys);
    assert.equal(joinerCfg.TOUCH_CONTROL_SCHEME, 'rectilinear');
});
