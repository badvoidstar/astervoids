import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

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
    // Above the default (base 3 plus a participant and a score award) and below
    // it (the group has been losing) are both adopted verbatim.
    for (const lives of [5, 1]) {
        const harness = makeEntryHarness({
            role: 'Client',
            gameStateOwner: 'other',
            gameStateData: { lives, wave: 2, state: 'playing', groupScore: 12000 }
        });

        assert.equal(await harness.init(), true);
        assert.equal(harness.game.lives, lives);
    }
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
