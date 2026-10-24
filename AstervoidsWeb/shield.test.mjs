import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const GameConfig = require('./wwwroot/js/game-config.js');
const Collision = require('./wwwroot/js/collision-geometry.js');
const Fracture = require('./wwwroot/js/asteroid-fracture.js');
const Wire = require('./wwwroot/js/astervoids-wire-codec.js');
const SchemaCodec = require('./wwwroot/js/schema-codec.js');
const { SCHEMAS } = require('./wwwroot/js/game-wire-schemas.js');
const ReplicationPresentation = require('./wwwroot/js/replication-presentation.js');
const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');
const ME = '00000001-1111-2222-3333-aabbccddeeff';
const PEER = '00000002-1111-2222-3333-aabbccddeeff';

function snippet(startMarker, endMarker, from = 0) {
    const start = source.indexOf(startMarker, from);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `Production source markers: ${startMarker} / ${endMarker}`);
    return source.slice(start, end);
}

function execute(code, dependencies) {
    return compileFunction(code, Object.keys(dependencies))(...Object.values(dependencies));
}

// The extraction helper loads declarations, not constants. Parse just one
// production initializer rather than copying its defaults or booting the page.
function inlineValue(name, dependencies = {}) {
    const match = new RegExp(`^\\s*const ${name} =`, 'm').exec(source);
    assert.ok(match, `Production constant ${name} exists`);
    for (let end = source.indexOf(';', match.index); end !== -1; end = source.indexOf(';', end + 1)) {
        let factory;
        try {
            factory = compileFunction(`${source.slice(match.index, end + 1)}\nreturn ${name};`,
                Object.keys(dependencies));
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            continue;
        }
        return factory(...Object.values(dependencies));
    }
    assert.fail(`Incomplete production initializer: ${name}`);
}

const SHIELD_GESTURE = inlineValue('SHIELD_GESTURE');

function load(names, dependencies) {
    const globals = { ...dependencies };
    for (const name of names) delete globals[name];
    return loadInlineGameFunctions(names, globals);
}

function harness({ session = false, deterministic = true, fatal = false } = {}) {
    let now = 1000;
    const config = inlineValue('CONFIG', { SHARED_CONFIG_DEFAULTS: GameConfig.SHARED_DEFAULTS });
    const viewport = { width: 1000, height: 1000 };
    const game = {
        state: 'playing', lives: 3, score: 0, wave: 1, ship: null,
        bullets: [], astervoids: [], cosmeticAstervoids: [],
        multiplayer: {
            myShipObjectId: session ? 'local-ship' : null,
            remoteShips: new Map(), processedPendingBullets: new Set(),
        },
    };
    const events = [];
    const writes = [];
    const records = new Map();
    const shieldInput = inlineValue('shieldInput');
    const stickInput = inlineValue('stickInput');
    const keys = {};
    const canvas = {
        classList: { contains: () => false },
        getBoundingClientRect: () => ({
            left: 0, top: 0, right: viewport.width, bottom: viewport.height,
            width: viewport.width, height: viewport.height,
        }),
    };
    const ObjectSync = {
        getObject: id => records.get(id),
        getObjectsByType: type => [...records.values()].filter(record => record.data.type === type),
        getObjectByType: type => [...records.values()].find(record => record.data.type === type),
        isDataConfirmed: (id, data) => Object.entries(data).every(([key, value]) =>
            records.get(id)?.lastSentData?.[key] === value),
        updateObject(id, data, immediate) {
            writes.push({ id, data: structuredClone(data), immediate });
            if (records.has(id)) Object.assign(records.get(id).data, data);
        },
        tick: elapsed => events.push(['tick', elapsed]),
    };
    const dependencies = {
        CONFIG: config, game, ObjectSync, shieldInput, stickInput, keys, canvas,
        SHIELD_GESTURE, SHIELD_CHARGE_EPSILON: inlineValue('SHIELD_CHARGE_EPSILON'),
        MOUSE_MOVE_TOUCH_ID: inlineValue('MOUSE_MOVE_TOUCH_ID'),
        MOUSE_FIRE_TOUCH_ID: inlineValue('MOUSE_FIRE_TOUCH_ID'),
        localShipShieldWrite: null,
        mouseMoveControlActive: false, mouseFireControlActive: false,
        mouseFireContextMenuTargets: null,
        TURN_CONTROL_MODE: inlineValue('TURN_CONTROL_MODE'),
        OBJECT_TYPES: { SHIP: 'ship', ASTEROID: 'asteroid', BULLET: 'bullet', GAME_STATE: 'gameState' },
        SHIP_COLORS: ['#0ff'],
        performance: { now: () => now },
        isSessionMode: () => session,
        isDeterministicMode: () => deterministic,
        isGameOver: () => game.lives <= 0 || game.state === 'gameover',
        getGameWidth: () => viewport.width,
        getGameHeight: () => viewport.height,
        RemoteObjects: {
            clock: { offsetInitialized: false },
            getDelayForMember: () => 100,
            serverNowMs: () => now,
        },
        SessionClient: { getCurrentMember: () => ({ id: ME }) },
        ShipSendGate: { shouldSend: () => false },
        ShipControlGate: { isEdge: () => false },
        AstervoidsCollision: Collision, AstervoidsFracture: Fracture,
        AstervoidsWireCodec: Wire, ReplicationPresentation,
        pointInPolygon: Collision.pointInPolygon,
        countExtraLivesForScore: GameConfig.countExtraLivesForScore,
        getEffectiveAsteroidAspectScales: () => ({ speedScale: 1 }),
        randomRange: () => 0,
        isMenuScrollTarget: () => false,
        isPersonalScoreScrollTarget: () => false,
        isAnalogControlSchemeEnabled: () => true,
        leaderboardScreen: { hidden: true },
        pauseMenu: { classList: { add() {}, remove() {} } },
        CollisionEffects: {
            startAsteroidHit: (...args) => events.push(['asteroid-cue', ...args]),
            startShipHit: (...args) => events.push(['ship-cue', ...args]),
        },
        AudioSystem: {
            init() {}, resume() {},
            playFire: () => events.push(['fire']),
            playShipExplosion: () => events.push(['ship-explosion']),
            playExplosion: () => events.push(['asteroid-explosion']),
            thrustSound: { start() {}, stop() {} },
            beat: { start() {}, stop() {}, updateTempo() {} },
        },
        splitAsteroid: (...args) => events.push(['split', ...args]),
        emitOwnedAsteroidImpactCue: (...args) => events.push(['owned-cue', ...args]),
        emitShipStateChanged: (...args) => events.push(['ship-event', ...args]),
        createSyncedBullet: bullet => events.push(['create-bullet', bullet]),
        deleteSyncedBullet: bullet => events.push(['delete-bullet', bullet]),
        getShipByMemberId: () => null,
        predictFatalShipHit: () => fatal,
        announceExtraLifeAward: () => events.push(['extra-life']),
        updateHUD() {}, publishDebugMetrics() {},
        resolveTerminalSession: () => null,
        _error: error => { throw error; },
    };
    const production = load([
        'Ship', 'ShipInvulnerability', 'assignDefined', 'rampInputToward',
        'normalizeTurnControlMode', 'getShipTurnSpeed', 'getReferenceDimension',
        'fromNormalizedX', 'fromNormalizedY', 'fromNormalizedSize',
        'sizeToNormalizedX', 'sizeToNormalizedY',
        'velocityToNormalizedDeltaX', 'velocityToNormalizedDeltaY',
        'wrapNormalized', 'wrapMarginX', 'wrapMarginY',
        'canActivateLocalShipShield', 'refreshLocalShipShield',
        'requestLocalShipShield', 'resetLocalShipShieldInput', 'advanceLocalShipShield',
        'resetStickInput', 'setMouseMoveControlActive',
        'beginMoveAnchor', 'updateMoveAnchor', 'endMoveAnchor', 'beginFireInput', 'endFireInput',
        'classifyTouchSide', 'isPointWithinRect', 'isStickTouchTarget',
        'syncLocalShipShield', 'syncLocalShip', 'syncLocalShipScore',
        'createDeadReckoningState', 'replayDeadReckonedShip', 'applyShipReplicaData',
        'handleShipHit', 'beginShipDeathHold', 'resolveShipDeathHold',
        'settleShipTerminalVisuals', 'togglePause', 'Bullet',
    ], dependencies);
    game.ship = new production.Ship(0.52, 0.5);
    Object.assign(game.ship, { angle: 0, memberId: ME, participantId: ME, participantTag: 'Pilot' });
    if (session) {
        records.set('local-ship', {
            id: 'local-ship', ownerMemberId: ME, data: game.ship.toSyncData(),
            lastSentData: { shieldState: 0, score: 0 },
        });
    }
    return {
        ...production, dependencies: { ...dependencies, ...production },
        game, config, viewport, events, writes, records, shieldInput, stickInput, canvas, keys,
        mouse: dependencies.MOUSE_MOVE_TOUCH_ID,
        now: () => now,
        elapse: milliseconds => { now += milliseconds; },
        advance(ticks, dt = 1) {
            for (let i = 0; i < ticks; i++) production.advanceLocalShipShield(dt);
        },
    };
}

function bindKeyboard(h) {
    const handlers = new Map();
    execute(snippet('// Track key presses', '// Prevent focus loss from affecting input'), {
        ...h.dependencies,
        document: { addEventListener: (name, handler) => handlers.set(name, handler) },
    });
    return (type, code, repeat = false) => handlers.get(type)({
        code, repeat, preventDefault() {}, target: h.canvas,
    });
}

function bindTouches(h) {
    const handlers = new Map();
    execute(snippet("gameContainer.addEventListener('touchstart', (e) => {",
        '// Mouse movement control:'), {
        ...h.dependencies,
        gameContainer: { addEventListener: (name, handler) => handlers.set(name, handler) },
    });
    return (type, changedTouches) => handlers.get(type)({
        type, changedTouches: changedTouches.map(touch => ({ target: h.canvas, ...touch })),
    });
}

function tap(h, id = 1, x = 100, y = 100) {
    assert.equal(h.beginMoveAnchor(id, x, y), true);
    assert.equal(h.endMoveAnchor(id), true);
}

function simulation(h, overrides = {}) {
    return load(['runSimulationStep'], {
        ...h.dependencies,
        handleInput() {}, snapshotRenderState() {}, isLobbySpectating: () => false,
        isGameStateOwner: () => false,
        updateRemoteShips() {}, updateOwnedAsteroids() {}, syncLocalAstervoids() {},
        updateAstervoidsFromSync() {}, syncLocalBullets() {}, updateBulletsFromSync() {},
        updateGameStateFromSync() {}, publishOwnedTerminalTargets() {},
        advanceWaveProgression: () => false,
        sessionPicker: { gameStarted: false },
        checkCollisions() {},
        ...overrides,
    }).runSimulationStep;
}

// Capture the real anonymous fallback callback without starting an interval,
// DOM, hub, or render loop. Named game logic still comes from inline-game.mjs.
function hiddenSimulation(h, overrides = {}) {
    let visibility;
    let tick;
    execute(snippet('// Handle visibility change - prevent pause in multiplayer',
        '// ── Region service bootstrap'), {
        ...h.dependencies,
        document: { hidden: true, addEventListener: (_, handler) => { visibility = handler; } },
        Date: { now: h.now },
        setInterval: handler => { tick = handler; return 1; },
        updateOwnedAsteroids() {}, syncLocalAstervoids() {}, updateAstervoidsFromSync() {},
        syncLocalBullets() {}, updateBulletsFromSync() {}, updateRemoteShips() {},
        updateGameStateFromSync() {}, publishOwnedTerminalTargets() {},
        repositionDeadReckonedRemotes() {}, isGameStateOwner: () => false,
        advanceWaveProgression() {}, checkCollisions() {},
        ...overrides,
    });
    visibility();
    assert.equal(typeof tick, 'function', 'Production hidden multiplayer callback is installed');
    return () => tick();
}

test('default resource clocks drain in two simulation seconds and refill in ten', () => {
    const h = harness();
    assert.deepEqual([h.config.SHIP_SHIELD_DRAIN_SECONDS, h.config.SHIP_SHIELD_RECHARGE_SECONDS], [2, 10]);
    const fps = h.config.TARGET_FPS;
    h.requestLocalShipShield('ShiftLeft', true);
    h.advance(fps);
    assert.ok(Math.abs(h.game.ship.shieldCharge - 0.5) < 1e-12);
    assert.equal(h.game.ship.shieldActive, true);
    h.advance(fps);
    assert.equal(h.game.ship.shieldCharge, 0, 'The exact endpoint is zero, not a positive float remainder');
    assert.equal(h.game.ship.shieldActive, false);
    h.requestLocalShipShield('ShiftLeft', false);
    h.advance(5 * fps);
    assert.ok(Math.abs(h.game.ship.shieldCharge - 0.5) < 1e-12);
    h.advance(5 * fps);
    assert.equal(h.game.ship.shieldCharge, 1);
    h.advance(2 * fps);
    assert.equal(h.game.ship.shieldCharge, 1, 'Recharge never overfills');
});

test('runtime duration changes and TARGET_FPS control normalized charge, not wall time', () => {
    const h = harness();
    h.config.SHIP_SHIELD_DRAIN_SECONDS = 4;
    h.config.SHIP_SHIELD_RECHARGE_SECONDS = 2;
    h.config.TARGET_FPS = 120;
    h.requestLocalShipShield('ShiftRight', true);
    h.elapse(3_600_000);
    h.advanceLocalShipShield(120);
    assert.equal(h.game.ship.shieldCharge, 0.75, 'One authored second, not an hour of wall time');
    h.requestLocalShipShield('ShiftRight', false);
    h.advanceLocalShipShield(30);
    assert.equal(h.game.ship.shieldCharge, 0.875);
    h.advanceLocalShipShield(10_000);
    assert.equal(h.game.ship.shieldCharge, 1);
    h.requestLocalShipShield('ShiftRight', true);
    h.advanceLocalShipShield(10_000);
    assert.equal(h.game.ship.shieldCharge, 0);
    assert.equal(h.game.ship.shieldActive, false);
});

test('canonical session config reaches production adoption without inheriting guest shield overrides', () => {
    const h = harness();
    const guestBaseline = {
        ...GameConfig.snapshotConfigValues(h.config, GameConfig.SESSION_CONFIG_KEYS),
        SHIP_SHIELD_DRAIN_SECONDS: 9, SHIP_SHIELD_RECHARGE_SECONDS: 17,
    };
    const { adoptSessionConfig } = load(['adoptSessionConfig', 'restoreLocalConfigBaseline'], {
        CONFIG: h.config,
        LOCAL_CONFIG_BASELINE: guestBaseline,
        SESSION_CONFIG_KEYS: GameConfig.SESSION_CONFIG_KEYS,
        applySessionConfigMetadata: GameConfig.applySessionConfigMetadata,
        adoptSessionSim() {}, resetCosmeticAsteroids() {},
        adoptedAspectSeverity: 1,
    });
    const fields = config => [config.SHIP_SHIELD_DRAIN_SECONDS, config.SHIP_SHIELD_RECHARGE_SECONDS];
    const creator = {
        ...h.config, SHIP_SHIELD_DRAIN_SECONDS: 4.25, SHIP_SHIELD_RECHARGE_SECONDS: 12.5,
    };
    adoptSessionConfig({ config: GameConfig.buildSessionConfigMetadata(creator) });
    assert.deepEqual(fields(h.config), fields(creator), 'The canonical creator values own both durations');
    for (const metadata of [null, {}, { config: {} },
        { config: { SHIP_SHIELD_DRAIN_SECONDS: 0, SHIP_SHIELD_RECHARGE_SECONDS: NaN } }]) {
        adoptSessionConfig(metadata);
        assert.deepEqual(fields(h.config), fields(GameConfig.SHARED_DEFAULTS),
            'Missing/invalid metadata must not leak the restored guest baseline into a session');
    }
    adoptSessionConfig({ config: { SHIP_SHIELD_DRAIN_SECONDS: 4.25 } });
    assert.deepEqual(fields(h.config), [4.25, GameConfig.SHARED_DEFAULTS.SHIP_SHIELD_RECHARGE_SECONDS],
        'Fallback is per-field, not all-or-nothing');
});

test('exhaustion requires every Shift and gesture owner to release; repeats do not rearm', () => {
    const h = harness();
    const keyboard = bindKeyboard(h);
    keyboard('keydown', 'ShiftLeft');
    keyboard('keydown', 'ShiftRight');
    tap(h);
    h.beginMoveAnchor(2, 100, 100);
    h.advanceLocalShipShield(h.config.TARGET_FPS * h.config.SHIP_SHIELD_DRAIN_SECONDS);
    assert.equal(h.shieldInput.heldSources.size, 3);
    assert.equal(h.shieldInput.depleted, true);
    h.advanceLocalShipShield(h.config.TARGET_FPS);
    const partial = h.game.ship.shieldCharge;
    assert.ok(partial > 0 && partial < 1);
    keyboard('keydown', 'ShiftRight', true);
    keyboard('keyup', 'ShiftLeft');
    h.endMoveAnchor(2);
    assert.equal(h.game.ship.shieldActive, false, 'One exhausted Shift is still held');
    keyboard('keydown', 'ShiftLeft');
    keyboard('keyup', 'ShiftRight');
    assert.equal(h.game.ship.shieldActive, false, 'A newly held source cannot bypass another exhausted demand');
    keyboard('keyup', 'ShiftLeft');
    h.advanceLocalShipShield(1);
    assert.equal(h.game.ship.shieldActive, false, 'Recharge alone never creates an activation');
    keyboard('keydown', 'ShiftLeft', true);
    assert.equal(h.game.ship.shieldActive, false, 'A repeat is not a fresh press, even after reset/release');
    keyboard('keydown', 'ShiftLeft');
    assert.equal(h.game.ship.shieldActive, true, 'A fresh press can spend partial charge');
});

test('both Shift keys have independent hold/release ownership', () => {
    const h = harness();
    const keyboard = bindKeyboard(h);
    keyboard('keydown', 'ShiftRight');
    keyboard('keydown', 'ShiftLeft');
    const state = h.game.ship.shieldState;
    keyboard('keyup', 'ShiftRight');
    assert.equal(h.game.ship.shieldActive, true);
    assert.equal(h.game.ship.shieldState, state, 'Releasing one owner is not an off/on edge');
    keyboard('keyup', 'ShiftLeft');
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.game.ship.shieldState, state + 1);
});

test('pause cancels requests and freezes charge; invalid dt and lifecycle freezes cannot advance it', () => {
    const h = harness();
    h.requestLocalShipShield('ShiftLeft', true);
    h.advanceLocalShipShield(h.config.TARGET_FPS / 2);
    h.togglePause();
    const charge = h.game.ship.shieldCharge;
    h.advanceLocalShipShield(600);
    assert.equal(h.game.ship.shieldCharge, charge);
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.shieldInput.heldSources.size, 0);
    h.togglePause();
    for (const dt of [0, -1, NaN, Infinity, -Infinity]) h.advanceLocalShipShield(dt);
    assert.equal(h.game.ship.shieldCharge, charge);
    for (const flag of ['connectionLost', 'identityChanging']) {
        h.game[flag] = true;
        h.advanceLocalShipShield(60);
        assert.equal(h.requestLocalShipShield('ShiftRight', true), false);
        assert.equal(h.game.ship.shieldCharge, charge, flag);
        h.game[flag] = false;
    }
    h.advanceLocalShipShield(1);
    assert.ok(h.game.ship.shieldCharge > charge, 'Live simulation resumes recharge');
});

test('death/respawn waits recharge without activation and every completed life refills', () => {
    const h = harness({ session: true });
    h.requestLocalShipShield('ShiftLeft', true);
    h.game.ship.shieldCharge = 0.2;
    h.beginShipDeathHold(h.game.ship);
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.shieldInput.heldSources.size, 0);
    assert.equal(h.requestLocalShipShield('ShiftRight', true), false);
    h.advanceLocalShipShield(h.config.TARGET_FPS);
    assert.ok(Math.abs(h.game.ship.shieldCharge - 0.3) < 1e-12);
    h.game.state = 'respawning';
    h.advanceLocalShipShield(h.config.TARGET_FPS);
    assert.ok(Math.abs(h.game.ship.shieldCharge - 0.4) < 1e-12);
    h.elapse(h.config.SHIP_DEATH_HOLD_TIMEOUT_MS);
    h.resolveShipDeathHold();
    assert.equal(h.game.ship.deathHold, null);
    assert.equal(h.game.ship.shieldCharge, 1);
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.writes.at(-1).data.shieldCharge, 1, 'Respawn publishes its refill');
    h.game.state = 'playing';
    for (let life = 0; life < 3; life++) {
        h.requestLocalShipShield('ShiftLeft', true);
        h.game.ship.shieldCharge = 0.1;
        h.handleShipHit(h.game.ship);
        assert.equal(h.game.ship.shieldCharge, 1, `Respawn ${life + 1}`);
        assert.equal(h.game.ship.shieldActive, false);
        assert.equal(h.shieldInput.heldSources.size, 0);
    }
    const fresh = new h.Ship(0.5, 0.5);
    assert.equal(fresh.shieldCharge, 1, 'A newly created run/ship is full');
    assert.equal(fresh.shieldActive, false);
});

test('Ship.update and real dead-reckoning scratch replay never advance shield resources', () => {
    const h = harness();
    h.requestLocalShipShield('ShiftLeft', true);
    h.game.ship.shieldCharge = 0.4;
    h.game.ship.update(3);
    assert.equal(h.game.ship.shieldCharge, 0.4);
    const state = h.createDeadReckoningState(h.game.ship.toSyncData(), h.now());
    const context = { replayCache: new WeakMap() };
    h.replayDeadReckonedShip(state, 4.5, {}, false, context, null);
    assert.equal(h.game.ship.shieldCharge, 0.4);
    assert.equal(context.scratch.shieldCharge, 1, 'The scratch ship was integrated, not charged/drained');
});

for (const [boundary, limit, delta] of [
    ['first tap duration', SHIELD_GESTURE.TAP_MAX_DURATION_MS, 0.001],
    ['second down delay', SHIELD_GESTURE.SECOND_DOWN_MAX_DELAY_MS, 0.001],
    ['first tap excursion', SHIELD_GESTURE.MAX_DISTANCE_PX, 0.001],
    ['second down distance', SHIELD_GESTURE.MAX_DISTANCE_PX, 0.001],
]) {
    test(`gesture ${boundary} accepts the exact/inside boundary and rejects just outside`, () => {
        for (const value of [limit - delta, limit, limit + delta]) {
            const h = harness();
            h.beginMoveAnchor(11, 100, 100);
            if (boundary === 'first tap duration') h.elapse(value);
            if (boundary === 'first tap excursion') h.updateMoveAnchor(11, 100 + value, 100);
            h.endMoveAnchor(11);
            if (boundary === 'second down delay') h.elapse(value);
            h.beginMoveAnchor(22, boundary === 'second down distance' ? 100 + value : 100, 100);
            assert.equal(h.game.ship.shieldActive, value <= limit, `${boundary}: ${value}`);
        }
    });
}

test('a large first excursion cannot become a tap by returning to its origin', () => {
    const h = harness();
    h.beginMoveAnchor(1, 100, 100);
    h.updateMoveAnchor(1, 100 + SHIELD_GESTURE.MAX_DISTANCE_PX + 1, 100);
    h.updateMoveAnchor(1, 100, 100);
    h.endMoveAnchor(1);
    h.beginMoveAnchor(2, 100, 100);
    assert.equal(h.game.ship.shieldActive, false);
});

test('a qualifying second drag is unrestricted, but only its owner can update or release it', () => {
    const h = harness();
    tap(h, 11);
    h.beginMoveAnchor(22, 100, 100);
    assert.equal(h.game.ship.shieldActive, true, 'Touch identifiers may change between taps');
    assert.equal(h.beginMoveAnchor(33, 100, 100), false, 'Another finger cannot steal movement');
    assert.equal(h.updateMoveAnchor(33, 900, 900), false);
    h.updateMoveAnchor(22, 800, 900);
    assert.equal(h.game.ship.shieldActive, true, 'The held second drag is not limited to the tap radius');
    assert.equal(h.endMoveAnchor(33), false);
    assert.equal(h.game.ship.shieldActive, true);
    h.endMoveAnchor(22);
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.shieldInput.firstTap, null, 'A shield hold cannot prime a third activation');
});

test('actual touch handlers exclude right fire and letterboxing, and ignore unrelated releases', () => {
    const h = harness();
    const touch = bindTouches(h);
    const finger = (identifier, clientX, clientY = 500) => ({ identifier, clientX, clientY });
    touch('touchstart', [finger(5, 750)]);
    assert.equal(h.stickInput.fireTouchId, 5);
    touch('touchend', [finger(5, 750)]);
    touch('touchstart', [finger(11, 250)]);
    assert.equal(h.game.ship.shieldActive, false, 'A right firing tap did not prime the left movement tap');
    touch('touchend', [finger(11, 250)]);
    touch('touchstart', [finger(22, 250)]);
    assert.equal(h.game.ship.shieldActive, true);
    touch('touchstart', [finger(33, 750)]);
    touch('touchend', [finger(33, 750)]);
    assert.equal(h.game.ship.shieldActive, true, 'Releasing the firing finger cannot drop the movement shield');
    touch('touchend', [finger(99, 250)]);
    assert.equal(h.stickInput.moveTouchId, 22);
    touch('touchcancel', [finger(22, 250)]);
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.shieldInput.firstTap, null);
    touch('touchstart', [finger(44, -1)]);
    assert.equal(h.stickInput.moveTouchId, null, 'Off-canvas touches acquire neither side');
});

test('cancel and global reset clear candidates, demands and gesture kind without refilling charge', () => {
    const h = harness();
    h.game.ship.shieldCharge = 0.4;
    h.beginMoveAnchor(1, 100, 100);
    h.endMoveAnchor(1, true);
    h.beginMoveAnchor(2, 100, 100);
    assert.equal(h.game.ship.shieldActive, false, 'A cancellation never primes a second down');
    h.endMoveAnchor(2);
    h.resetStickInput();
    h.beginMoveAnchor(3, 100, 100);
    assert.equal(h.game.ship.shieldActive, false, 'Reset discarded the pending tap');
    h.endMoveAnchor(3);
    h.beginMoveAnchor(h.mouse, 100, 100);
    assert.equal(h.game.ship.shieldActive, false, 'Touch and mouse candidates cannot cross-prime');
    h.endMoveAnchor(h.mouse);
    h.beginMoveAnchor(h.mouse, 100, 100);
    h.requestLocalShipShield('ShiftLeft', true);
    h.resetStickInput();
    assert.equal(h.shieldInput.heldSources.size, 0);
    assert.equal(h.shieldInput.movePress, null);
    assert.equal(h.shieldInput.firstTap, null);
    assert.equal(h.stickInput.moveTouchId, null);
    assert.equal(h.game.ship.shieldActive, false);
    assert.equal(h.game.ship.shieldCharge, 0.4);
});

for (const deterministic of [true, false]) {
    test(`foreground and hidden pivots advance once before collisions (deterministic=${deterministic})`, () => {
        const h = harness({ session: true, deterministic });
        h.requestLocalShipShield('ShiftLeft', true);
        const charges = [];
        const checkCollisions = () => charges.push(h.game.ship.shieldCharge);
        const step = simulation(h, { checkCollisions });
        step(1, false);
        const perTick = 1 / (h.config.TARGET_FPS * h.config.SHIP_SHIELD_DRAIN_SECONDS);
        assert.ok(Math.abs(charges[0] - (1 - perTick)) < 1e-12);
        step(1, true);
        assert.equal(charges.length, 1, 'Reconnect freeze skips the whole local simulation pivot');
        const tick = hiddenSimulation(h, { checkCollisions });
        h.elapse(10_000);
        tick();
        assert.ok(Math.abs(charges[1] - (1 - 4 * perTick)) < 1e-12,
            'A long-hidden callback advances only the existing three-tick clamp, once');
    });

    test(`terminal maintenance publishes/retries off and resting replicas cannot revive the ring (deterministic=${deterministic})`, () => {
        const h = harness({ session: true, deterministic });
        h.requestLocalShipShield('ShiftLeft', true);
        h.game.ship.x = 0.33;
        h.game.lives = 0;
        h.game.state = 'gameover';
        const step = simulation(h);
        step(1, false);
        assert.equal(h.game.ship.shieldActive, false);
        assert.equal(h.writes.at(-1).immediate, true);
        assert.equal(h.writes.at(-1).data.shieldState & 1, 0);
        assert.equal(h.writes.at(-1).data.x, 0.33);
        const count = h.writes.length;
        h.elapse(h.config.SEND_ON_CHANGE_HEARTBEAT_MS);
        hiddenSimulation(h)();
        assert.ok(h.writes.length > count, 'Hidden terminal maintenance retries an unconfirmed off transition');
        const replica = new h.Ship(0.5, 0.5);
        replica.fromSyncData({ shieldState: 1, shieldCharge: 0.5 });
        h.game.multiplayer.remoteShips.set('remote', replica);
        h.settleShipTerminalVisuals();
        replica.fromSyncData({ shieldState: 1, shieldCharge: 0.5 });
        assert.equal(replica.shieldActive, false, 'Rest reconciliation cannot resurrect a terminal circle');
        replica.reset();
        assert.equal(replica.shieldCharge, 1);
        assert.equal(replica.shieldActive, false);
    });
}

function collisionHarness(options) {
    const h = harness(options);
    return Object.assign(h, load([
        'Asteroid', 'checkCollisions', 'checkShipAsteroidCollision', 'shipAsteroidCrash',
        'prepareAsteroidCollision', 'fireShipCrashImpact', 'computeBulletImpact',
        'computeBulletAsteroidImpact', 'awardSoloAsteroidScore',
        'resolveBulletAsteroidHit', 'resolveSoloAsteroidHit', 'resolveOwnedAsteroidHit',
        'claimCrossOwnerAsteroidHit', 'confirmOwnedAsteroidHitClaims', 'retireConfirmedPendingBullets',
    ], h.dependencies));
}

function rock(h, owner = ME) {
    const half = 0.01;
    const asteroid = new h.Asteroid(0.545, 0.5, half, 0, 0, 123,
        [[-half, -half], [half, -half], [half, half], [-half, half]]
            .map(([x, y]) => ({ angle: Math.atan2(y, x), distance: Math.hypot(x, y) })));
    asteroid.angle = 0;
    asteroid.syncObjectId = 'rock';
    h.game.astervoids.push(asteroid);
    h.records.set('rock', { id: 'rock', ownerMemberId: owner, data: { type: 'asteroid' } });
    return asteroid;
}

for (const [session, owner] of [[false, ME], [true, ME], [true, PEER]]) {
    test(`shield contact has no crash/asteroid consequences (session=${session}, owner=${owner === ME ? 'self' : 'peer'})`, () => {
        const h = collisionHarness({ session });
        const asteroid = rock(h, owner);
        assert.ok(h.checkShipAsteroidCollision(h.game.ship), 'The unshielded production hull really overlaps');
        h.requestLocalShipShield('ShiftLeft', true);
        const baselineWrites = h.writes.length;
        h.checkCollisions();
        assert.deepEqual(h.events, [], 'No crash sound/cue, equivalent bullet, split, deflection or score event');
        assert.equal(h.game.ship.hitCount, 0);
        assert.equal(h.game.ship.score, 0);
        assert.equal(h.game.score, 0);
        assert.equal(h.game.lives, 3);
        assert.equal(h.game.ship.deathHold, null);
        assert.deepEqual(h.game.bullets, []);
        assert.deepEqual(h.game.astervoids, [asteroid]);
        assert.equal(h.records.get('rock').ownerMemberId, owner);
        assert.equal(h.writes.length, baselineWrites, 'Contact makes no ownership or object-data update');
        h.requestLocalShipShield('ShiftLeft', false);
        h.checkCollisions();
        assert.equal(h.game.ship.hitCount, 1, 'Ordinary contact damage returns immediately on release');
        assert.ok(h.events.some(([kind]) => kind === 'ship-explosion'));
    });
}

test('effective shield returns before geometry; zero charge and spawn protection are independent', () => {
    const h = collisionHarness();
    rock(h);
    const original = h.game.ship.getVertices;
    h.requestLocalShipShield('ShiftLeft', true);
    h.game.ship.getVertices = () => assert.fail('Shielded contact must not inspect hull geometry');
    assert.equal(h.checkShipAsteroidCollision(h.game.ship), null);
    h.game.ship.getVertices = original;
    h.game.ship.shieldCharge = 0;
    assert.ok(h.checkShipAsteroidCollision(h.game.ship), 'An obsolete active bit at zero charge is not effective');
    h.requestLocalShipShield('ShiftLeft', false);
    h.game.ship.invulnerable = h.config.INVULNERABILITY_TIME;
    h.checkCollisions();
    assert.equal(h.game.ship.hitCount, 0, 'Spawn invulnerability still independently suppresses damage');
    h.game.ship.invulnerable = 0;
    h.checkCollisions();
    assert.equal(h.game.ship.hitCount, 1);
});

test('normal Ship.shoot bullets still destroy and score through the real shielded collision pass', () => {
    const h = collisionHarness();
    const asteroid = rock(h);
    h.requestLocalShipShield('ShiftLeft', true);
    const bullet = h.game.ship.shoot();
    assert.ok(bullet, 'The real ship can fire while shielded');
    h.game.bullets.push(bullet);
    h.checkCollisions();
    assert.equal(h.game.ship.hitCount, 0);
    assert.equal(h.game.lives, 3);
    assert.equal(h.game.ship.shieldActive, true);
    assert.equal(h.game.score, asteroid.getPoints());
    assert.equal(h.game.astervoids.length, 0);
    assert.equal(h.game.bullets.length, 0);
    assert.deepEqual(h.events.map(([kind]) => kind),
        ['fire', 'asteroid-cue', 'asteroid-explosion', 'split']);
});

test('shielding does not skip pending cross-owner bullet confirmation or retirement', () => {
    const h = collisionHarness({ session: true });
    rock(h);
    h.requestLocalShipShield('ShiftLeft', true);
    h.records.set('peer-bullet', {
        id: 'peer-bullet', data: {
            type: 'bullet', pendingHit: true, hitTargetId: 'rock', ownerMemberId: PEER,
            hitBulletAngle: 0.7, hitOffsetN: 0.2, hitImpactTorque: 0.1,
        },
    });
    h.checkCollisions();
    assert.equal(h.events.filter(([kind]) => kind === 'split').length, 1);
    assert.equal(h.events.find(([kind]) => kind === 'split')[2], PEER);
    assert.equal(h.game.ship.hitCount, 0);
    h.game.bullets.push({
        pendingHit: true, ownerMemberId: ME, hitTargetId: 'removed-rock',
        pendingPoints: h.config.POINTS_SMALL, syncObjectId: 'owned-pending',
    });
    h.checkCollisions();
    assert.equal(h.game.ship.score, h.config.POINTS_SMALL);
    assert.equal(h.game.bullets.length, 0);
    assert.ok(h.events.some(([kind]) => kind === 'delete-bullet'));
    assert.equal(h.game.ship.shieldActive, true);
});

test('ship creation/update serialization preserves appended shield state and quantized charge', () => {
    const h = harness();
    SchemaCodec.replaceAll(SCHEMAS);
    const schema = SchemaCodec.get(1);
    assert.deepEqual(SCHEMAS.find(schema => schema.id === 1).fields.slice(28),
        [['shieldState', 'u32'], ['shieldCharge', 'q16']]);
    h.game.ship.setShieldActive(true);
    h.game.ship.shieldCharge = 0.375;
    for (const data of [h.game.ship.toSyncData(), h.game.ship.toUpdateData()]) {
        const received = SchemaCodec.decode(schema, SchemaCodec.encode(schema, data));
        const replica = new h.Ship(0, 0);
        replica.fromSyncData(received);
        assert.equal(replica.shieldActive, true);
        assert.equal(replica.shieldState, h.game.ship.shieldState);
        assert.ok(Math.abs(replica.shieldCharge - 0.375) <= 1 / 65535);
    }
    const state = h.game.ship.shieldState;
    h.advanceLocalShipShield(1);
    assert.equal(h.game.ship.shieldState, state + 1, 'Dropping an unrequested activation is one transition');
    h.game.ship.shieldState = 0xfffffffe;
    h.game.ship.setShieldActive(true);
    assert.equal(h.game.ship.shieldState, 0xffffffff);
    h.game.ship.setShieldActive(false);
    assert.equal(h.game.ship.shieldState, 0, 'The transition counter wraps as u32');
});

test('production replica bootstrap defaults absent shield data off/zero and partial updates retain it', () => {
    const h = harness({ session: true });
    const descriptor = inlineValue('shipReplicationDescriptor', {
        ...h.dependencies,
        kinematicPresentation: {},
        seedReplicaAtTerminalTarget: instance => instance,
    });
    const replica = descriptor.createReplica({ id: 'remote', data: { x: 0.5, y: 0.5 } });
    assert.equal(replica.shieldActive, false);
    assert.equal(replica.shieldCharge, 0, 'A missing remote field must not inherit the local constructor refill');
    replica.fromSyncData({ shieldState: 7, shieldCharge: 0.4 });
    replica.fromSyncData({ x: 0.6 });
    assert.equal(replica.shieldState, 7);
    assert.equal(replica.shieldCharge, 0.4);
    for (const invalid of [NaN, Infinity, -Infinity, '0.5']) {
        replica.fromSyncData({ shieldCharge: invalid, shieldState: -1 });
        assert.equal(replica.shieldCharge, 0.4);
        assert.equal(replica.shieldState, 7);
    }
    replica.fromSyncData({ shieldCharge: -0.1 });
    assert.equal(replica.shieldCharge, 0);
    replica.fromSyncData({ shieldCharge: 1.1 });
    assert.equal(replica.shieldCharge, 1);
});

test('real deterministic kinematic samples recover durable shield fields, without projecting remote charge', () => {
    const h = harness({ session: true });
    const data = { ...h.game.ship.toSyncData(), shieldState: 3, shieldCharge: 0.25 };
    h.records.set('remote', { id: 'remote', data });
    const replica = new h.Ship(0, 0);
    const sampled = h.createDeadReckoningState(data, h.now());
    assert.equal(sampled.shieldState, undefined, 'The production kinematic sample really omits presentation fields');
    h.applyShipReplicaData(replica, sampled, { objectId: 'remote' }, { renderTime: h.now() });
    assert.equal(replica.shieldActive, true);
    assert.equal(replica.shieldCharge, 0.25);
    h.elapse(60_000);
    h.applyShipReplicaData(replica, sampled, { objectId: 'remote' }, { renderTime: h.now() });
    assert.equal(replica.shieldCharge, 0.25, 'Remote resource presentation is not a wall-clock simulation');
    h.applyShipReplicaData(replica, { shieldState: 2, shieldCharge: 0.7 },
        { objectId: 'remote' }, { renderTime: h.now() });
    assert.equal(replica.shieldActive, false, 'A complete delayed/buffered sample wins over the newer record');
    assert.equal(replica.shieldCharge, 0.7);
});

test('shield edges bypass a closed motion gate, carry current pose, and retry only until confirmed', () => {
    const h = harness({ session: true });
    h.requestLocalShipShield('ShiftLeft', true);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].immediate, true);
    assert.equal(h.writes[0].data.shieldState & 1, 1);
    h.syncLocalShip();
    assert.equal(h.writes.length, 1, 'The closed motion gate is not the publisher of the edge');
    h.game.ship.x = 0.7;
    h.game.ship.shieldCharge = 0.8;
    h.elapse(h.config.SEND_ON_CHANGE_HEARTBEAT_MS - 1);
    h.syncLocalShipShield();
    assert.equal(h.writes.length, 1);
    h.elapse(1);
    h.syncLocalShipShield();
    assert.equal(h.writes.length, 2, 'An optimistic update is not confirmation');
    assert.equal(h.writes.at(-1).data.x, 0.7, 'Retries capture the current pose, not the first edge pose');
    assert.equal(h.writes.at(-1).data.shieldCharge, 0.8);
    h.records.get('local-ship').lastSentData.shieldState = h.game.ship.shieldState;
    h.elapse(h.config.SEND_ON_CHANGE_HEARTBEAT_MS);
    h.syncLocalShipShield();
    assert.equal(h.writes.length, 2);
    h.game.ship.shieldCharge = 0.6;
    h.syncLocalShipShield();
    assert.equal(h.writes.length, 2, 'Charge-only changes do not invent extra immediate edge traffic');
    h.requestLocalShipShield('ShiftLeft', false);
    assert.equal(h.writes.length, 3);
    assert.equal(h.writes.at(-1).data.shieldState & 1, 0);
});

test('successful create needs no outbound baseline to count its initial shield state as published', () => {
    const h = harness({ session: true });
    delete h.records.get('local-ship').lastSentData;
    h.syncLocalShipShield();
    assert.equal(h.writes.length, 0);
    h.requestLocalShipShield('ShiftLeft', true);
    assert.equal(h.writes.length, 1, 'A genuine new edge is still sent immediately');
    h.elapse(h.config.SEND_ON_CHANGE_HEARTBEAT_MS);
    h.syncLocalShipShield();
    assert.equal(h.writes.length, 2, 'The optimistic record does not masquerade as a successful create');
});

function drawingContext() {
    const strokes = [];
    const stack = [];
    let path = [];
    const styleKeys = ['strokeStyle', 'lineWidth', 'lineJoin', 'miterLimit', 'shadowBlur', 'shadowColor'];
    return {
        strokes, strokeStyle: '#abc', lineWidth: 3, lineJoin: 'round', miterLimit: 4,
        shadowBlur: 0, shadowColor: '#123',
        save() { stack.push(Object.fromEntries(styleKeys.map(key => [key, this[key]]))); },
        restore() { Object.assign(this, stack.pop()); },
        beginPath() { path = []; },
        moveTo: (...args) => path.push(['move', ...args]),
        lineTo: (...args) => path.push(['line', ...args]),
        arc: (...args) => path.push(['arc', ...args]),
        closePath() { path.push(['close']); },
        stroke() {
            strokes.push({
                path: [...path], shadowBlur: this.shadowBlur, style: this.strokeStyle,
                lineWidth: this.lineWidth, lineJoin: this.lineJoin, miterLimit: this.miterLimit,
            });
        },
    };
}

// Independent stroke oracle: intersect adjacent outward-offset hull edges.
// This includes the actual canvas miter rather than just the unstroked vertices.
function strokedCorners(vertices, halfWidth) {
    const area = vertices.reduce((sum, a, i) => {
        const b = vertices[(i + 1) % vertices.length];
        return sum + a.x * b.y - a.y * b.x;
    }, 0);
    const sign = Math.sign(area);
    return vertices.map((v, i) => {
        const previous = vertices[(i + vertices.length - 1) % vertices.length];
        const next = vertices[(i + 1) % vertices.length];
        const a = { x: v.x - previous.x, y: v.y - previous.y };
        const b = { x: next.x - v.x, y: next.y - v.y };
        const p = {
            x: v.x + sign * a.y / Math.hypot(a.x, a.y) * halfWidth,
            y: v.y - sign * a.x / Math.hypot(a.x, a.y) * halfWidth,
        };
        const q = {
            x: v.x + sign * b.y / Math.hypot(b.x, b.y) * halfWidth,
            y: v.y - sign * b.x / Math.hypot(b.x, b.y) * halfWidth,
        };
        const t = ((q.x - p.x) * b.y - (q.y - p.y) * b.x) / (a.x * b.y - a.y * b.x);
        return { x: p.x + t * a.x, y: p.y + t * a.y };
    });
}

function assertThreeCornerContact(ship, width, height) {
    const center = { x: ship.x * width, y: ship.y * height };
    const innerRadius = ship.getShieldRadius() - ship.constructor.SHIELD_LINE_WIDTH / 2;
    const halfHullStroke = ship.constructor.HULL_LINE_WIDTH / 2;
    const vertices = ship.getVertices();
    for (const [i, vertex] of vertices.entries()) {
        const distance = Math.hypot(vertex.x - center.x, vertex.y - center.y);
        assert.ok(Math.abs(innerRadius - distance - halfHullStroke) < 1e-9,
            `corner ${i}: inner rim must touch the actual rounded outer corner, without clearance`);
        const next = vertices[(i + 1) % vertices.length];
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            for (let direction = 0; direction < 8; direction++) {
                const angle = direction * Math.PI / 4;
                const x = vertex.x + t * (next.x - vertex.x) + Math.cos(angle) * halfHullStroke;
                const y = vertex.y + t * (next.y - vertex.y) + Math.sin(angle) * halfHullStroke;
                assert.ok(Math.hypot(x - center.x, y - center.y) <= innerRadius + 1e-9,
                    'The full rounded stroke remains inside the circle, not just the three contact points');
            }
        }
    }
}

test('ring touches all three rounded outer corners at every size, aspect and rotation', () => {
    const h = harness();
    const ship = h.game.ship;
    ship.setShieldActive(true);
    for (const [width, height] of [[1280, 900], [320, 568], [568, 320], [96, 160]]) {
        Object.assign(h.viewport, { width, height });
        for (const size of [0.008, 0.025, 0.06]) {
            h.config.SHIP_SIZE = size;
            for (const angle of [0, 0.7, 2.3, Math.PI]) {
                Object.assign(ship, { x: 0.4, y: 0.6, angle, thrusting: true });
                const center = { x: ship.x * width, y: ship.y * height };
                assertThreeCornerContact(ship, width, height);
                const radius = ship.getShieldRadius();
                const ctx = drawingContext();
                ship.draw(ctx);
                const arcs = ctx.strokes[0].path.filter(([kind]) => kind === 'arc');
                assert.deepEqual(arcs, [['arc', center.x, center.y, radius, 0, 2 * Math.PI]]);
                const hull = ctx.strokes.find(stroke => stroke.path.some(([kind]) => kind === 'close'));
                assert.equal(hull.lineJoin, 'round', 'The rendered shielded hull uses the tested rounded corners');
                assert.equal(hull.lineWidth, h.Ship.HULL_LINE_WIDTH, 'Stroke width remains fixed CSS pixels');
                assert.equal(ctx.strokes.at(-1).lineJoin, 'miter', 'Exhaust keeps its original join');
                ship.thrusting = false;
                assert.equal(ship.getShieldRadius(), radius, 'Exhaust does not enlarge the circle');
            }
        }
    }
});

test('recentered collision geometry preserves the original silhouette and normalized shape across clients and resizes', () => {
    const referenceShapes = new Map();
    for (const ref of [80, 320, 900, 1600]) {
        const h = harness();
        const ship = h.game.ship;
        Object.assign(h.viewport, { width: ref * 1.6, height: ref });
        for (const size of [0.008, 0.025, 0.06]) {
            h.config.SHIP_SIZE = size;
            for (const angle of [0, 0.7, 2.3]) {
                ship.angle = angle;
                const vertices = ship.getVertices();
                const original = [0, Math.PI * 0.8, -Math.PI * 0.8].map((offset, i) => ({
                    x: ship.x * h.viewport.width + Math.cos(angle + offset) * size * ref * (i ? 0.7 : 1),
                    y: ship.y * h.viewport.height + Math.sin(angle + offset) * size * ref * (i ? 0.7 : 1),
                }));
                const shift = { x: vertices[0].x - original[0].x, y: vertices[0].y - original[0].y };
                for (let i = 0; i < 3; i++) {
                    assert.ok(Math.abs(vertices[i].x - original[i].x - shift.x) < 1e-9);
                    assert.ok(Math.abs(vertices[i].y - original[i].y - shift.y) < 1e-9,
                        'Only a common translation is allowed, never reshaping');
                    const next = (i + 1) % 3;
                    assert.ok(Math.abs(Math.hypot(vertices[i].x - vertices[next].x, vertices[i].y - vertices[next].y)
                        - Math.hypot(original[i].x - original[next].x, original[i].y - original[next].y)) < 1e-9);
                }
                const normalized = vertices.map(v => ({ x: v.x / h.viewport.width, y: v.y / h.viewport.height }));
                const key = `${size}/${angle}`;
                if (!referenceShapes.has(key)) referenceShapes.set(key, normalized);
                for (const [i, vertex] of normalized.entries()) {
                    assert.ok(Math.abs(vertex.x - referenceShapes.get(key)[i].x) < 1e-12);
                    assert.ok(Math.abs(vertex.y - referenceShapes.get(key)[i].y) < 1e-12,
                        'Independent clients cannot derive collision offsets from CSS stroke widths');
                }

                const pose = { x: ship.x, y: ship.y, angle: ship.angle };
                const geometry = h.Ship.getHullGeometry();
                Object.assign(h.viewport, { width: ref * 3.2, height: ref * 2 });
                const resized = ship.getVertices();
                assert.equal(resized, vertices, 'The preallocated world-vertex cache is retained');
                assert.equal(h.Ship.getHullGeometry(), geometry, 'Reference-unit geometry does not depend on viewport pixels');
                for (let i = 0; i < 3; i++) {
                    assert.ok(Math.abs(resized[i].x / h.viewport.width - normalized[i].x) < 1e-12);
                    assert.ok(Math.abs(resized[i].y / h.viewport.height - normalized[i].y) < 1e-12);
                }
                assertThreeCornerContact(ship, h.viewport.width, h.viewport.height);
                assert.deepEqual({ x: ship.x, y: ship.y, angle: ship.angle }, pose);
                Object.assign(h.viewport, { width: ref * 1.6, height: ref });
            }
        }
    }
});

test('size invalidates hull caches, rotation uses the shared pivot, and stroke changes never move collision vertices', () => {
    const h = harness();
    const ship = h.game.ship;
    const center = { x: ship.x * h.viewport.width, y: ship.y * h.viewport.height };
    ship.angle = 0;
    const first = structuredClone(ship.getVertices());
    const geometry = h.Ship.getHullGeometry();
    h.config.SHIP_SIZE *= 2;
    const enlarged = structuredClone(ship.getVertices());
    assert.notEqual(h.Ship.getHullGeometry(), geometry);
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(enlarged[i].x - center.x - 2 * (first[i].x - center.x)) < 1e-9);
        assert.ok(Math.abs(enlarged[i].y - center.y - 2 * (first[i].y - center.y)) < 1e-9);
    }
    ship.angle = Math.PI / 2;
    const rotated = structuredClone(ship.getVertices());
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(rotated[i].x - center.x + enlarged[i].y - center.y) < 1e-9);
        assert.ok(Math.abs(rotated[i].y - center.y - enlarged[i].x + center.x) < 1e-9);
    }
    const radius = ship.getShieldRadius();
    h.Ship.HULL_LINE_WIDTH += 2;
    assert.deepEqual(ship.getVertices(), rotated, 'CSS stroke affects rendering only');
    assert.equal(ship.getShieldRadius(), radius + 1);
    assertThreeCornerContact(ship, h.viewport.width, h.viewport.height);
});

test('inactive and terminal hulls retain sharp miters while shield rounding never leaks to later rendering', () => {
    const h = harness();
    const ship = h.game.ship;
    const center = { x: ship.x * h.viewport.width, y: ship.y * h.viewport.height };
    const vertices = structuredClone(ship.getVertices());
    const miterRadius = Math.max(...strokedCorners(vertices, h.Ship.HULL_LINE_WIDTH / 2)
        .map(v => Math.hypot(v.x - center.x, v.y - center.y)));
    assert.ok(Math.abs(ship.getHullStrokeRadius() - miterRadius) < 1e-9,
        'Inactive wrap culling still includes actual sharp miter tips');
    for (const active of [false, true, false]) {
        ship.setShieldActive(active);
        const ctx = drawingContext();
        ship.draw(ctx);
        const hull = ctx.strokes.find(stroke => stroke.path.some(([kind]) => kind === 'close'));
        assert.equal(hull.lineJoin, active ? 'round' : 'miter');
        assert.equal(hull.lineWidth, h.Ship.HULL_LINE_WIDTH);
        assert.equal(hull.miterLimit, h.Ship.HULL_MITER_LIMIT);
        assert.equal(ctx.lineJoin, 'miter', 'No active-only join leaks to later objects');
        assert.deepEqual(ship.getVertices(), vertices, 'Shield transitions cannot alter collision geometry');
    }
    ship.terminalDecomposition = {
        progress: 1,
        edges: [0, 1, 2].map(() => ({ separation: 0.5, rotation: 0, direction: 0 })),
    };
    ship.shieldState = 3;
    ship.shieldVisualSettled = true;
    const ctx = drawingContext();
    ship.draw(ctx);
    assert.equal(ctx.strokes.length, 1, 'Terminal suppression still prevents a stale circle');
    assert.equal(ctx.strokes[0].lineJoin, 'miter');
    assert.equal(ctx.strokes[0].path.filter(([kind]) => kind === 'move').length, 3);
    assert.deepEqual(ship.getVertices(), vertices, 'Separated terminal edges remain render-only');
});

test('muzzle and thrust flame share the translated hull origin without inheriting ship velocity', () => {
    const h = harness();
    const math = Object.create(Math);
    math.random = () => 0.5;
    const { Ship } = load(['Ship'], { ...h.dependencies, Math: math });
    const ship = new Ship(0.4, 0.6);
    Object.assign(ship, { velocityX: 0.7, velocityY: -0.3, thrusting: true });
    Object.assign(h.viewport, { width: 568, height: 320 });
    for (const angle of [0, 0.7, Math.PI / 2, 2.3]) {
        Object.assign(ship, { angle, shootCooldown: 0 });
        const nose = { ...ship.getVertices()[0] };
        const size = h.fromNormalizedSize(h.config.SHIP_SIZE);
        const hullOrigin = {
            x: nose.x - Math.cos(angle) * size,
            y: nose.y - Math.sin(angle) * size,
        };
        const bullet = ship.shoot();
        assert.ok(Math.abs(bullet.x * h.viewport.width - nose.x) < 1e-9);
        assert.ok(Math.abs(bullet.y * h.viewport.height - nose.y) < 1e-9);
        assert.equal(bullet.velocityX, Math.cos(angle) * h.config.BULLET_SPEED);
        assert.equal(bullet.velocityY, Math.sin(angle) * h.config.BULLET_SPEED);
        const ctx = drawingContext();
        ship.draw(ctx);
        const flame = ctx.strokes.find(stroke => stroke.style === h.config.THRUST_COLOR);
        for (const [i, offset, scale] of [[0, Math.PI * 0.9, 0.4], [1, Math.PI, 1], [2, -Math.PI * 0.9, 0.4]]) {
            assert.ok(Math.abs(flame.path[i][1] - hullOrigin.x - Math.cos(angle + offset) * size * scale) < 1e-9);
            assert.ok(Math.abs(flame.path[i][2] - hullOrigin.y - Math.sin(angle + offset) * size * scale) < 1e-9);
        }
    }
});

test('shield and hull copies retain owner, replica, render and terminal normalized wrap periods', () => {
    const h = collisionHarness();
    const wrap = load([
        'getRemoteBoundingRadius', 'shortestRemoteDelta', 'shortestRemoteDeltaX', 'shortestRemoteDeltaY',
        'wrapRemoteX', 'wrapRemoteY', 'wrapRadiusFor',
    ], { ...h.dependencies, Asteroid: h.Asteroid });
    const ship = h.game.ship;
    ship.setShieldActive(true);
    for (const [width, height] of [[320, 568], [568, 320], [80, 80]]) {
        Object.assign(h.viewport, { width, height });
        const marginX = h.wrapMarginX(h.config.SHIP_SIZE);
        const marginY = h.wrapMarginY(h.config.SHIP_SIZE);
        const data = ship.toSyncData();
        assert.equal(wrap.getRemoteBoundingRadius(data), h.config.SHIP_SIZE);
        assert.equal(wrap.wrapRadiusFor(ship), h.config.SHIP_SIZE);
        for (const [axis, margin, dimension, remote, shortest] of [
            ['x', marginX, width, wrap.wrapRemoteX, wrap.shortestRemoteDeltaX],
            ['y', marginY, height, wrap.wrapRemoteY, wrap.shortestRemoteDeltaY],
        ]) {
            const high = 1 + margin + 0.0001;
            ship.x = 0.5;
            ship.y = 0.5;
            ship[axis] = high;
            ship.update(0);
            assert.equal(ship[axis], remote(high, data), 'Owner and replica wrap at the same normalized seam');
            assert.ok(Math.abs(shortest(1 + margin - 0.0001, ship[axis], data) - 0.0002) < 1e-12);
            ship[axis] = 1 + margin - 0.0001;
            const ctx = drawingContext();
            ship.draw(ctx);
            const arcs = ctx.strokes[0].path.filter(([kind]) => kind === 'arc');
            if (ship.getShieldRadius() + h.Ship.SHIELD_LINE_WIDTH / 2 > margin * dimension) {
                assert.equal(arcs.length, 2, 'The circle straddles the unchanged logical wrap margin');
                assert.ok(Math.abs(Math.abs(arcs[1][axis === 'x' ? 1 : 2] - arcs[0][axis === 'x' ? 1 : 2])
                    - (1 + 2 * margin) * dimension) < 1e-9);
            }
            if (ship.getHullStrokeRadius() > margin * dimension) {
                const hulls = ctx.strokes.filter(stroke => stroke.path.some(([kind]) => kind === 'close'));
                assert.equal(hulls.length, 2, 'Small-view fixed-width strokes also receive visible hull copies');
                for (const hull of hulls) {
                    const points = hull.path.filter(([kind]) => kind === 'move' || kind === 'line');
                    const distances = points.map(point => {
                        const arc = arcs.find(candidate => Math.abs(point[axis === 'x' ? 1 : 2]
                            - candidate[axis === 'x' ? 1 : 2]) < ship.getShieldRadius());
                        assert.ok(arc);
                        return Math.hypot(point[1] - arc[1], point[2] - arc[2]);
                    });
                    for (const distance of distances) {
                        assert.ok(Math.abs(distance - ship.getCollisionRadius()) < 1e-9);
                    }
                }
            }
        }
    }
});

test('collision broad phase and shooter deflection use the recentered centerline bound', () => {
    const h = collisionHarness();
    const ship = h.game.ship;
    const center = { x: ship.x * h.viewport.width, y: ship.y * h.viewport.height };
    const radius = Math.max(...ship.getVertices().map(v => Math.hypot(v.x - center.x, v.y - center.y)));
    assert.ok(Math.abs(ship.getCollisionRadius() - radius) < 1e-9);
    const asteroid = rock(h);
    assert.ok(h.checkShipAsteroidCollision(ship), 'The translated real hull still collides');
    h.config.MIN_ASTEROID_RADIUS = 0.001;
    h.config.DEFLECTION_SCALE = 1;
    h.config.DEFLECTION_TIME_LIMIT = 1;
    const impact = { bulletAngle: 0, offsetN: 0, impactTorque: 0 };
    const expectedChildren = Fracture.calculateAsteroidFragments(asteroid, impact, h.config).children;
    const deflections = [];
    const { splitAsteroid } = load(['splitAsteroid'], {
        ...h.dependencies, Asteroid: h.Asteroid,
        getEffectiveAsteroidAspectScales: () => ({ radiusScale: 1, speedScale: 1 }),
        computeDeflectionImpulse: (...args) => { deflections.push(args); return { dvx: 0, dvy: 0 }; },
    });
    splitAsteroid(asteroid, null, impact, ship);
    assert.ok(deflections.length > 0, 'The production split must reach shooter deflection');
    assert.equal(deflections.length, expectedChildren.length);
    for (let i = 0; i < deflections.length; i++) {
        assert.ok(Math.abs(deflections[i][4] - expectedChildren[i].r - radius / h.getReferenceDimension()) < 1e-12);
    }
});

test('exact-contact assertions reject real-source extra-clearance and old-origin mutations', () => {
    const h = harness();
    const original = h.Ship.toString();
    for (const [description, mutated] of [
        ['extra clearance', original.replace(
            'return this.getCollisionRadius() + (Ship.HULL_LINE_WIDTH + Ship.SHIELD_LINE_WIDTH) / 2;',
            'return this.getCollisionRadius() + (Ship.HULL_LINE_WIDTH + Ship.SHIELD_LINE_WIDTH) / 2 + 1;')],
        ['old origin', original.replace(/const originX = denominator \?[^;]+;/, 'const originX = 0;')],
    ]) {
        assert.notEqual(mutated, original, `${description}: mutate the actual production class`);
        const Mutant = execute(`return (${mutated});`, h.dependencies);
        assert.throws(() => assertThreeCornerContact(new Mutant(0.4, 0.6), 1000, 1000),
            /corner \d: inner rim must touch/, `${description}: the exact-contact contract must turn red`);
    }
});

test('ring survives spawn blinking and restores canvas glow before later hull drawing', () => {
    const h = harness();
    const ship = h.game.ship;
    ship.setShieldActive(true);
    ship.invulnerable = 2 * h.config.INVULN_BLINK_RATE;
    const ctx = drawingContext();
    ship.draw(ctx);
    assert.equal(ctx.strokes.length, 1, 'A hidden hull still draws its active circle');
    assert.equal(ctx.strokes[0].path.filter(([kind]) => kind === 'arc').length, 1);
    assert.ok(ctx.strokes[0].shadowBlur > 0);
    assert.equal(ctx.shadowBlur, 0);
    assert.equal(ctx.shadowColor, '#123');
    ship.invulnerable = 0;
    ship.draw(ctx);
    assert.equal(ctx.strokes.at(-1).shadowBlur, 0, 'Shield glow never leaks into the hull');
    assert.ok(ctx.strokes.at(-1).path.some(([kind]) => kind === 'line'));
});

test('production HUD clamps/proportionally fills charge, labels progress, gates writes, and hides without a ship', () => {
    const h = harness();
    const changes = [];
    const attributes = new Map();
    const shieldHudDisplay = {};
    const shieldFillDisplay = { style: {
        set width(value) { changes.push(['width', value]); },
    } };
    const shieldMeterDisplay = {
        setAttribute: (name, value) => { attributes.set(name, value); changes.push([name, value]); },
    };
    const { updateHUD } = load(['updateHUD'], {
        game: h.game, isSessionMode: () => false, hudCache: {},
        scoreDisplay: {}, waveDisplay: {}, livesDisplay: {}, hudDisplay: null,
        document: { getElementById: () => null },
        shieldHudDisplay, shieldFillDisplay, shieldMeterDisplay,
    });
    h.game.ship.shieldCharge = 0.375;
    updateHUD();
    assert.equal(shieldHudDisplay.hidden, false);
    assert.deepEqual(changes, [['width', '37.5%'], ['aria-valuenow', '38']]);
    updateHUD();
    assert.equal(changes.length, 2, 'Idle frames do not repeat fill or accessibility writes');
    for (const [charge, width, progress] of [[-1, '0%', '0'], [2, '100%', '100'], [NaN, '0%', '0']]) {
        h.game.ship.shieldCharge = charge;
        updateHUD();
        assert.equal(changes.at(-2)[1], width);
        assert.equal(attributes.get('aria-valuenow'), progress);
    }
    h.game.ship = null;
    updateHUD();
    assert.equal(shieldHudDisplay.hidden, true);
    const meter = source.match(/<div id="shield-meter"[^>]*>/)?.[0];
    assert.ok(meter, 'Native Shield progress element exists');
    assert.match(source, /<span id="shield-label">Shield<\/span>/);
    for (const attribute of ['role="progressbar"', 'aria-labelledby="shield-label"',
        'aria-valuemin="0"', 'aria-valuemax="100"']) assert.ok(meter.includes(attribute), attribute);
    assert.doesNotMatch(meter, /aria-live=/, 'Charge ticks are not live announcements');
});
