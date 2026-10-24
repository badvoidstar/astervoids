import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const {
    SHARED_DEFAULTS,
    CONFIG_CONTROLS,
    DEBUG_OVERRIDABLE_KEYS,
    DEBUG_CONFIG_STORAGE_KEY,
    SESSION_CONFIG_KEYS,
    coerceConfigOverrideValue,
    isValidConfigOverride,
    applyConfigOverride,
    applyUrlConfigOverrides,
    applyStoredDebugConfigOverrides,
    applyLiveConfigOverride,
    applySessionConfigMetadata,
    buildSessionConfigMetadata,
    countExtraLivesForScore,
} = require('./wwwroot/js/game-config.js');

const SHIELD_KEYS = ['SHIP_SHIELD_DRAIN_SECONDS', 'SHIP_SHIELD_RECHARGE_SECONDS'];
const shieldControl = key => CONFIG_CONTROLS.find(control => control.key === key);
const invalidShieldValues = key => {
    const { min, max, step } = shieldControl(key);
    return [
        min - step, max + step, NaN, Infinity, -Infinity,
        true, false, null, undefined, '', ' ', 'invalid', 'Infinity', 'NaN',
        [], [SHARED_DEFAULTS[key]], {}, { valueOf: () => SHARED_DEFAULTS[key] },
    ];
};

function bootstrapDebugPage({ stored = null, storageError, helperError } = {}) {
    const source = readFileSync(new URL('./wwwroot/debug/index.html', import.meta.url), 'utf8');
    let configSource = readFileSync(new URL('./wwwroot/js/game-config.js', import.meta.url), 'utf8');
    const scripts = [...source.matchAll(/<script(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/g)];
    const messages = [];
    const saved = [];
    const warnings = [];
    const elements = new Map();
    const element = () => {
        const selectors = new Map();
        return {
            style: {}, children: [], listeners: new Map(),
            appendChild(child) { this.children.push(child); },
            addEventListener(event, handler) { this.listeners.set(event, handler); },
            querySelector(selector) {
                if (!selectors.has(selector)) selectors.set(selector, element());
                return selectors.get(selector);
            },
        };
    };
    const storage = {
        getItem(key) {
            assert.equal(key, DEBUG_CONFIG_STORAGE_KEY);
            return stored;
        },
        setItem(key, value) {
            assert.equal(key, DEBUG_CONFIG_STORAGE_KEY);
            stored = value;
            saved.push(JSON.parse(value));
        },
    };
    const sandbox = {
        BroadcastChannel: class {
            postMessage(message) { messages.push(message); }
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            createElement: element,
        },
        console: { warn(...args) { warnings.push(args); } },
        setInterval() {},
        debugHelperError: helperError,
        window: {},
    };
    const storageProperty = {
        get() {
            if (storageError) throw storageError;
            return storage;
        },
    };
    Object.defineProperty(sandbox, 'localStorage', storageProperty);
    Object.defineProperty(sandbox.window, 'localStorage', storageProperty);
    const context = createContext(sandbox);
    if (helperError) {
        const declaration = 'function applyStoredDebugConfigOverrides(config, storage) {';
        assert.ok(configSource.includes(declaration));
        configSource = configSource.replace(declaration, `${declaration}\nthrow debugHelperError;`);
    }
    for (const [, scriptPath, inline] of scripts) {
        if (scriptPath === '/js/shared-config-data.js') {
            const sharedConfiguration = require('./wwwroot/shared-config.json');
            runInContext(`globalThis.ASTERVOIDS_SHARED_CONFIG = ${JSON.stringify(sharedConfiguration)}`, context);
        } else if (scriptPath === '/js/game-config.js') {
            runInContext(configSource, context);
        } else {
            assert.equal(scriptPath, undefined, 'unexpected debug-page script dependency');
            runInContext(inline, context);
        }
    }
    return {
        messages, saved, warnings,
        edit(key, value) {
            const index = CONFIG_CONTROLS.findIndex(control => control.key === key);
            assert.ok(index >= 0, key);
            const input = elements.get('config-panel').children[index].querySelector('input');
            input.value = String(value);
            input.listeners.get('input')();
        },
    };
}

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

    const applied = applyStoredDebugConfigOverrides(cfg, storage);

    assert.equal(cfg.ASTEROID_DIFFICULTY_FACTOR, 1.4);
    assert.equal(cfg.SHIP_MAX_SPEED, 2);
    assert.equal(cfg.UNKNOWN_KEY, undefined);
    assert.deepEqual(applied, { ASTEROID_DIFFICULTY_FACTOR: 1.4, SHIP_MAX_SPEED: 2 });
});

test('invalid persisted debug state leaves configuration unchanged', () => {
    const cfg = { ASTEROID_DIFFICULTY_FACTOR: 0.8 };
    assert.deepEqual(applyStoredDebugConfigOverrides(cfg, { getItem: () => '{invalid' }), {});
    assert.equal(cfg.ASTEROID_DIFFICULTY_FACTOR, 0.8);
});

test('stored debug loader returns only successfully applied normalized keys, not unrelated defaults', () => {
    const [drain, recharge] = SHIELD_KEYS;
    const cfg = Object.fromEntries(CONFIG_CONTROLS.map(control => [control.key, control.default]));
    const selected = 'SHIP_MAX_SPEED';
    const value = shieldControl(drain).min + shieldControl(drain).step;
    const expected = { [drain]: value, [selected]: SHARED_DEFAULTS[selected] };
    const applied = applyStoredDebugConfigOverrides(cfg, {
        getItem: () => JSON.stringify({
            [drain]: String(value),
            [recharge]: shieldControl(recharge).max + shieldControl(recharge).step,
            [selected]: String(SHARED_DEFAULTS[selected]),
            ASTEROID_DENSITY: 'invalid',
            UNKNOWN_KEY: 99,
        }),
    });
    assert.deepEqual(applied, expected, 'an explicitly saved default is retained, but unsaved defaults are absent');
    assert.equal(cfg[drain], value);
    assert.equal(cfg[recharge], SHARED_DEFAULTS[recharge]);
    assert.equal(cfg.ASTEROID_DENSITY, SHARED_DEFAULTS.ASTEROID_DENSITY);
    assert.equal(cfg.UNKNOWN_KEY, undefined);
    assert.deepEqual(applyStoredDebugConfigOverrides(cfg, null), {});
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

test('shield defaults, second-based controls and session keys have one shared authority', () => {
    assert.deepEqual(SHIELD_KEYS.map(key => SHARED_DEFAULTS[key]), [2, 10]);
    for (const key of SHIELD_KEYS) {
        const controls = CONFIG_CONTROLS.filter(control => control.key === key);
        assert.equal(controls.length, 1, key);
        const control = controls[0];
        assert.deepEqual(
            { min: control.min, max: control.max, step: control.step },
            { min: 0.1, max: 60, step: 0.1 }, key);
        assert.equal(control.default, SHARED_DEFAULTS[key], key);
        assert.equal(control.fmt(control.default), `${SHARED_DEFAULTS[key].toFixed(1)} s`, key);
        assert.equal(DEBUG_OVERRIDABLE_KEYS.filter(item => item === key).length, 1, key);
        assert.equal(SESSION_CONFIG_KEYS.filter(item => item === key).length, 1, key);
    }
});

test('shield URL, stored and live callers accept decimal values and inclusive control bounds', () => {
    for (const key of SHIELD_KEYS) {
        const { min, max, step } = shieldControl(key);
        const values = [min, min + step, SHARED_DEFAULTS[key] + step / 2, max - step, max];
        for (const value of values) {
            assert.equal(isValidConfigOverride(key, value), true, `${key}: ${value}`);
            const cfg = { [key]: SHARED_DEFAULTS[key] };
            applyUrlConfigOverrides(cfg, `?${new URLSearchParams({ [`cfg.${key}`]: value })}`);
            assert.equal(cfg[key], value, `URL ${key}: ${value}`);

            for (const rawValue of [value, String(value)]) {
                const stored = { [key]: SHARED_DEFAULTS[key] };
                applyStoredDebugConfigOverrides(stored, {
                    getItem: () => JSON.stringify({ [key]: rawValue }),
                });
                assert.equal(stored[key], value, `stored ${key}: ${rawValue}`);

                const live = { [key]: SHARED_DEFAULTS[key] };
                const baseline = { ...live };
                assert.equal(applyLiveConfigOverride(live, baseline, key, rawValue, false), true);
                assert.equal(live[key], value, `live ${key}: ${rawValue}`);
                assert.equal(baseline[key], value, `baseline ${key}: ${rawValue}`);
            }
        }
    }
});

test('shield validation and direct/live callers reject invalid values without changing baselines', () => {
    for (const key of SHIELD_KEYS) {
        for (const value of invalidShieldValues(key)) {
            assert.equal(isValidConfigOverride(key, value), false, key);
            const direct = { [key]: SHARED_DEFAULTS[key] };
            assert.equal(applyConfigOverride(direct, key, value), false, key);
            assert.equal(direct[key], SHARED_DEFAULTS[key], key);

            for (const sessionActive of [false, true]) {
                const cfg = { [key]: SHARED_DEFAULTS[key] };
                const baseline = { ...cfg };
                assert.equal(
                    applyLiveConfigOverride(cfg, baseline, key, value, sessionActive), false, key);
                assert.equal(cfg[key], SHARED_DEFAULTS[key], key);
                assert.equal(baseline[key], SHARED_DEFAULTS[key], key);
            }
        }
    }
});

test('shield URL and stored parsers reject range, nonfinite and incorrect-type inputs', () => {
    for (const key of SHIELD_KEYS) {
        const { min, max, step } = shieldControl(key);
        for (const value of [
            min - step, max + step, 'Infinity', '-Infinity', 'NaN', '1e309',
            'true', 'false', 'null', '[]', '{}', '', ' ', 'invalid',
        ]) {
            const cfg = { [key]: SHARED_DEFAULTS[key] };
            applyUrlConfigOverrides(cfg, `?${new URLSearchParams({ [`cfg.${key}`]: value })}`);
            assert.equal(cfg[key], SHARED_DEFAULTS[key], `URL ${key}: ${value}`);
        }

        const invalidStored = invalidShieldValues(key).map(value => JSON.stringify({ [key]: value }));
        invalidStored.push(`{"${key}":1e309}`, `{"${key}":-1e309}`);
        for (const raw of invalidStored) {
            const cfg = { [key]: SHARED_DEFAULTS[key] };
            applyStoredDebugConfigOverrides(cfg, { getItem: () => raw });
            assert.equal(cfg[key], SHARED_DEFAULTS[key], `stored ${key}: ${raw}`);
        }
    }
});

test('shield bounds do not change legacy numeric and boolean coercion', () => {
    const key = 'ASTEROID_DIFFICULTY_FACTOR';
    const control = CONFIG_CONTROLS.find(item => item.key === key);
    const outOfRange = control.max + control.step;
    const cfg = { [key]: SHARED_DEFAULTS[key] };
    applyUrlConfigOverrides(cfg, `?cfg.${key}=${outOfRange}`);
    assert.equal(cfg[key], outOfRange);
    assert.equal(applyConfigOverride(cfg, key, true), true);
    assert.equal(cfg[key], 1);
});

test('shield creator metadata overrides guest preferences and joined admin edits stay local', () => {
    const creator = Object.fromEntries(SHIELD_KEYS.map(key => [key, SHARED_DEFAULTS[key]]));
    for (const key of SHIELD_KEYS) {
        const { min, step } = shieldControl(key);
        applyUrlConfigOverrides(creator, `?cfg.${key}=${min + step}`);
    }
    const metadata = JSON.parse(JSON.stringify({ config: buildSessionConfigMetadata(creator) }));
    const guest = Object.fromEntries(SHIELD_KEYS.map(key => [key, shieldControl(key).max]));
    const baseline = { ...guest };
    applySessionConfigMetadata(metadata, guest);
    assert.deepEqual(guest, creator);

    for (const key of SHIELD_KEYS) {
        const value = shieldControl(key).max - shieldControl(key).step;
        assert.equal(applyLiveConfigOverride(guest, baseline, key, value, true), false, key);
        assert.equal(guest[key], creator[key], key);
        assert.equal(baseline[key], value, key);
    }
    Object.assign(guest, baseline);
    assert.deepEqual(guest, baseline, 'leaving restores the edited local baseline');
    const nextSession = buildSessionConfigMetadata(guest);
    for (const key of SHIELD_KEYS) assert.equal(nextSession[key], baseline[key], key);
});

test('shield missing or malformed session metadata always uses shared defaults, not guest values', () => {
    const expected = Object.fromEntries(SHIELD_KEYS.map(key => [key, SHARED_DEFAULTS[key]]));
    const inherited = Object.create(
        Object.fromEntries(SHIELD_KEYS.map(key => [key, shieldControl(key).min])));
    for (const metadata of [
        undefined, null, {}, { config: null }, { config: 'invalid' },
        { config: [] }, { config: {} }, { config: inherited },
    ]) {
        const guest = Object.fromEntries(SHIELD_KEYS.map(key => [key, shieldControl(key).max]));
        applySessionConfigMetadata(metadata, guest);
        assert.deepEqual(guest, expected);
    }
    const absentCreatorValues = buildSessionConfigMetadata({});
    for (const key of SHIELD_KEYS) assert.equal(absentCreatorValues[key], SHARED_DEFAULTS[key], key);
});

test('shield invalid session fields default independently on creator and guest paths', () => {
    const validCreator = Object.fromEntries(SHIELD_KEYS.map(key => [key, shieldControl(key).min]));
    for (const key of SHIELD_KEYS) {
        for (const value of [...invalidShieldValues(key), String(SHARED_DEFAULTS[key])]) {
            const config = { ...validCreator, [key]: value };
            const expected = { ...validCreator, [key]: SHARED_DEFAULTS[key] };
            const built = buildSessionConfigMetadata(config, SHIELD_KEYS);
            assert.deepEqual(built, expected, `creator ${key}`);

            const guest = Object.fromEntries(SHIELD_KEYS.map(item => [item, shieldControl(item).max]));
            applySessionConfigMetadata({ config }, guest, SHIELD_KEYS);
            assert.deepEqual(guest, expected, `guest ${key}`);
        }
    }
});

test('shield metadata helpers respect explicit key selections and retain unrelated fallback behavior', () => {
    const [key, excludedKey] = SHIELD_KEYS;
    const cfg = {
        [key]: shieldControl(key).max,
        [excludedKey]: shieldControl(excludedKey).max,
        SIM_MODE: 'local',
    };
    applySessionConfigMetadata(null, cfg, [key, 'SIM_MODE']);
    assert.equal(cfg[key], SHARED_DEFAULTS[key]);
    assert.equal(cfg[excludedKey], shieldControl(excludedKey).max);
    assert.equal(cfg.SIM_MODE, 'local');
    assert.deepEqual(buildSessionConfigMetadata({}, [key]), { [key]: SHARED_DEFAULTS[key] });
});

test('debug page validates saved values and persists only saved or edited keys, never unrelated defaults', () => {
    const defaults = Object.fromEntries(SHIELD_KEYS.map(key => [key, SHARED_DEFAULTS[key]]));
    const [drain, recharge] = SHIELD_KEYS;
    const selected = 'SHIP_MAX_SPEED';
    const valid = {
        [drain]: shieldControl(drain).min,
        [recharge]: SHARED_DEFAULTS[recharge] + shieldControl(recharge).step / 2,
    };
    for (const [stored, expected, sparse] of [
        [null, defaults, {}],
        ['{}', defaults, {}],
        [JSON.stringify({
            [drain]: shieldControl(drain).max + shieldControl(drain).step,
            [recharge]: true,
        }), defaults, {}],
        [JSON.stringify({ [drain]: [], [recharge]: {} }), defaults, {}],
        [JSON.stringify({ ...valid, [drain]: String(valid[drain]) }), valid, valid],
        [JSON.stringify({
            [drain]: String(valid[drain]),
            [recharge]: shieldControl(recharge).max + shieldControl(recharge).step,
            [selected]: String(SHARED_DEFAULTS[selected]),
            ASTEROID_DENSITY: 'invalid',
            UNKNOWN_KEY: 99,
        }), { ...defaults, [drain]: valid[drain] }, {
            [drain]: valid[drain], [selected]: SHARED_DEFAULTS[selected],
        }],
        ['null', defaults, {}], ['[]', defaults, {}], ['{invalid', defaults, {}],
    ]) {
        const page = bootstrapDebugPage({ stored });
        const updates = page.messages.filter(message => message?.type === 'config-update');
        assert.equal(updates.length, CONFIG_CONTROLS.length);
        for (const key of SHIELD_KEYS) {
            assert.equal(updates.find(message => message.key === key)?.value, expected[key], key);
        }
        assert.deepEqual(page.saved, [], 'bootstrap does not rewrite storage');
        assert.deepEqual(page.warnings, []);
        const edited = SHARED_DEFAULTS[recharge] + shieldControl(recharge).step;
        page.edit(recharge, edited);
        assert.deepEqual(page.saved, [{ ...sparse, [recharge]: edited }], `persisted keys for ${stored}`);
        assert.equal(page.messages.at(-1).key, recharge);
        assert.equal(page.messages.at(-1).value, edited);
    }
});

test('debug page reports the known blocked localStorage getter without hiding other getter failures', () => {
    const blocked = Object.assign(new Error('Storage blocked'), { name: 'SecurityError' });
    const page = bootstrapDebugPage({ storageError: blocked });
    assert.equal(page.warnings.length, 1);
    assert.match(page.warnings[0][0], /debug configuration storage.*unavailable/i);
    assert.equal(page.warnings[0][1], blocked);
    assert.equal(
        page.messages.filter(message => message?.type === 'config-update').length,
        CONFIG_CONTROLS.length);
    assert.deepEqual(page.saved, []);

    const unexpected = new TypeError('Unexpected storage getter failure');
    assert.throws(() => bootstrapDebugPage({ storageError: unexpected }), error => error === unexpected);
});

test('debug bootstrap does not swallow arbitrary canonical-loader failures', () => {
    const failure = new Error('Unexpected configuration helper failure');
    assert.throws(() => bootstrapDebugPage({ helperError: failure }), error => error === failure);
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

test('terminal ship tuning is URL configurable and shared by the session creator', () => {
    const cfg = { SHIP_TERMINAL_SEPARATION: 0.35, SHIP_TERMINAL_ROTATION: 2 };
    applyUrlConfigOverrides(cfg, '?cfg.SHIP_TERMINAL_SEPARATION=0.25&cfg.SHIP_TERMINAL_ROTATION=0.2');
    assert.deepEqual(cfg, { SHIP_TERMINAL_SEPARATION: 0.25, SHIP_TERMINAL_ROTATION: 0.2 });
    const joiner = { SHIP_TERMINAL_SEPARATION: 0, SHIP_TERMINAL_ROTATION: 0 };
    applySessionConfigMetadata({ config: buildSessionConfigMetadata(cfg) }, joiner);
    assert.deepEqual(joiner, cfg, 'joiner URL settings cannot diverge from the session');
    applyUrlConfigOverrides(cfg, '?cfg.SHIP_TERMINAL_ROTATION=Infinity&cfg.SHIP_TERMINAL_SEPARATION=invalid');
    assert.deepEqual(cfg, joiner, 'non-finite overrides are rejected');
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
        'Analog boxy turn dead-zone (CSS px @ 390px gameplay ref)');
    assert.equal(rectTurnDeadzone?.fmt(16), '16 px @ 390');

    const rectTurnGain = controls.get('ANALOG_RECTILINEAR_TURN_GAIN');
    assert.equal(rectTurnGain?.label, 'Analog boxy rotation-offset gain');
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
