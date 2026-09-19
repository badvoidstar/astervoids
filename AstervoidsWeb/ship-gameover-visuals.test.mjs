import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AstervoidsFracture = require('./wwwroot/js/asteroid-fracture.js');

const here = dirname(fileURLToPath(import.meta.url));
const productionSource = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');

// Game over holds the final frame. Input handling stops there with `thrusting`
// latched at its last value and the local ship's countdown frozen wherever it
// happened to be, so without an explicit settle a wreck can keep a lit thrust
// flame forever or stay stuck on a hidden blink frame — invisible for good.
function harness({ gameOver = true } = {}) {
    const config = {
        TARGET_FPS: 60, INVULNERABILITY_TIME: 180, INVULN_BLINK_RATE: 10,
        SHIP_TURN_ACCEL_TIME: 0.1, SHIP_TURN_DECEL_TIME: 0.1,
        SHIP_SIZE: 0.02, STROKE_COLOR: '#fff', THRUST_COLOR: '#f80',
        SHIP_TERMINAL_SEPARATION: 0.35, SHIP_TERMINAL_ROTATION: 2,
        DEADRECKON_GAMEOVER_TERMINAL_DELAY_MS: 750
    };
    const game = {
        ship: null,
        multiplayer: { myShipObjectId: 'local', remoteShips: new Map() }
    };
    const state = { gameOver, sessionMode: true, data: null, now: 1000 };
    const production = loadInlineGameFunctions(
        ['Ship', 'ShipInvulnerability', 'assignDefined', 'settleShipTerminalVisuals',
            'resolveTerminalSession', 'createTerminalShipDecomposition',
            'terminalShipDecompositionProgress'],
        {
            CONFIG: config,
            game,
            AstervoidsFracture,
            OBJECT_TYPES: { GAME_STATE: 'gameState' },
            ObjectSync: { getObjectByType: () => ({ data: state.data }) },
            isSessionMode: () => state.sessionMode,
            isGameOver: () => state.gameOver,
            performance: { now: () => 1000 },
            replicationClock: { validAtToMonotonicMs: at => at },
            RemoteObjects: { clock: { offsetInitialized: true }, serverNowMs: () => state.now },
            TURN_CONTROL_MODE: { KEYBOARD_RATE: 0, ANALOG_TARGET: 1 },
            normalizeTurnControlMode: value => value || 0,
            SHIP_COLORS: ['#0ff'],
            getReferenceDimension: () => 1000,
            fromNormalizedX: value => value * 1000,
            fromNormalizedY: value => value * 1000,
            fromNormalizedSize: value => value * 1000
        });

    function addShip(id, { thrusting = false, invulnerable = 0 } = {}) {
        const ship = new production.Ship(0.5, 0.5, 0);
        ship.thrusting = thrusting;
        ship.thrustInput = thrusting ? 1 : 0;
        ship.invulnerable = invulnerable;
        if (id === null) game.ship = ship;
        else game.multiplayer.remoteShips.set(id, ship);
        return ship;
    }

    return { ...production, config, game, state, addShip };
}

// Records every stroked path with the colour in effect, so the assertions
// describe what a member actually sees rather than an internal flag.
function recordingContext() {
    const strokes = [];
    let current = [];
    return {
        strokeStyle: null,
        lineWidth: 1,
        strokes,
        beginPath() { current = []; },
        moveTo(x, y) { current.push([x, y]); },
        lineTo(x, y) { current.push([x, y]); },
        closePath() {},
        stroke() { strokes.push({ style: this.strokeStyle, points: current }); }
    };
}

function render(ship, config) {
    const ctx = recordingContext();
    ship.draw(ctx);
    return {
        flames: ctx.strokes.filter(stroke => stroke.style === config.THRUST_COLOR).length,
        hulls: ctx.strokes.filter(stroke => stroke.style !== config.THRUST_COLOR).length
    };
}

// A hidden blink frame: invulnerable > 0 with an even blink bucket.
const HIDDEN_BLINK = 5;
const VISIBLE_BLINK = 15;

test('blink phases behave as expected before the settle', () => {
    const h = harness({ gameOver: false });
    const hidden = h.addShip(null, { invulnerable: HIDDEN_BLINK });
    assert.equal(render(hidden, h.config).hulls, 0, 'hidden half draws nothing');
    hidden.invulnerable = VISIBLE_BLINK;
    assert.equal(render(hidden, h.config).hulls, 1, 'visible half draws the hull');
});

test('game over stops the local ship thrust flame', () => {
    const h = harness();
    const ship = h.addShip(null, { thrusting: true });
    assert.equal(render(ship, h.config).flames, 1, 'flame is lit before the settle');
    h.settleShipTerminalVisuals();
    assert.equal(ship.thrusting, false);
    assert.equal(ship.thrustInput, 0);
    assert.equal(render(ship, h.config).flames, 0, 'no flame after game over');
});

test('game over stops remote ship thrust flames', () => {
    const h = harness();
    const a = h.addShip('remote-a', { thrusting: true });
    const b = h.addShip('remote-b', { thrusting: true });
    h.settleShipTerminalVisuals();
    assert.equal(render(a, h.config).flames, 0);
    assert.equal(render(b, h.config).flames, 0);
});

test('game over ends invulnerability blinking on the visible frame', () => {
    const h = harness();
    const local = h.addShip(null, { invulnerable: HIDDEN_BLINK });
    const remote = h.addShip('remote', { invulnerable: HIDDEN_BLINK });
    assert.equal(render(local, h.config).hulls, 0, 'frozen mid-blink before the settle');
    h.settleShipTerminalVisuals();
    assert.equal(local.invulnerable, 0);
    assert.equal(remote.invulnerable, 0);
    assert.equal(render(local, h.config).hulls, 1, 'local wreck stays visible');
    assert.equal(render(remote, h.config).hulls, 1, 'remote wreck stays visible');
});

test('the settle is not a wire transition', () => {
    const h = harness();
    const ship = h.addShip(null, { invulnerable: HIDDEN_BLINK });
    const revision = ship.invulnerabilityRevision;
    h.settleShipTerminalVisuals();
    assert.equal(ship.invulnerabilityRevision, revision,
        'send gates key on the revision; a local settle must not fake a transition');
});

test('a settled replica ignores stale invulnerability samples', () => {
    const h = harness();
    const ship = h.addShip('remote');
    // An anchor captured while the countdown was running would otherwise keep
    // re-deriving a blinking `invulnerable` on every later sample.
    ship.ingestInvulnerability(
        { invulnerable: 120, invulnerabilityRevision: 3, invulnerableAt: 1000 },
        { validAt: 1000 });
    h.settleShipTerminalVisuals();
    ship.sampleInvulnerability(1000, 0);
    assert.equal(ship.invulnerable, 0);
    assert.equal(render(ship, h.config).hulls, 1);
});

test('the settle survives the rest passes re-applying authoritative data', () => {
    const h = harness();
    const ship = h.addShip('remote');
    h.settleShipTerminalVisuals();
    // Both game-over rest passes push the owner's last accepted snapshot back
    // into the replica every frame, so the settle has to hold per frame.
    for (let frame = 0; frame < 3; frame++) {
        ship.fromSyncData({
            x: 0.5, y: 0.5, angle: 0, thrusting: true, thrustInput: 1,
            invulnerable: HIDDEN_BLINK, invulnerabilityRevision: 7
        });
        h.settleShipTerminalVisuals();
        const drawn = render(ship, h.config);
        assert.equal(drawn.flames, 0, `frame ${frame}: no flame`);
        assert.equal(drawn.hulls, 1, `frame ${frame}: ship visible`);
    }
});

test('the settle leaves live gameplay alone', () => {
    const h = harness({ gameOver: false });
    const ship = h.addShip(null, { thrusting: true, invulnerable: HIDDEN_BLINK });
    h.settleShipTerminalVisuals();
    assert.equal(ship.thrusting, true, 'thrust flame keeps rendering while playing');
    assert.equal(ship.invulnerable, HIDDEN_BLINK, 'respawn blinking keeps running');
});

test('spectators without a ship settle without error', () => {
    const h = harness();
    const remote = h.addShip('remote', { thrusting: true });
    assert.equal(h.game.ship, null);
    h.settleShipTerminalVisuals();
    assert.equal(render(remote, h.config).flames, 0);
});

test('renderScene settles after the rest passes and before drawing ships', () => {
    const start = productionSource.indexOf('function renderScene(alpha) {');
    assert.ok(start > 0, 'renderScene must exist');
    const body = productionSource.slice(start, productionSource.indexOf(
        'function updateGameplayOverlays', start));
    const rest = body.indexOf('repositionBufferedRemotesAtRest();');
    const settle = body.indexOf('settleShipTerminalVisuals();');
    const draw = body.indexOf('drawRemoteShips(ctx);');
    assert.ok(rest > 0 && settle > 0 && draw > 0, 'all three passes must run in renderScene');
    assert.ok(settle > rest,
        'the rest passes re-apply ship data, so the settle must follow them');
    assert.ok(settle < draw, 'the settle must precede the ship draw calls');
});

function setTerminal(h, shipId = 'local') {
    h.state.data = { lives: 0, gameOverAt: 1000, terminalAt: 1750, terminalShipId: shipId };
}

function hullPoints(ship) {
    const ctx = recordingContext();
    ship.draw(ctx);
    return ctx.strokes[0].points;
}

test('only the canonical final-life ship decomposes, for local and remote observers', () => {
    const owner = harness(), observer = harness();
    setTerminal(owner);
    setTerminal(observer);
    const local = owner.addShip(null);
    const remote = observer.addShip('local');
    const survivor = observer.addShip(null);
    observer.game.multiplayer.myShipObjectId = 'survivor';
    survivor.deathHold = { hitCount: 1 };
    owner.state.now = observer.state.now = 1375;
    owner.settleShipTerminalVisuals();
    observer.settleShipTerminalVisuals();
    assert.equal(survivor.terminalDecomposition, null, 'prediction must not choose the wreck');
    assert.deepEqual(hullPoints(local), hullPoints(remote));
    assert.equal(hullPoints(local).length, 6, 'three detached open segments');
    assert.equal(hullPoints(survivor).length, 3, 'other ships retain the closed hull');
});

test('decomposition is a bounded deterministic impulse that eases to exact rest', () => {
    const h = harness();
    const terminal = { epoch: 1000, terminalAt: 1750 };
    const progress = now => h.terminalShipDecompositionProgress(terminal, now);
    assert.equal(progress(999), 0);
    assert.equal(progress(1000), 0);
    assert.equal(progress(1750), 1);
    assert.equal(progress(10000), 1);
    let previous = 0, previousStep = Infinity;
    for (let now = 1010; now <= 1750; now += 10) {
        const next = progress(now);
        assert.ok(next >= previous);
        assert.ok(next - previous <= previousStep + 1e-12, 'impulse must decelerate');
        previousStep = next - previous;
        previous = next;
    }
    assert.ok(1 - progress(1749.99) < 1e-12, 'near-zero final velocity');
    const edges = h.createTerminalShipDecomposition('ABC', 1000).edges;
    assert.deepEqual(edges, h.createTerminalShipDecomposition('abc', 1000).edges);
    assert.notDeepEqual(edges, h.createTerminalShipDecomposition('other', 1000).edges);
    assert.notDeepEqual(edges, h.createTerminalShipDecomposition('abc', 2000).edges);
    for (const edge of edges) {
        assert.ok(edge.separation >= 0.5 && edge.separation <= 1);
        assert.ok(Math.abs(edge.rotation) <= 1);
        assert.ok(Math.abs(edge.direction) <= Math.PI / 8);
    }
    assert.equal(h.terminalShipDecompositionProgress({ epoch: 1000, terminalAt: 1000 }, 1000), 1);
});

test('late joins and skipped frames sample the same settled wreck without replaying it', () => {
    const a = harness(), b = harness();
    setTerminal(a, 'wreck');
    setTerminal(b, 'wreck');
    const shipA = a.addShip('wreck');
    for (a.state.now = 1000; a.state.now < 1750; a.state.now += 17) a.settleShipTerminalVisuals();
    const shipB = b.addShip('wreck');
    a.state.now = 1750;
    b.state.now = 9000;
    a.settleShipTerminalVisuals();
    b.settleShipTerminalVisuals();
    assert.deepEqual(hullPoints(shipA), hullPoints(shipB));
    assert.equal(shipB.terminalDecomposition.progress, 1);
    const points = hullPoints(shipB);
    b.state.now += 5000;
    b.settleShipTerminalVisuals();
    assert.deepEqual(hullPoints(shipB), points);
});

test('detached segments follow a moving rotating origin without mutating pose or collision geometry', () => {
    const h = harness();
    setTerminal(h);
    const ship = h.addShip(null);
    ship.angle = 0;
    ship.velocityX = 0.2;
    h.state.now = 1750;
    h.settleShipTerminalVisuals();
    const vertices = structuredClone(ship.getVertices());
    const first = hullPoints(ship);
    assert.deepEqual(ship.getVertices(), vertices);
    assert.equal(ship.velocityX, 0.2);
    ship.x = 0.7;
    ship.y = 0.3;
    ship.angle = Math.PI / 2;
    const moved = hullPoints(ship);
    for (let i = 0; i < first.length; i++) {
        assert.ok(Math.abs(moved[i][0] - (700 - (first[i][1] - 500))) < 1e-9);
        assert.ok(Math.abs(moved[i][1] - (300 + (first[i][0] - 500))) < 1e-9);
    }
});

test('zero tuning reproduces the original triangle and rotation and separation tune independently', () => {
    const h = harness();
    setTerminal(h);
    const ship = h.addShip(null);
    const original = structuredClone(ship.getVertices());
    h.state.now = 1750;
    h.settleShipTerminalVisuals();
    for (const [separation, rotation] of [[0, 0], [0.3, 0], [0, 0.2]]) {
        h.config.SHIP_TERMINAL_SEPARATION = separation;
        h.config.SHIP_TERMINAL_ROTATION = rotation;
        const points = hullPoints(ship);
        for (let i = 0; i < 3; i++) {
            const a = original[i], b = original[(i + 1) % 3];
            const p = points[i * 2], q = points[i * 2 + 1];
            const shift = Math.hypot((p[0] + q[0] - a.x - b.x) / 2,
                (p[1] + q[1] - a.y - b.y) / 2);
            assert.ok(shift <= separation * 20 + 1e-9);
            if (separation > 0) assert.ok(shift > 0);
            if (rotation === 0) {
                assert.ok(Math.abs((q[0] - p[0]) - (b.x - a.x)) < 1e-9);
                assert.ok(Math.abs((q[1] - p[1]) - (b.y - a.y)) < 1e-9);
            }
            assert.ok(Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1])
                - Math.hypot(b.x - a.x, b.y - a.y)) < 1e-9, 'edges stay rigid');
        }
    }
});

test('rest snapshots preserve decomposition while reset, new games and solo mode clear it', () => {
    const h = harness();
    setTerminal(h);
    const ship = h.addShip(null);
    h.state.now = 1375;
    h.settleShipTerminalVisuals();
    const initial = hullPoints(ship);
    ship.fromSyncData({ x: 0.5, y: 0.5, thrusting: true, invulnerable: HIDDEN_BLINK });
    h.settleShipTerminalVisuals();
    assert.deepEqual(hullPoints(ship), initial);
    ship.reset();
    assert.equal(ship.terminalDecomposition, null);
    h.settleShipTerminalVisuals();
    h.state.gameOver = false;
    h.settleShipTerminalVisuals();
    assert.equal(ship.terminalDecomposition, null);
    h.state.gameOver = true;
    h.state.sessionMode = false;
    h.settleShipTerminalVisuals();
    assert.equal(ship.terminalDecomposition, null);
});

test('missing terminal identity leaves older sessions intact and late identity delivery is sampled', () => {
    const h = harness();
    setTerminal(h);
    const ship = h.addShip(null);
    delete h.state.data.terminalShipId;
    h.state.now = 1500;
    h.settleShipTerminalVisuals();
    assert.equal(ship.terminalDecomposition, null);
    h.state.data.terminalShipId = 'local';
    h.settleShipTerminalVisuals();
    assert.ok(ship.terminalDecomposition.progress > 0);
    const oldEdges = ship.terminalDecomposition.edges;
    h.state.data.gameOverAt = 2000;
    h.state.data.terminalAt = 2750;
    h.state.now = 2000;
    h.settleShipTerminalVisuals();
    assert.equal(ship.terminalDecomposition.progress, 0);
    assert.notDeepEqual(ship.terminalDecomposition.edges, oldEdges);
});
