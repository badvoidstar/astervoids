import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const { countExtraLivesForScore } = require('./wwwroot/js/game-config.js');
const codec = require('./wwwroot/js/astervoids-wire-codec.js');
const GuidUtils = require('./wwwroot/js/guid-utils.js');

const MY_SHIP = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_SHIP = 'bbbbbbbb-0000-0000-0000-000000000002';
const participant = letter => `${letter.repeat(8)}-1111-1111-1111-111111111111`;

// Mirrors the production Ship construction dependencies used elsewhere
// (see ship-invulnerability.test.mjs) so the hold is exercised against the
// real ship rather than a stand-in with hand-written reset semantics.
function harness({ lives = 3, myShipObjectId = MY_SHIP, gameOver = false } = {}) {
    let now = 1000;
    const config = {
        TARGET_FPS: 60, INVULNERABILITY_TIME: 180, INVULN_BLINK_RATE: 10,
        SHIP_TURN_ACCEL_TIME: 0.1, SHIP_TURN_DECEL_TIME: 0.1,
        SHIP_FRICTION: 0.995, SHIP_THRUST: 0.01, SHIP_MAX_SPEED: 4.5,
        SHIP_BRAKE_STRENGTH: 0.01, SHIP_SIZE: 0.02,
        SHIP_SEND_ON_CHANGE_ENABLED: true, SHIP_INPUT_REPLAY_ENABLED: true,
        SHIP_EDGE_SEND_ENABLED: true, INTERPOLATION_ENABLED: true,
        SEND_ON_CHANGE_HEARTBEAT_MS: 250,
        SEND_ON_CHANGE_VEL_EPS: 1e-4, SEND_ON_CHANGE_ROT_EPS: 1e-4,
        EXTRA_LIFE_SCORE_THRESHOLD: 100,
        SHIP_DEATH_HOLD_TIMEOUT_MS: 3000
    };
    const game = {
        lives,
        state: 'playing',
        ship: null,
        multiplayer: {
            myShipObjectId,
            remoteShips: new Map(),
            observedScoreLifeAwardCount: null
        }
    };
    const records = new Map();
    const writes = [];
    const events = [];
    const warnings = [];
    const ObjectSync = {
        updateObject: (id, data, immediate) => writes.push({ id, data, immediate }),
        getObjectByType: type => [...records.values()].find(r => r.type === type) || null,
        getObjectsByType: type => [...records.values()].filter(r => r.type === type)
    };
    const production = loadInlineGameFunctions([
        'Ship', 'ShipInvulnerability', 'assignDefined', 'rampInputToward',
        'calculateGameState', 'handleShipHit', 'predictFatalShipHit',
        'beginShipDeathHold', 'resolveShipDeathHold'
    ], {
        CONFIG: config, game, ObjectSync, GuidUtils, countExtraLivesForScore,
        AstervoidsWireCodec: codec,
        OBJECT_TYPES: { SHIP: 'ship', GAME_STATE: 'gamestate' },
        performance: { now: () => now },
        isSessionMode: () => true,
        isGameOver: () => gameOver,
        isDeterministicMode: () => true,
        emitShipStateChanged: pose => events.push(pose),
        _warn: (...args) => warnings.push(args),
        AudioSystem: {
            playShipExplosion() {},
            thrustSound: { start() {}, stop() {} },
            beat: { stop() {} }
        },
        CollisionEffects: { startShipHit() {} },
        updateHUD() {},
        publishDebugMetrics() {},
        RemoteObjects: { clock: { offsetInitialized: true }, serverNowMs: () => now },
        DeadReckon: { updateState() {}, getReckoned: () => null, remove() {} },
        ShipSendGate: { shouldSend: () => true },
        ShipControlGate: { reset() {} },
        TURN_CONTROL_MODE: { KEYBOARD_RATE: 0 },
        normalizeTurnControlMode: value => value,
        getShipTurnSpeed: () => 0.1,
        velocityToNormalizedDeltaX: velocity => velocity / 60,
        velocityToNormalizedDeltaY: velocity => velocity / 60,
        wrapNormalized: value => ((value % 1) + 1) % 1,
        wrapMarginX: () => 0, wrapMarginY: () => 0,
        SHIP_COLORS: ['white'],
        fromNormalizedX: value => value,
        fromNormalizedY: value => value,
        fromNormalizedSize: value => value
    });

    game.ship = new production.Ship(0.5, 0.5);
    // Put the ship somewhere recognisable and moving, so a coasting wreck is
    // distinguishable from a respawn at centre.
    Object.assign(game.ship, {
        x: 0.25, y: 0.75, angle: 1.25, velocityX: 2, velocityY: -3,
        rotationSpeed: 0.5, thrusting: true, invulnerable: 0
    });

    function setGameState(data) {
        records.set('gs', { id: 'gs-id', type: 'gamestate', data });
    }
    function setShip(id, data) {
        records.set(id, { id, type: 'ship', ownerMemberId: id, data });
    }
    setGameState({
        lives, groupScore: 0, peakShipCount: 1, scoreLifeAwardCount: 0,
        state: 'playing',
        processedHits: codec.packCounterMap({}),
        processedScores: codec.packCounterMap({}),
        countedParticipants: codec.packCounterMap({ [participant('a')]: 1 })
    });
    setShip(MY_SHIP, { hitCount: 0, score: 0, participantId: participant('a') });

    return {
        game, production, writes, events, warnings, records,
        setGameState, setShip,
        setLives(next) { game.lives = next; },
        setGameOver(value) { gameOver = value; },
        advance(ms) { now += ms; },
        pose() {
            const { x, y, angle, velocityX, velocityY } = game.ship;
            return { x, y, angle, velocityX, velocityY };
        }
    };
}

test('a non-fatal session hit still respawns immediately', () => {
    const h = harness({ lives: 3 });
    assert.equal(h.production.handleShipHit(h.game.ship), false,
        'a survivable hit is not terminal, so the crash still counts as a hit on the asteroid');
    assert.equal(h.game.ship.deathHold, null);
    assert.equal(h.game.ship.x, 0.5);
    assert.equal(h.game.ship.y, 0.5);
    assert.ok(h.game.ship.invulnerable > 0, 'respawn grants invulnerability');
    assert.equal(h.events.length, 1, 'the explosion cue is published either way');
    assert.equal(h.writes.at(-1).immediate, true);
});

test('a fatal session hit cuts the controls but keeps the wreck coasting', () => {
    const h = harness({ lives: 1 });
    assert.equal(h.production.handleShipHit(h.game.ship), true,
        'a predicted-fatal hit reports itself terminal to the collision pass');
    assert.deepEqual(h.pose(), {
        x: 0.25, y: 0.75, angle: 1.25, velocityX: 2, velocityY: -3
    }, 'pose and translation survive: the wreck carries its momentum');
    // Spin is the one quantity that must still be cut. Turn ramping is
    // instantaneous at the shipped SHIP_TURN_DECEL_TIME, so a replica would
    // damp a spinning wreck the instant it saw the cleared intent while the
    // owner kept rotating.
    assert.equal(h.game.ship.rotationSpeed, 0);
    assert.equal(h.game.ship.turnTarget, 0);
    assert.equal(h.game.ship.thrusting, false);
    assert.equal(h.game.ship.thrustInput, 0);
    assert.equal(h.game.ship.brakeInput, 0);
    assert.equal(h.game.ship.invulnerable, 0, 'a held wreck never becomes invulnerable');
    assert.equal(h.game.ship.deathHold.hitCount, 1);
    assert.deepEqual(h.events, [{ x: 0.25, y: 0.75, angle: 1.25 }]);
    const write = h.writes.at(-1);
    assert.equal(write.immediate, true, 'the coast baseline must not wait for a cadence slot');
    assert.equal(write.data.x, 0.25);
    assert.equal(write.data.y, 0.75);
    // The instance and the payload must tell the same story. Publishing a
    // velocity the owner is not actually integrating is the unsafe variant:
    // every replica extrapolates motion that never happened.
    assert.equal(write.data.velocityX, 2);
    assert.equal(write.data.velocityY, -3);
});

test('the published packet reproduces the wreck\'s coast exactly', () => {
    // With all control intent cleared, Ship.update degenerates to friction
    // decay, integration, and wrap — so a replica replaying that same update
    // from the owner's published packet tracks the wreck exactly, with no
    // heartbeat needed to correct it.
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    const packet = h.writes.at(-1).data;

    const replica = new h.production.Ship(0, 0);
    replica.fromSyncData(packet);

    for (let frame = 0; frame < 30; frame++) {
        h.game.ship.update(1);
        replica.update(1);
    }

    assert.deepEqual(h.pose(), {
        x: replica.x,
        y: replica.y,
        angle: replica.angle,
        velocityX: replica.velocityX,
        velocityY: replica.velocityY
    });
    assert.notEqual(h.game.ship.x, 0.25, 'the wreck actually moved');
    assert.ok(Math.abs(h.game.ship.velocityX) < 2, 'and friction is bleeding the coast off');
    assert.equal(h.game.ship.angle, 1.25, 'an uncontrolled wreck never starts turning');
    assert.equal(h.game.ship.rotationSpeed, 0);
});

test('the hold is local: it never reaches the wire payloads', () => {
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    assert.ok(h.game.ship.deathHold, 'precondition: the ship is holding');
    assert.ok(!('deathHold' in h.game.ship.toUpdateData()));
    assert.ok(!('deathHold' in h.game.ship.toSyncData()));
});

test('fatality prediction counts another ship\'s unprocessed hit', () => {
    // Shared pool is 2, and a peer has already taken a hit the authority has
    // not processed. Naive `lives <= 1` would respawn into a game that is
    // already over.
    const h = harness({ lives: 2 });
    h.setShip(OTHER_SHIP, {
        hitCount: 1, score: 0, participantId: participant('a')
    });
    h.production.handleShipHit(h.game.ship);
    assert.ok(h.game.ship.deathHold, 'both outstanding hits drive the pool to zero');
    assert.equal(h.game.ship.x, 0.25);
});

test('fatality prediction credits a pending score extra life', () => {
    // Naive `lives <= 1` would hold, but the group score has crossed the
    // threshold, so the authority is about to publish a surviving pool.
    const h = harness({ lives: 1 });
    h.setGameState({
        lives: 1, groupScore: 0, peakShipCount: 1, scoreLifeAwardCount: 0,
        state: 'playing',
        processedHits: codec.packCounterMap({}),
        processedScores: codec.packCounterMap({}),
        countedParticipants: codec.packCounterMap({ [participant('a')]: 1 })
    });
    h.setShip(MY_SHIP, { hitCount: 0, score: 100, participantId: participant('a') });
    h.production.handleShipHit(h.game.ship);
    assert.equal(h.game.ship.deathHold, null, 'the awarded life absorbs this hit');
    assert.equal(h.game.ship.x, 0.5, 'and the ship respawns as usual');
});

test('a ship with no sync object keeps respawning rather than holding', () => {
    // A local fallback ship is invisible to the authority, so its hits can
    // never decrement the shared pool. Holding would strand it forever.
    const h = harness({ lives: 1, myShipObjectId: null });
    h.production.handleShipHit(h.game.ship);
    assert.equal(h.game.ship.deathHold, null);
    assert.equal(h.game.ship.x, 0.5);
    assert.deepEqual(h.writes, [], 'nothing to publish without an object id');
});

test('a malformed ledger falls back instead of losing the death', () => {
    const h = harness({ lives: 1 });
    h.setGameState({
        lives: 1, state: 'playing',
        processedHits: Uint8Array.from([0xff, 0xff, 0xff]),
        processedScores: codec.packCounterMap({}),
        countedParticipants: codec.packCounterMap({})
    });
    h.production.handleShipHit(h.game.ship);
    assert.ok(h.game.ship.deathHold, 'lives <= 1 is the fallback verdict');
    assert.equal(h.warnings.length, 1);
});

test('a hold survives until the authority has processed the fatal hit', () => {
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    const held = h.pose();
    // Lives are still positive on this client: our own damage has not reached
    // the authority yet. Releasing on `lives > 0` alone would defeat the hold
    // on the very next frame.
    h.production.resolveShipDeathHold();
    assert.ok(h.game.ship.deathHold);
    assert.deepEqual(h.pose(), held);
});

test('a hold persists through game over so the wreck reaches the terminal stop', () => {
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    const held = h.pose();
    h.setGameOver(true);
    h.setLives(0);
    h.advance(60_000);
    h.production.resolveShipDeathHold();
    assert.ok(h.game.ship.deathHold, 'terminal holds never expire');
    assert.deepEqual(h.pose(), held, 'and resolving never teleports the wreck');
});

test('a completed respawn never inherits the coast', () => {
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    assert.ok(h.game.ship.deathHold, 'precondition: the ship is holding');
    // Let the wreck coast a while first, so a respawn that merely kept the
    // instance's momentum would be caught.
    for (let frame = 0; frame < 30; frame++) h.game.ship.update(1);
    assert.ok(Math.abs(h.game.ship.velocityX) > 0, 'precondition: still coasting');
    // The authority processed our hit and still has lives left (an extra life
    // landed in the same window).
    h.setGameState({
        lives: 1, groupScore: 0, peakShipCount: 1, scoreLifeAwardCount: 1,
        state: 'playing',
        processedHits: codec.packCounterMap({ [MY_SHIP]: 1 }),
        processedScores: codec.packCounterMap({}),
        countedParticipants: codec.packCounterMap({ [participant('a')]: 1 })
    });
    h.setLives(1);
    h.production.resolveShipDeathHold();
    assert.equal(h.game.ship.deathHold, null);
    assert.equal(h.game.ship.x, 0.5);
    assert.equal(h.game.ship.y, 0.5);
    assert.equal(h.game.ship.velocityX, 0, 'the respawn starts at rest');
    assert.equal(h.game.ship.velocityY, 0);
    assert.ok(h.game.ship.invulnerable > 0);
    const write = h.writes.at(-1);
    assert.equal(write.immediate, true);
    assert.equal(write.data.velocityX, 0, 'and peers are told so immediately');
    assert.equal(write.data.velocityY, 0);
});

test('a hold whose verdict never arrives expires rather than stranding the player', () => {
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    h.advance(2999);
    h.production.resolveShipDeathHold();
    assert.ok(h.game.ship.deathHold, 'still inside the timeout');
    h.advance(1);
    h.production.resolveShipDeathHold();
    assert.equal(h.game.ship.deathHold, null);
    assert.equal(h.game.ship.x, 0.5, 'worst case is exactly today\'s behaviour');
    assert.equal(h.game.ship.velocityX, 0, 'an expired hold respawns at rest too');
    assert.equal(h.game.ship.velocityY, 0);
});

test('respawning always clears the hold', () => {
    const h = harness({ lives: 1 });
    h.production.handleShipHit(h.game.ship);
    assert.ok(h.game.ship.deathHold);
    h.game.ship.reset();
    assert.equal(h.game.ship.deathHold, null);
});
