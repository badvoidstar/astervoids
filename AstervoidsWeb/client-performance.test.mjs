import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

function renderHarness() {
    const game = { ship: null, astervoids: [], bullets: [], cosmeticAstervoids: [], state: 'playing' };
    const state = { deterministic: true, session: false };
    const pool = [];
    const buffers = new Set();
    const arrays = new Set();
    const allocations = { buffers: 0, arrays: 0 };
    pool.push = scratch => {
        if (!buffers.has(scratch)) {
            buffers.add(scratch);
            allocations.buffers++;
        }
        if (!arrays.has(scratch.values)) {
            arrays.add(scratch.values);
            allocations.arrays++;
        }
        return Array.prototype.push.call(pool, scratch);
    };
    const deadReckoned = new Map();
    const terminal = new Map();
    const production = loadInlineGameFunctions([
        'withLocalRenderInterpolation', 'poseLocalRenderable', 'rememberRenderedPose',
        'interpNormalized', 'interpAngle',
    ], {
        game, localRenderScratchPool: pool,
        isDeterministicMode: () => state.deterministic,
        isSessionMode: () => state.session,
        DeadReckon: { states: deadReckoned },
        deterministicTerminalState: { transitions: terminal },
        wrapRadiusFor: o => o.boundRadius ?? 0.02,
        wrapMarginX: radius => radius * 0.5,
        wrapMarginY: radius => radius,
    });
    return { ...production, game, state, pool, buffers, arrays, allocations, deadReckoned, terminal };
}

function entity(overrides = {}) {
    return { x: 0.6, y: 0.8, angle: 0.4, _prevX: 0.2, _prevY: 0.4, _prevAngle: 0.2, ...overrides };
}

function pose(o) {
    return { x: o.x, y: o.y, angle: o.angle };
}

function assertReleased(h) {
    for (const scratch of h.buffers) {
        assert.equal(scratch.count, 0);
        for (let i = 0; i < scratch.values.length; i += 4) {
            assert.equal(scratch.values[i], null, 'scratch must not retain deleted/replaced entities');
        }
    }
}

test('production render scratch allocates once for 600 frames of 200 entities', () => {
    const h = renderHarness();
    h.game.astervoids = Array.from({ length: 200 }, () => entity());
    const originals = h.game.astervoids.map(pose);
    let draws = 0;
    for (let frame = 0; frame < 600; frame++) {
        h.withLocalRenderInterpolation(0.5, () => { draws++; });
    }
    assert.equal(draws, 600);
    assert.deepEqual(h.allocations, { buffers: 1, arrays: 1 });
    assert.equal(h.pool.length, 1);
    assert.equal(h.pool[0].values.length, 800, 'flat pose storage replaces 120000 tuple allocations');
    assert.deepEqual(h.game.astervoids.map(pose), originals);
    assertReleased(h);
});

test('production render scratch wraps by each margin and restores interpolated poses', () => {
    const h = renderHarness();
    const ship = entity({ _prevX: 1.009, x: -0.009, _prevY: -0.019, y: 1.019,
        _prevAngle: Math.PI - 0.1, angle: -Math.PI + 0.1 });
    h.game.ship = ship;
    const original = pose(ship);
    h.withLocalRenderInterpolation(0.5, () => {
        assert.ok(Math.abs(ship.x - 1.01) < 1e-12);
        assert.ok(Math.abs(ship.y + 0.02) < 1e-12);
        assert.ok(Math.abs(ship.angle - Math.PI) < 1e-12);
        assert.equal(ship._lastRenderedX, ship.x);
        assert.equal(ship._lastRenderedY, ship.y);
        assert.equal(ship._lastRenderedAngle, ship.angle);
    });
    assert.deepEqual(pose(ship), original);
    assert.ok(Math.abs(ship._lastRenderedX - 1.01) < 1e-12);
    assertReleased(h);
});

test('render selection keeps remotes, terminal trajectories and unsnapshotted entities unblended', () => {
    const h = renderHarness();
    const local = entity();
    const remote = entity({ syncObjectId: 'remote' });
    const terminal = entity({ syncObjectId: 'terminal' });
    const fresh = entity({ _prevX: undefined, _prevY: undefined });
    const bullet = entity({ angle: undefined, _prevAngle: undefined });
    h.game.astervoids.push(local, remote, terminal, fresh);
    h.game.bullets.push(bullet);
    h.deadReckoned.set('remote', {});
    h.terminal.set('terminal', {});
    h.withLocalRenderInterpolation(0.5, () => {
        assert.equal(local.x, 0.4);
        assert.equal(bullet.x, 0.4);
        assert.equal(bullet.angle, undefined);
        for (const o of [remote, terminal, fresh]) {
            assert.equal(o.x, 0.6);
            assert.equal(o._lastRenderedX, o.x);
        }
    });
    assert.equal(h.pool[0].values.length, 8, 'only local snapshotted objects need restoration');
    assertReleased(h);
});

test('buffered and completed-alpha rendering remembers poses without saving transforms', () => {
    for (const [deterministic, alpha] of [[false, 0.5], [true, 1], [true, 2]]) {
        const h = renderHarness();
        h.state.deterministic = deterministic;
        const ship = h.game.ship = entity();
        h.withLocalRenderInterpolation(alpha, () => {
            assert.equal(ship.x, 0.6);
            assert.equal(ship._lastRenderedX, 0.6);
        });
        assert.equal(h.pool[0].values.length, 0);
    }
});

test('cosmetic render interpolation is limited to the solo start screen', () => {
    for (const [session, gameState, selected] of [
        [false, 'start', true], [true, 'start', false], [false, 'playing', false],
    ]) {
        const h = renderHarness();
        h.state.session = session;
        h.game.state = gameState;
        const cosmetic = entity();
        h.game.cosmeticAstervoids.push(cosmetic);
        h.withLocalRenderInterpolation(0.5, () => {
            assert.equal(cosmetic.x, selected ? 0.4 : 0.6);
        });
        assert.equal(cosmetic.x, 0.6);
        assert.equal(cosmetic._lastRenderedX, selected ? 0.4 : undefined);
    }
});

test('render exceptions and deletions restore original entities and clear scratch references', () => {
    const h = renderHarness();
    const oldShip = h.game.ship = entity();
    const asteroid = entity();
    h.game.astervoids.push(asteroid);
    const original = pose(oldShip);
    const failure = new Error('draw failed');
    assert.throws(() => h.withLocalRenderInterpolation(0.5, () => {
        h.game.ship = entity({ x: 0.7 });
        h.game.astervoids.length = 0;
        throw failure;
    }), error => error === failure);
    assert.deepEqual(pose(oldShip), original);
    assert.deepEqual(pose(asteroid), original);
    assert.equal(h.game.ship.x, 0.7);
    assertReleased(h);
    h.withLocalRenderInterpolation(0.5, () => {});
    assert.deepEqual(h.allocations, { buffers: 1, arrays: 1 });
    assertReleased(h);
});

test('preparation exceptions restore every pose already changed', () => {
    const h = renderHarness();
    const ship = h.game.ship = entity();
    const asteroid = entity({ syncObjectId: 'remote' });
    h.game.astervoids.push(asteroid);
    const failure = new Error('sampling failed');
    h.deadReckoned.has = () => { throw failure; };
    assert.throws(() => h.withLocalRenderInterpolation(0.5, () => {
        assert.fail('draw must not start after failed preparation');
    }), error => error === failure);
    assert.equal(ship.x, 0.6);
    assert.equal(asteroid.x, 0.6);
    assertReleased(h);
});

test('nested and throwing render calls borrow separate scratch and unwind each pose', () => {
    const h = renderHarness();
    const ship = h.game.ship = entity();
    const failure = new Error('nested draw failed');
    h.withLocalRenderInterpolation(0.5, () => {
        const outerPose = pose(ship);
        assert.equal(ship.x, 0.4);
        assert.throws(() => h.withLocalRenderInterpolation(0.5, () => {
            assert.ok(Math.abs(ship.x - 0.3) < 1e-12);
            throw failure;
        }), error => error === failure);
        assert.deepEqual(pose(ship), outerPose);
    });
    assert.equal(ship.x, 0.6);
    assert.equal(h.pool.length, 2);
    assert.deepEqual(h.allocations, { buffers: 2, arrays: 2 });
    assertReleased(h);
});

test('render scratch retained capacity is bounded across deep nesting and large scenes', () => {
    const h = renderHarness();
    h.game.ship = entity();
    function nested(depth) {
        h.withLocalRenderInterpolation(0.5, () => { if (depth) nested(depth - 1); });
    }
    nested(8);
    assert.equal(h.game.ship.x, 0.6);
    assert.equal(h.pool.length, 4);
    assertReleased(h);
    h.game.astervoids = Array.from({ length: 1024 }, () => entity());
    h.withLocalRenderInterpolation(0.5, () => {});
    assert.equal(h.pool.length, 3, 'oversized scratch is not returned to the retained pool');
    assert.ok(h.pool.every(scratch => scratch.values.length <= 4096));
    assert.ok(h.game.astervoids.every(o => o.x === 0.6));
    assertReleased(h);
    h.game.astervoids.length = 0;
    h.withLocalRenderInterpolation(0.5, () => {});
    assertReleased(h);
});
