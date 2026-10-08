import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const {
    ASTEROID_DIFFICULTY_PRESETS, SHARED_DEFAULTS, SESSION_CONFIG_KEYS, CONFIG_CONTROLS,
    applyLiveConfigOverride, buildSessionConfigMetadata, applySessionConfigMetadata,
} = require('./wwwroot/js/game-config.js');
const AstervoidsFracture = require('./wwwroot/js/asteroid-fracture.js');

function button() {
    return {
        textContent: '', title: '', disabled: false, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
    };
}

function harness(value = SHARED_DEFAULTS.ASTEROID_DIFFICULTY_FACTOR) {
    const state = { session: false };
    const config = { ...SHARED_DEFAULTS, ASTEROID_DIFFICULTY_FACTOR: value };
    const baseline = { ...config };
    const difficultyButton = button();
    const sessionPicker = { currentSessionId: null, operationPending: false };
    const asteroid = () => ({
        radius: 0.1, vertices: [{ distance: 0.1 }, { distance: 0.08 }],
        velocityX: 0.2, velocityY: -0.1, rebuilds: 0,
        rebuildShapeCache() { this.rebuilds++; },
    });
    const game = { astervoids: [asteroid()], cosmeticAstervoids: [asteroid()] };
    const functions = loadInlineGameFunctions([
        'isDifficultySelectionLocked', 'getNextDifficultyPreset',
        'updateDifficultyButton', 'cycleDifficulty', 'applyGameConfigOverride',
        'getEffectiveAspectSeverity', 'getEffectiveAsteroidAspectScales',
        'rescaleAsteroidForAspectChange', 'rescaleAsteroidsForAspectChange',
        'restoreLocalConfigBaseline',
    ], {
        CONFIG: config, LOCAL_CONFIG_BASELINE: baseline, SESSION_CONFIG_KEYS,
        ASTEROID_DIFFICULTY_PRESETS, difficultyButton, sessionPicker, game,
        applyLiveConfigOverride, AstervoidsFracture,
        isSessionMode: () => state.session,
        getGameWidth: () => 1000, getGameHeight: () => 1000,
        asteroidAspectScaleCache: null, adoptedAspectSeverity: 1,
    });
    functions.updateDifficultyButton();
    return { ...functions, state, config, baseline, difficultyButton, sessionPicker, game };
}

test('difficulty presets define the ordered cycle and default to Dancer', () => {
    assert.deepEqual(ASTEROID_DIFFICULTY_PRESETS, [
        { label: 'Shifter', value: 0.2 },
        { label: 'Dancer', value: 0.35 },
        { label: 'Raver', value: 0.5 },
        { label: 'Survivor', value: 0.65 },
    ]);
    assert.ok(Object.isFrozen(ASTEROID_DIFFICULTY_PRESETS));
    assert.ok(ASTEROID_DIFFICULTY_PRESETS.every(Object.isFrozen));
    assert.equal(SHARED_DEFAULTS.ASTEROID_DIFFICULTY_FACTOR, 0.35);
});

test('each difficulty click advances one preset, updates the label and wraps repeatedly', () => {
    const h = harness();
    assert.equal(h.difficultyButton.textContent, '🎯 : Dancer');
    assert.equal(h.difficultyButton.disabled, false);
    const cycle = [...ASTEROID_DIFFICULTY_PRESETS.slice(2), ...ASTEROID_DIFFICULTY_PRESETS.slice(0, 2)];
    for (const preset of [...cycle, ...cycle]) {
        assert.equal(h.cycleDifficulty(), true);
        assert.equal(h.config.ASTEROID_DIFFICULTY_FACTOR, preset.value);
        assert.equal(h.baseline.ASTEROID_DIFFICULTY_FACTOR, preset.value);
        assert.equal(h.difficultyButton.textContent, `🎯 : ${preset.label}`);
        assert.match(h.difficultyButton.attributes['aria-label'],
            new RegExp(`Difficulty: ${preset.label}`));
        assert.ok(h.difficultyButton.title.includes(h.getNextDifficultyPreset().label));
    }
});

test('difficulty clicks reuse live rescaling for gameplay and cosmetic asteroid geometry', () => {
    const h = harness();
    let clicks = 0;
    for (const preset of [...ASTEROID_DIFFICULTY_PRESETS.slice(2), ...ASTEROID_DIFFICULTY_PRESETS.slice(0, 2)]) {
        h.cycleDifficulty();
        clicks++;
        const ratio = Math.sqrt(preset.value / SHARED_DEFAULTS.ASTEROID_DIFFICULTY_FACTOR);
        for (const asteroid of [...h.game.astervoids, ...h.game.cosmeticAstervoids]) {
            assert.ok(Math.abs(asteroid.radius - 0.1 * ratio) < 1e-12);
            assert.ok(Math.abs(asteroid.vertices[1].distance - 0.08 * ratio) < 1e-12);
            assert.ok(Math.abs(asteroid.velocityX - 0.2 * ratio) < 1e-12);
            assert.ok(Math.abs(asteroid.velocityY + 0.1 * ratio) < 1e-12);
            assert.equal(asteroid.rebuilds, clicks);
        }
    }
});

for (const lock of ['session mode', 'recorded membership', 'pending membership operation']) {
    test(`${lock} locks difficulty without changing the current or next-game choice`, () => {
        const h = harness();
        if (lock === 'session mode') h.state.session = true;
        if (lock === 'recorded membership') h.sessionPicker.currentSessionId = 'joined-session';
        if (lock === 'pending membership operation') h.sessionPicker.operationPending = true;
        h.updateDifficultyButton();
        assert.equal(h.difficultyButton.disabled, true);
        assert.equal(h.cycleDifficulty(), false);
        assert.equal(h.config.ASTEROID_DIFFICULTY_FACTOR, 0.35);
        assert.equal(h.baseline.ASTEROID_DIFFICULTY_FACTOR, 0.35);
        assert.equal(h.difficultyButton.textContent, '🎯 : Dancer');
        assert.match(h.difficultyButton.title, /session/i);
        assert.equal(h.game.astervoids[0].rebuilds, 0);
    });
}

test('session adoption shows the creator choice and leaving restores the local selection', () => {
    const host = harness();
    host.cycleDifficulty();
    const guest = harness();
    guest.cycleDifficulty();
    guest.cycleDifficulty();
    guest.cycleDifficulty();
    applySessionConfigMetadata({ config: buildSessionConfigMetadata(host.config) }, guest.config);
    guest.state.session = true;
    guest.sessionPicker.currentSessionId = 'joined-session';
    guest.updateDifficultyButton();
    assert.equal(guest.difficultyButton.textContent, '🎯 : Raver');
    assert.equal(guest.difficultyButton.disabled, true);
    assert.equal(guest.config.ASTEROID_DIFFICULTY_FACTOR, 0.5);
    assert.equal(guest.baseline.ASTEROID_DIFFICULTY_FACTOR, 0.2);

    guest.state.session = false;
    guest.sessionPicker.currentSessionId = null;
    guest.restoreLocalConfigBaseline();
    guest.updateDifficultyButton();
    assert.equal(guest.difficultyButton.textContent, '🎯 : Shifter');
    assert.equal(guest.difficultyButton.disabled, false);
    assert.equal(guest.config.ASTEROID_DIFFICULTY_FACTOR, 0.2);
});

for (const value of [0.4, 0.6, 0.75]) {
    test(`custom URL/debug factor ${value} stays unchanged until a preset is explicitly selected`, () => {
        const h = harness(value);
        assert.equal(h.difficultyButton.textContent, '🎯 : Custom');
        assert.ok(h.difficultyButton.attributes['aria-label'].includes(`Custom (${value})`));
        assert.equal(h.config.ASTEROID_DIFFICULTY_FACTOR, value);
        assert.equal(h.baseline.ASTEROID_DIFFICULTY_FACTOR, value);
        h.cycleDifficulty();
        assert.equal(h.config.ASTEROID_DIFFICULTY_FACTOR, 0.2);
        assert.equal(h.difficultyButton.textContent, '🎯 : Shifter');
    });
}

test('live debug changes refresh the selector and preserve session-locked baseline behavior', () => {
    const h = harness();
    assert.equal(h.applyGameConfigOverride('ASTEROID_DIFFICULTY_FACTOR', 0.5), true);
    assert.equal(h.difficultyButton.textContent, '🎯 : Raver');
    assert.equal(h.baseline.ASTEROID_DIFFICULTY_FACTOR, 0.5);
    assert.equal(h.game.astervoids[0].rebuilds, 1);
    h.state.session = true;
    assert.equal(h.applyGameConfigOverride('ASTEROID_DIFFICULTY_FACTOR', 0.2), false);
    assert.equal(h.config.ASTEROID_DIFFICULTY_FACTOR, 0.5);
    assert.equal(h.baseline.ASTEROID_DIFFICULTY_FACTOR, 0.2);
    assert.equal(h.difficultyButton.textContent, '🎯 : Raver');
    assert.equal(h.difficultyButton.disabled, true);
    assert.equal(h.game.astervoids[0].rebuilds, 1);
});

test('controller clicks retain the joystick, colon, exact labels and one-step wraparound', () => {
    const analogControlModeButton = button();
    let resets = 0;
    const h = loadInlineGameFunctions([
        'getAnalogControlScheme', 'updateAnalogControlModeButton',
        'setAnalogControlScheme', 'toggleAnalogControlScheme',
    ], {
        ANALOG_CONTROL_SCHEMES: { POLAR: 'polar', RECTILINEAR: 'rectilinear' },
        analogControlScheme: 'polar', analogControlModeButton,
        resetStickInput: () => { resets++; },
    });
    h.updateAnalogControlModeButton();
    assert.equal(analogControlModeButton.textContent, '🕹️ : Polar');
    assert.equal(analogControlModeButton.title, 'Switch to Boxy controls');
    for (const [label, scheme] of [
        ['Boxy', 'rectilinear'], ['Polar', 'polar'], ['Boxy', 'rectilinear'], ['Polar', 'polar'],
    ]) {
        assert.equal(h.toggleAnalogControlScheme(), true);
        assert.equal(analogControlModeButton.textContent, `🕹️ : ${label}`);
        assert.equal(h.getAnalogControlScheme(), scheme);
        const nextLabel = scheme === 'polar' ? 'Boxy' : 'Polar';
        assert.equal(analogControlModeButton.title, `Switch to ${nextLabel} controls`);
        assert.equal(analogControlModeButton.attributes['aria-label'],
            `Control mode: ${label}. Switch to ${nextLabel} controls.`);
    }
    assert.equal(resets, 4);
});

test('Boxy debug labels retain the existing rectilinear configuration keys', () => {
    for (const key of [
        'ANALOG_RECTILINEAR_TURN_GAIN',
        'ANALOG_RECTILINEAR_TURN_DEADZONE_PX',
        'ANALOG_RECTILINEAR_THRUST_DEADZONE_PX',
    ]) {
        assert.match(CONFIG_CONTROLS.find(control => control.key === key).label, /^Analog boxy /);
    }
});
