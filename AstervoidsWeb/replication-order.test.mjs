import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        'syncLocalAstervoids()',
        'updateAstervoidsFromSync()',
        'syncLocalBullets()',
        'updateBulletsFromSync()',
        'checkCollisions()'
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
        'syncLocalAstervoids()',
        'updateAstervoidsFromSync()',
        'syncLocalBullets()',
        'updateBulletsFromSync()',
        'checkCollisions()',
        'updateRemoteShips()'
    ], 'hidden-tab step');
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
