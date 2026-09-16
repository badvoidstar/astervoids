import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

function element() {
    const writes = [];
    return {
        writes,
        classList: { toggle: (...args) => writes.push(['class', ...args]) },
        set textContent(value) { writes.push(['text', value]); },
        style: { set display(value) { writes.push(['display', value]); } },
    };
}

test('gameplay overlays write only when state, score, wave or spectator status changes', () => {
    const game = { state: 'playing', wave: 1, score: 0 };
    const elements = Object.fromEntries([
        'waveOverlay', 'waveTextEl', 'gameoverOverlay', 'gameoverScoreEl', 'gameoverPromptEl',
    ].map(name => [name, element()]));
    let over = false;
    let spectator = false;
    const { updateGameplayOverlays } = loadInlineGameFunctions(['updateGameplayOverlays'], {
        ...elements, game, overlayCache: {},
        isGameOver: () => over, isLobbySpectating: () => spectator,
    });
    updateGameplayOverlays();
    const countWrites = () => Object.values(elements).reduce((sum, el) => sum + el.writes.length, 0);
    const initialWrites = countWrites();
    for (let i = 0; i < 120; i++) updateGameplayOverlays();
    assert.equal(countWrites(), initialWrites);
    game.state = 'waveDelay';
    updateGameplayOverlays();
    assert.deepEqual(elements.waveTextEl.writes.at(-1), ['text', 'WAVE 2']);
    game.wave++;
    updateGameplayOverlays();
    assert.deepEqual(elements.waveTextEl.writes.at(-1), ['text', 'WAVE 3']);
    over = true;
    updateGameplayOverlays();
    game.score = 100;
    spectator = true;
    updateGameplayOverlays();
    assert.deepEqual(elements.gameoverScoreEl.writes.at(-1), ['text', 'Final Score: 100']);
    assert.deepEqual(elements.gameoverPromptEl.writes.at(-1), ['display', 'none']);
    const terminalWrites = countWrites();
    for (let i = 0; i < 120; i++) updateGameplayOverlays();
    assert.equal(countWrites(), terminalWrites);
});

test('mobile controls skip unchanged DOM writes', () => {
    const callbacks = [];
    const touchButtons = { restart: element(), pause: element() };
    let over = false;
    const game = { state: 'playing' };
    const { startMobileUILoop } = loadInlineGameFunctions(['startMobileUILoop'], {
        game, touchButtons, addFrameCallback: callback => callbacks.push(callback),
        isGameOver: () => over, isSessionMode: () => false,
        startScreen: { classList: { contains: () => true } },
    });
    startMobileUILoop();
    // One registration on the shared game-loop driver, not a self-rescheduling
    // requestAnimationFrame loop of its own.
    assert.equal(callbacks.length, 1, 'registered exactly once');
    for (let i = 0; i < 120; i++) callbacks[0]();
    assert.equal(touchButtons.restart.writes.length, 1);
    assert.equal(touchButtons.pause.writes.length, 1);
    over = true;
    game.state = 'gameover';
    callbacks[0]();
    assert.equal(touchButtons.restart.writes.length, 2);
    assert.equal(touchButtons.pause.writes.length, 2);
    assert.equal(callbacks.length, 1, 'no per-frame re-registration');
});

function analogHarness() {
    const html = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');
    const keysSource = html.match(/const analogInputConfigKeys = (\[[\s\S]*?\]);/)[1];
    const analogInputConfigKeys = new Function(`return ${keysSource};`)();
    const CONFIG = Object.fromEntries(analogInputConfigKeys.map(key => [key, 1]));
    const stickInput = { moveTouchId: null };
    const calls = { scale: 0, rect: 0, polar: 0 };
    let scale = 1;
    let scheme = 'rect';
    const production = loadInlineGameFunctions(
        ['updateStickAnalog', 'beginMoveAnchor', 'endMoveAnchor'], {
            CONFIG, stickInput, analogInputConfigKeys,
            analogInputCache: { config: {}, active: false },
            game: { ship: { angle: 0.5 } },
            getAnalogControlScheme: () => scheme,
            getAnalogAnchorScale: () => { calls.scale++; return scale; },
            ANALOG_CONTROL_SCHEMES: { POLAR: 'polar' },
            computeStickInput: () => {
                calls.rect++;
                return { rotationOffset: 0.2, thrust: 0.5, brake: 0 };
            },
            computePolarStickInput: () => {
                calls.polar++;
                return { active: true, radius: 1, targetAngle: 0.3, turnMagnitude: 0.5, thrust: 1, brake: 0 };
            },
        });
    return {
        ...production, CONFIG, calls, stickInput,
        resize: () => { scale = 2; },
        usePolar: () => { scheme = 'polar'; },
    };
}

test('idle analog frames skip parameter construction and mapping', () => {
    const h = analogHarness();
    for (let i = 0; i < 120; i++) h.updateStickAnalog();
    assert.deepEqual(h.calls, { scale: 0, rect: 0, polar: 0 });
});

test('active analog mapping invalidates on input, scale, mode, config and reused touch IDs', () => {
    const h = analogHarness();
    h.beginMoveAnchor(0, 20, 30);
    h.updateStickAnalog();
    for (let i = 0; i < 120; i++) h.updateStickAnalog();
    assert.equal(h.calls.rect, 1);
    h.stickInput.moveCurrentX++;
    h.updateStickAnalog();
    h.resize();
    h.updateStickAnalog();
    h.CONFIG.ANALOG_THRUST_GAIN = 2;
    h.updateStickAnalog();
    assert.equal(h.calls.rect, 4);
    h.usePolar();
    h.updateStickAnalog();
    assert.equal(h.calls.polar, 1);
    h.endMoveAnchor(0);
    h.beginMoveAnchor(0, 20, 30);
    h.stickInput.moveCurrentX++;
    h.updateStickAnalog();
    assert.equal(h.calls.polar, 2, 'new anchor cannot reuse cleared output from the last touch');
    h.endMoveAnchor(0);
    h.updateStickAnalog();
    assert.equal(h.stickInput.polarThrust, 0);
    assert.equal(h.stickInput.polarActive, false);
});

// ── single frame driver ─────────────────────────────────────────────────────
// Auxiliary per-frame work used to run from its own requestAnimationFrame loops
// (one for analog input, one for mobile UI visibility), so constrained devices
// paid three rAF callbacks per frame and the analog loop ran even on desktop.
// They are now registered on the game loop's frame-callback list.

function frameDriver() {
    const frameCallbacks = [];
    const errors = [];
    return {
        frameCallbacks,
        errors,
        ...loadInlineGameFunctions(['addFrameCallback', 'runFrameCallbacks'], {
            frameCallbacks,
            console: { error: (...args) => errors.push(args) },
        }),
    };
}

test('frame callbacks register once, in order, and reject non-functions', () => {
    const driver = frameDriver();
    const order = [];
    const first = () => order.push('first');
    const second = () => order.push('second');
    driver.addFrameCallback(first);
    driver.addFrameCallback(second);
    driver.addFrameCallback(first);
    for (const invalid of [null, undefined, 0, 'tick', {}]) driver.addFrameCallback(invalid);
    assert.equal(driver.frameCallbacks.length, 2);
    driver.runFrameCallbacks();
    assert.deepEqual(order, ['first', 'second']);
});

test('a throwing frame callback cannot take down the rest of the frame', () => {
    const driver = frameDriver();
    const reached = [];
    driver.addFrameCallback(() => { throw new Error('input blew up'); });
    driver.addFrameCallback(() => reached.push('survivor'));
    driver.runFrameCallbacks();
    assert.deepEqual(reached, ['survivor']);
    assert.equal(driver.errors.length, 1);
});

test('the game loop runs auxiliary callbacks before the simulation steps', () => {
    // Control intent sampled this frame must be visible to this frame's steps.
    const order = [];
    const elapsed = 1000 / 60;
    const game = { lastFrameTime: -elapsed };   // one whole fixed step this frame
    const { gameLoop } = loadInlineGameFunctions(['gameLoop'], {
        game,
        fixedStep: { accumulatorMs: 0, alpha: 0 },
        CONFIG: { TARGET_FPS: 60 },
        MAX_SIM_STEPS_PER_FRAME: 5,
        MAX_ACCUMULATED_MS: 250,
        fpsTracker: { sample() {} },
        runFrameCallbacks: () => order.push('frameCallbacks'),
        isSessionMode: () => false,
        isDeterministicMode: () => true,
        runSimulationStep: () => order.push('simulation'),
        renderScene: () => order.push('render'),
        requestAnimationFrame() {},
    });
    gameLoop(game.lastFrameTime + elapsed);
    assert.deepEqual(order, ['frameCallbacks', 'simulation', 'render']);
});
