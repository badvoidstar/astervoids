import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

test('production authority gate freezes hidden/inactive members without pausing visible peers', () => {
    const document = { hidden: false };
    const member = { simulationActive: true };
    const session = { simulationSuspended: false };
    const { canAdvanceLocalSimulation } = loadInlineGameFunctions(['canAdvanceLocalSimulation'], {
        document, isSessionMode: () => true,
        SessionClient: { getCurrentMember: () => member, getCurrentSession: () => session }
    });
    assert.equal(canAdvanceLocalSimulation(), true);
    document.hidden = true;
    assert.equal(canAdvanceLocalSimulation(), false);
    document.hidden = false;
    member.simulationActive = false;
    assert.equal(canAdvanceLocalSimulation(), false);
    member.simulationActive = true;
    session.simulationSuspended = true;
    assert.equal(canAdvanceLocalSimulation(), false);
});

test('production hidden safeguards clear controls and stale collision/elapsed history', () => {
    let resetControls = 0, resetStick = 0, stopped = 0;
    const ship = {
        x: 2, y: 3, angle: 1, _collisionPrevX: -100,
        resetControls() { resetControls++; }
    };
    const game = { lastFrameTime: 99, astervoids: [], bullets: [], ship };
    const fixedStep = { accumulatorMs: 250 };
    const simulationTiming = { stepPerf: 1, stepServerMs: 1, dtMs: 200, lastPresentationPerf: 10 };
    const keys = { Space: true, ArrowUp: true };
    const { neutralizeHiddenControls, resetAuthorityTiming } = loadInlineGameFunctions(
        ['neutralizeHiddenControls', 'resetAuthorityTiming', 'resetEntityHistory', 'finishSimulationStep'],
        {
            game, fixedStep, simulationTiming, keys,
            resetStickInput() { resetStick++; },
            AudioSystem: { thrustSound: { stop() { stopped++; } } }
        });
    neutralizeHiddenControls();
    resetAuthorityTiming();
    assert.deepEqual(Object.values(keys), [false, false]);
    assert.equal(resetControls, 1);
    assert.equal(resetStick, 1);
    assert.equal(stopped, 1);
    assert.equal(game.lastFrameTime, 0);
    assert.equal(fixedStep.accumulatorMs, 0);
    assert.equal(simulationTiming.dtMs, 0);
    assert.equal(ship._collisionPrevX, ship.x);
    assert.equal(ship._collisionPrevSampleAt, null);
});

test('hidden fallback preserves reconciliation order without advancing gameplay', () => {
    const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');
    const start = source.indexOf('backgroundInterval = setInterval');
    const body = source.slice(start, source.indexOf('}, 1000);', start));
    assert.ok(start > 0);
    const normal = body.slice(body.indexOf('return;'));
    assert.ok(normal.indexOf('updateAstervoidsFromSync()') < normal.indexOf('updateBulletsFromSync()'));
    assert.ok(normal.indexOf('updateBulletsFromSync()') < normal.indexOf('updateRemoteShips()'));
    assert.doesNotMatch(body, /updateOwnedAsteroids\(|checkCollisions\(|game\.ship\.update\(|updateLocalBullet\(/);
    const visibility = source.slice(source.indexOf("document.addEventListener('visibilitychange'", source.indexOf('let backgroundInterval')));
    assert.ok(visibility.indexOf('setSimulationActive(!document.hidden)') < visibility.indexOf('setInterval'));
});
