import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const { createRuntime } = require(
    './wwwroot/js/replication-runtime.js');

const GAME_STATE = 'gameState';

function makeEntryHarness({ role, gameStateOwner, gameStateData }) {
    const game = {
        lives: 0,
        wave: 0,
        score: 0,
        state: 'lobby',
        speedMultiplier: 1,
        waveDelayTimer: 0,
        ship: null,
        astervoids: [],
        bullets: [],
        multiplayer: {
            isAuthority: false,
            gameStateObjectId: 'gs',
            myShipObjectId: null,
            remoteShips: new Map()
        }
    };
    const record = gameStateData
        ? { id: 'gs', type: GAME_STATE, ownerMemberId: gameStateOwner, version: 9, data: gameStateData }
        : null;
    const calls = [];
    const globals = {
        CONFIG: { MULTIPLAYER_LIVES: 3, INVULNERABILITY_TIME: 3, STARTING_LIVES: 3 },
        OBJECT_TYPES: { GAME_STATE, SHIP: 'ship', ASTEROID: 'asteroid', BULLET: 'bullet' },
        game,
        isSessionMode: () => true,
        adoptSoloSim: () => {},
        SessionClient: { getCurrentMember: () => ({ id: 'me', role }) },
        ObjectSync: {
            getObjectByType: type => (type === GAME_STATE ? record : null),
            getObjectsByType: () => [],
            getObject: () => undefined
        },
        resolveTerminalSession: () => null,
        getNextColorIndex: () => 0,
        createSyncedShip: async () => { game.ship = { colorIndex: 0 }; },
        Ship: class { constructor() { this.colorIndex = 0; } },
        isAuthority: () => game.multiplayer.isAuthority,
        isGameStateOwner: () => record?.ownerMemberId === 'me',
        applyGameStateData: () => calls.push('applyGameStateData'),
        publishOwnedTerminalTargets: () => {},
        isDeterministicMode: () => false,
        hasPersistedTerminalTarget: () => true,
        deterministicTerminalState: {
            pendingBootstrapIds: new Set(),
            bootstrapEpoch: null
        },
        // Models the production no-op: reconciliation re-applies GameState only
        // on a new version, and spectating already consumed the current one.
        updateGameStateFromSync: () => calls.push('updateGameStateFromSync'),
        updateRemoteShips: () => {},
        updateAstervoidsFromSync: () => {},
        updateBulletsFromSync: () => {},
        startScreen: { classList: { add() {}, remove() {} } },
        AudioSystem: {
            init() {}, resume() {},
            beat: { start() {}, stop() {} },
            thrustSound: { stop() {} }
        },
        isGameOver: () => false,
        spawnWave: async () => true,
        createSyncedGameState: async () => {},
        updateHUD: () => {},
        publishDebugMetrics: () => {},
        _warn: () => {}
    };
    // Load the real helper alongside init so the entry path under test is
    // production code end to end, not a stub.
    const { init } = loadInlineGameFunctions(['adoptSharedLives', 'init'], globals);
    return { game, init, calls };
}

test('entering an in-progress game adopts the shared lives, not the local default', async () => {
    // Shared pool grew past the default: base 3 + one participant + one score award.
    const harness = makeEntryHarness({
        role: 'Client',
        gameStateOwner: 'other',
        gameStateData: { lives: 5, wave: 2, state: 'playing', groupScore: 12000 }
    });

    assert.equal(await harness.init(), true);
    assert.equal(harness.game.lives, 5);
});

test('entering below the default adopts the shared lives too', async () => {
    const harness = makeEntryHarness({
        role: 'Client',
        gameStateOwner: 'other',
        gameStateData: { lives: 1, wave: 4, state: 'playing' }
    });

    assert.equal(await harness.init(), true);
    assert.equal(harness.game.lives, 1);
});

test('the GameState owner and a plain client adopt the same lives on entry', async () => {
    const data = { lives: 4, wave: 2, state: 'playing' };
    const owner = makeEntryHarness({
        role: 'Client', gameStateOwner: 'me', gameStateData: { ...data }
    });
    const client = makeEntryHarness({
        role: 'Client', gameStateOwner: 'other', gameStateData: { ...data }
    });

    await owner.init();
    await client.init();
    assert.equal(owner.game.lives, 4);
    assert.equal(client.game.lives, 4);
    assert.equal(owner.game.lives, client.game.lives);
});

test('a session with no GameState yet still starts from the local default', async () => {
    const harness = makeEntryHarness({
        role: 'Server', gameStateOwner: null, gameStateData: null
    });

    assert.equal(await harness.init(), true);
    assert.equal(harness.game.lives, 3);
});

test('reconciliation does not re-apply GameState after spectating consumed its version', () => {
    const records = new Map();
    const game = { lives: 0, multiplayer: { gameStateObjectId: null } };
    const store = {
        getObjectsByTypeSnapshot: type =>
            [...records.values()].filter(record => record.type === type),
        getObjectsByType: type =>
            [...records.values()].filter(record => record.type === type),
        getObject: id => records.get(id),
        getAllObjects: () => records.values()
    };
    const runtime = createRuntime({
        objectStore: store,
        getCurrentMemberId: () => 'me',
        getActiveMemberIds: () => ['me', 'owner'],
        monotonicNowMs: () => 0,
        descriptors: [{
            type: GAME_STATE,
            classify: record => (record.ownerMemberId === 'me' ? 'owned' : 'replica'),
            getInstance: id => (game.multiplayer.gameStateObjectId === id ? id : undefined),
            getInstances: () => (game.multiplayer.gameStateObjectId != null
                ? [[game.multiplayer.gameStateObjectId, game.multiplayer.gameStateObjectId]]
                : []),
            createReplica(record) {
                game.multiplayer.gameStateObjectId = record.id;
                return record.id;
            },
            adoptOwned(record) {
                game.multiplayer.gameStateObjectId = record.id;
                return record.id;
            },
            apply(instance, data) { game.lives = data.lives; },
            remove() { game.multiplayer.gameStateObjectId = null; }
        }]
    });
    records.set('gs', {
        id: 'gs', type: GAME_STATE, ownerMemberId: 'owner', version: 9,
        data: { lives: 5, state: 'playing' }
    });
    const context = () => ({ instanceType: GAME_STATE, renderTime: 0, now: 0 });

    assert.equal(runtime.reconcileType(GAME_STATE, context()).applied, 1);
    assert.equal(game.lives, 5);

    // Entry-path reset followed by updateGameStateFromSync(): the version is
    // unchanged, so nothing is re-applied and the reset value would survive.
    game.lives = 3;
    assert.equal(runtime.reconcileType(GAME_STATE, context()).applied, 0);
    assert.equal(game.lives, 3);
});
