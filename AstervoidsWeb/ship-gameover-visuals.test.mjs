import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

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
        SHIP_SIZE: 0.02, STROKE_COLOR: '#fff', THRUST_COLOR: '#f80'
    };
    const game = {
        ship: null,
        multiplayer: { myShipObjectId: 'local', remoteShips: new Map() }
    };
    const state = { gameOver };
    const production = loadInlineGameFunctions(
        ['Ship', 'ShipInvulnerability', 'assignDefined', 'settleShipTerminalVisuals'],
        {
            CONFIG: config,
            game,
            isGameOver: () => state.gameOver,
            performance: { now: () => 1000 },
            replicationClock: { validAtToMonotonicMs: at => at },
            RemoteObjects: { clock: { offsetInitialized: true }, serverNowMs: () => 1000 },
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
