import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const productionSource = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');

function between(startMarker, endMarker) {
    const start = productionSource.indexOf(startMarker);
    const end = productionSource.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `found start marker: ${startMarker}`);
    assert.ok(end > start, `found end marker after start: ${endMarker}`);
    return productionSource.slice(start, end);
}

function lastBetween(startMarker, endMarker) {
    const start = productionSource.lastIndexOf(startMarker);
    const end = productionSource.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `found final start marker: ${startMarker}`);
    assert.ok(end > start, `found end marker after final start: ${endMarker}`);
    return productionSource.slice(start, end);
}

function assertOrdered(source, markers, contract) {
    let cursor = -1;
    for (const marker of markers) {
        const next = source.indexOf(marker, cursor + 1);
        assert.ok(next > cursor, `${contract}: ${marker} follows the previous phase`);
        cursor = next;
    }
}

test('main loop pumps ObjectSync before simulation and keeps receive paths at collision-visible pivots', () => {
    const gameLoop = between('function gameLoop(timestamp)', 'function runSimulationStep(dt, frozenForReconnect)');
    assertOrdered(gameLoop, [
        'ObjectSync.tick(elapsed / 1000)',
        'runSimulationStep(1.0, frozenForReconnect)',
        'renderScene(fixedStep.alpha)'
    ], 'main frame');

    const simulation = between(
        'function runSimulationStep(dt, frozenForReconnect)',
        'function renderScene(alpha)');
    assertOrdered(simulation, [
        'game.ship.update(dt)',
        'syncLocalShip()',
        'updateRemoteShips()',
        'updateOwnedAsteroids(dt, myMemberId)',
        'syncLocalAstervoids()',
        'updateAstervoidsFromSync()',
        'updateLocalBullet(bullet, dt, myMemberId)',
        'syncLocalBullets()',
        'updateBulletsFromSync()',
        'checkCollisions()',
        'advanceWaveProgression(dt,',
        'AudioSystem.playNewWave()',
        'updateGameStateFromSync()'
    ], 'simulation step');
});

test('hidden-tab fallback preserves tick, ownership simulation, receive, then collision order', () => {
    const hiddenLoop = lastBetween(
        "document.addEventListener('visibilitychange', () => {",
        '// ── Region service bootstrap');
    assertOrdered(hiddenLoop, [
        'ObjectSync.tick(elapsed / 1000)',
        'game.ship.update(dt)',
        'syncLocalShip()',
        'updateOwnedAsteroids(dt, bgMemberId)',
        'syncLocalAstervoids()',
        'updateAstervoidsFromSync()',
        'updateLocalBullet(bullet, dt, bgMemberId)',
        'syncLocalBullets()',
        'updateBulletsFromSync()',
        'checkCollisions()',
        'advanceWaveProgression(dt,',
        'updateRemoteShips()'
    ], 'hidden-tab step');
});

test('shared ownership simulation only advances local and owned asteroids', () => {
    const updates = [];
    const asteroids = [null, 'owned', 'remote', 'missing'].map(syncObjectId => ({
        syncObjectId,
        update: dt => updates.push([syncObjectId, dt]),
    }));
    const { updateOwnedAsteroids } = loadInlineGameFunctions(['updateOwnedAsteroids'], {
        game: { astervoids: asteroids },
        ObjectSync: {
            getObject: id => id === 'missing' ? null : { ownerMemberId: id === 'owned' ? 'me' : 'other' },
        },
    });
    updateOwnedAsteroids(2.5, 'me');
    assert.deepEqual(updates, [[null, 2.5], ['owned', 2.5]]);
});

test('shared bullet operation preserves owner-driven expiration and pending local creates', () => {
    const events = [];
    let sessionMode = true;
    const { updateLocalBullet } = loadInlineGameFunctions(['updateLocalBullet'], {
        isSessionMode: () => sessionMode,
        deleteSyncedBullet: bullet => events.push(['delete', bullet.syncObjectId]),
    });
    const bullet = {
        syncObjectId: 'b', ownerMemberId: 'other',
        update: dt => events.push(['update', dt]),
        isExpired: () => { events.push(['expire']); return true; },
    };
    assert.equal(updateLocalBullet(bullet, 3, 'me'), true);
    assert.deepEqual(events, [], 'remote bullets are neither stepped nor expired');
    bullet.ownerMemberId = 'me';
    assert.equal(updateLocalBullet(bullet, 3, 'me'), false);
    assert.deepEqual(events, [['update', 3], ['expire'], ['delete', 'b']]);
    events.length = 0;
    bullet.syncObjectId = null;
    assert.equal(updateLocalBullet(bullet, 1, 'me'), false);
    assert.deepEqual(events, [['update', 1], ['expire']]);
    events.length = 0;
    sessionMode = false;
    bullet.ownerMemberId = 'other';
    bullet.syncObjectId = 'b';
    assert.equal(updateLocalBullet(bullet, 0.5, 'me'), false);
    assert.deepEqual(events, [['update', 0.5], ['expire']]);
});

test('visible and hidden bullet traversal retain their distinct deletion order', () => {
    const simulation = between(
        'function runSimulationStep(dt, frozenForReconnect)',
        'function renderScene(alpha)');
    const hidden = lastBetween(
        "document.addEventListener('visibilitychange', () => {",
        '// ── Region service bootstrap');
    assert.match(simulation,
        /for \(let i = game\.bullets\.length - 1; i >= 0; i--\)[\s\S]*?updateLocalBullet\(bullet, dt, myMemberId\)[\s\S]*?game\.bullets\.splice\(i, 1\)/);
    assert.match(hidden,
        /game\.bullets = game\.bullets\.filter\(\s*bullet => updateLocalBullet\(bullet, dt, bgMemberId\)\)/);
    assert.doesNotMatch(hidden, /AudioSystem\.playNewWave/);
});

test('wave transition counts the current step and publishes after asynchronous spawn', async () => {
    const events = [];
    let completeSpawn;
    const game = { astervoids: [], state: 'playing', waveDelayTimer: 0 };
    const { advanceWaveProgression } = loadInlineGameFunctions(['advanceWaveProgression'], {
        game,
        CONFIG: { WAVE_DELAY: 3 },
        spawningWave: false,
        isSessionMode: () => true,
        isGameStateOwner: () => true,
        syncGameState: () => events.push(['sync', game.state, game.waveDelayTimer]),
        spawnWave: () => {
            events.push(['spawn']);
            return new Promise(resolve => { completeSpawn = resolve; });
        },
    });
    const publish = () => events.push(['complete', game.state]);
    assert.equal(advanceWaveProgression(1, publish), false);
    assert.equal(game.waveDelayTimer, 2);
    assert.deepEqual(events, [['sync', 'waveDelay', 3]]);
    assert.equal(advanceWaveProgression(2, publish), true);
    assert.equal(game.state, 'playing');
    assert.deepEqual(events, [['sync', 'waveDelay', 3], ['spawn']]);
    assert.equal(advanceWaveProgression(1, publish), false, 'pending spawn cannot restart the delay');
    completeSpawn();
    await Promise.resolve();
    assert.deepEqual(events.at(-1), ['complete', 'playing']);
});

test('non-owner wave countdown transitions locally without starting or publishing waves', () => {
    const game = { astervoids: [], state: 'playing', waveDelayTimer: 1 };
    const { advanceWaveProgression } = loadInlineGameFunctions(['advanceWaveProgression'], {
        game, CONFIG: { WAVE_DELAY: 3 }, spawningWave: false,
        isSessionMode: () => true,
        isGameStateOwner: () => false,
        syncGameState: () => assert.fail('non-owner publication'),
        spawnWave: () => assert.fail('non-owner spawn'),
    });
    assert.equal(advanceWaveProgression(1, () => assert.fail('non-owner completion')), false);
    assert.equal(game.state, 'playing');
    game.state = 'waveDelay';
    assert.equal(advanceWaveProgression(1, () => assert.fail('non-owner completion')), true);
    assert.equal(game.state, 'playing');
});

test('ship control edges remain explicit immediate ObjectSync updates', () => {
    const shipSync = between('function syncLocalShip()', 'function updateRemoteShips()');
    assertOrdered(shipSync, [
        'ShipControlGate.isEdge(game.ship)',
        'ShipSendGate.shouldSend(game.multiplayer.myShipObjectId, game.ship, immediate)',
        'ObjectSync.updateObject('
    ], 'ship send');
    assert.match(shipSync, /ObjectSync\.updateObject\([\s\S]*?,\s*immediate\);/);
});

test('GameState lifecycle reconciles for owners as well as replicas', () => {
    const simulation = between(
        'function runSimulationStep(dt, frozenForReconnect)',
        'function renderScene(alpha)');
    assert.match(
        simulation,
        /if \(isSessionMode\(\)\) \{\s*if \(isGameStateOwner\(\)\) \{\s*syncGameState\(\);\s*\}\s*updateGameStateFromSync\(\);\s*\}/);

    const hiddenLoop = lastBetween(
        "document.addEventListener('visibilitychange', () => {",
        '// ── Region service bootstrap');
    assert.match(
        hiddenLoop,
        /updateRemoteShips\(\);\s*if \(isGameStateOwner\(\)\) syncGameState\(\);\s*updateGameStateFromSync\(\);/);
});
