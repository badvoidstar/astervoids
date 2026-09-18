import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const productionSource = readFileSync(
    resolve(here, 'wwwroot', 'index.html'), 'utf8');
const {
    createMinimumJerkTransition,
    createWrappedConvergenceTransition,
    sampleMinimumJerkTransition,
    unwrapConvergenceTarget,
} = require('./wwwroot/js/replication-presentation.js');
const {
    SCHEMAS,
    selectSchemaId,
} = require('./wwwroot/js/game-wire-schemas.js');

function approx(actual, expected, tolerance = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('minimum-jerk transition preserves start pose and velocity', () => {
    const transition = createMinimumJerkTransition({
        start: 0.2,
        target: 0.8,
        startVelocity: 0.001,
        startTime: 1000,
        endTime: 1600,
    });

    const start = sampleMinimumJerkTransition(transition, 1000);
    assert.equal(start.value, 0.2);
    approx(start.velocity, 0.001);
    approx(start.acceleration, 0);
    assert.equal(start.done, false);
});

test('minimum-jerk transition reaches the exact target at rest', () => {
    const transition = createMinimumJerkTransition({
        start: -0.1,
        target: 1.25,
        startVelocity: 0.002,
        startTime: 25,
        endTime: 775,
    });

    const end = sampleMinimumJerkTransition(transition, 775);
    assert.equal(end.value, 1.25);
    assert.equal(end.velocity, 0);
    assert.equal(end.acceleration, 0);
    assert.equal(end.done, true);
});

test('minimum-jerk transition preserves a nonzero terminal derivative', () => {
    const transition = createMinimumJerkTransition({
        start: 0.1,
        target: 0.6,
        startVelocity: 0.001,
        targetVelocity: -0.0005,
        startAcceleration: 0.00002,
        targetAcceleration: -0.00001,
        startTime: 10,
        endTime: 210,
    });
    const end = sampleMinimumJerkTransition(transition, 210);
    assert.equal(end.value, 0.6);
    assert.equal(end.velocity, -0.0005);
    assert.equal(end.acceleration, -0.00001);
});

test('minimum-jerk retargeting preserves C2 continuity', () => {
    const first = createMinimumJerkTransition({
        start: 0.2,
        target: 0.8,
        startVelocity: 0.0015,
        startAcceleration: 0,
        startTime: 0,
        endTime: 120,
    });
    const handoff = sampleMinimumJerkTransition(first, 45);
    const second = createMinimumJerkTransition({
        start: handoff.value,
        target: 1.1,
        startVelocity: handoff.velocity,
        startAcceleration: handoff.acceleration,
        startTime: 45,
        endTime: 160,
    });
    const start = sampleMinimumJerkTransition(second, 45);
    approx(start.value, handoff.value);
    approx(start.velocity, handoff.velocity);
    approx(start.acceleration, handoff.acceleration);
});

test('half-ballistic terminal target decelerates without speeding up', () => {
    const startTime = 0;
    const endTime = 750;
    const velocity = 0.001;
    const transition = createMinimumJerkTransition({
        start: 0.1,
        target: 0.1 + velocity * (endTime - startTime) / 2,
        startVelocity: velocity,
        startTime,
        endTime,
    });

    let previous = sampleMinimumJerkTransition(transition, startTime);
    for (let now = 5; now <= endTime; now += 5) {
        const current = sampleMinimumJerkTransition(transition, now);
        assert.ok(current.value >= previous.value - 1e-12);
        assert.ok(current.velocity >= -1e-12);
        assert.ok(
            current.velocity <= previous.velocity + 1e-12,
            `velocity increased at ${now}ms: ${previous.velocity} -> ${current.velocity}`);
        previous = current;
    }
});

test('target unwrapping continues forward across a toroidal seam', () => {
    const target = unwrapConvergenceTarget({
        start: 0.95,
        target: 0.15,
        span: 1,
        velocity: 0.001,
        duration: 500,
    });
    assert.equal(target, 1.15);
});

test('target unwrapping adds a wrap when needed to prevent reversal', () => {
    const target = unwrapConvergenceTarget({
        start: 0.4,
        target: 0.45,
        span: 1,
        velocity: 0.002,
        duration: 500,
    });
    approx(target, 1.45);
});

test('stationary target unwrapping chooses the shortest equivalent', () => {
    const target = unwrapConvergenceTarget({
        start: 0.9,
        target: 0.1,
        span: 1,
        velocity: 0,
        duration: 500,
    });
    approx(target, 1.1);
});

test('late positional convergence relaxes derivatives instead of adding a full lap', () => {
    const axis = createWrappedConvergenceTransition({
        start: 1.04,
        target: 1.04,
        span: 1.1,
        startVelocity: 0.00025,
        startTime: 0,
        endTime: 300,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, true);
    approx(axis.target, 1.04);
    for (let now = 0; now <= 300; now += 5) {
        approx(sampleMinimumJerkTransition(axis.transition, now).value, 1.04);
    }
});

test('late angular convergence relaxes derivatives instead of adding a full turn', () => {
    const angle = 1.25;
    const axis = createWrappedConvergenceTransition({
        start: angle,
        target: angle,
        span: Math.PI * 2,
        startVelocity: 0.002,
        startAcceleration: 0.00001,
        startTime: 0,
        endTime: 300,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, true);
    approx(axis.target, angle);
    const start = sampleMinimumJerkTransition(axis.transition, 0);
    assert.equal(start.velocity, 0);
    assert.equal(start.acceleration, 0);
    approx(sampleMinimumJerkTransition(axis.transition, 300).value, angle);
});

test('on-time convergence relaxes derivatives instead of adding a full lap', () => {
    const axis = createWrappedConvergenceTransition({
        start: 1.04,
        target: 1.04,
        span: 1.1,
        startVelocity: 0.00025,
        startTime: 0,
        endTime: 300,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, true);
    approx(axis.target, 1.04);
    assert.equal(sampleMinimumJerkTransition(axis.transition, 0).velocity, 0);
});

test('shortest convergence clamps aligned velocity instead of stopping', () => {
    const axis = createWrappedConvergenceTransition({
        start: 0.4,
        target: 0.45,
        span: 1,
        startVelocity: 0.002,
        startAcceleration: 0.000001,
        startTime: 0,
        endTime: 500,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, true);
    approx(axis.target, 0.45);
    const start = sampleMinimumJerkTransition(axis.transition, 0);
    approx(start.velocity, 0.00025);
    assert.equal(start.acceleration, 0);
    let previous = start;
    for (let now = 5; now <= 500; now += 5) {
        const current = sampleMinimumJerkTransition(axis.transition, now);
        assert.ok(current.value >= previous.value - 1e-12);
        assert.ok(current.velocity <= previous.velocity + 1e-12);
        previous = current;
    }
});

test('shortest seam crossing preserves derivatives without an extra winding', () => {
    const axis = createWrappedConvergenceTransition({
        start: 0.95,
        target: 0.15,
        span: 1,
        startVelocity: 0.0003,
        startAcceleration: 0.000001,
        startTime: 0,
        endTime: 300,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, false);
    approx(axis.target, 1.15);
    const start = sampleMinimumJerkTransition(axis.transition, 0);
    approx(start.velocity, 0.0003);
    approx(start.acceleration, 0.000001);
});

test('a momentum-justified winding keeps a fast spin turning forward', () => {
    // A fractured asteroid at the spin cap projects its terminal angle more
    // than half a turn ahead, so the nearest congruent target lies BEHIND it.
    // Converging on that target would run the spin backwards into its rest
    // pose; the winding the incoming speed can cover must survive.
    const stepMs = 1000 / 60;
    const duration = 750;
    const spinPerFrame = 0.2;
    const angularVelocity = spinPerFrame / stepMs;
    const forwardTravel = spinPerFrame * (duration / stepMs) / 2;
    let nearestTarget = forwardTravel % (Math.PI * 2);
    if (nearestTarget > Math.PI) nearestTarget -= Math.PI * 2;
    assert.ok(nearestTarget < 0);

    const axis = createWrappedConvergenceTransition({
        start: 0,
        target: nearestTarget,
        span: Math.PI * 2,
        startVelocity: angularVelocity,
        startTime: 0,
        endTime: duration,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, false);
    approx(axis.target, forwardTravel);
    let previous = sampleMinimumJerkTransition(axis.transition, 0);
    approx(previous.velocity, angularVelocity);
    for (let now = 5; now <= duration; now += 5) {
        const current = sampleMinimumJerkTransition(axis.transition, now);
        assert.ok(
            current.value >= previous.value - 1e-12,
            `rotation reversed at ${now}ms: ${previous.value} -> ${current.value}`);
        previous = current;
    }
    approx(previous.value, forwardTravel);
});

test('a winding beyond ballistic reach still relaxes to the nearest target', () => {
    // A slow spin that has already drifted past its target must not buy a whole
    // extra turn to keep rotating forward; the short correction wins.
    const axis = createWrappedConvergenceTransition({
        start: 1.25,
        target: 1.2,
        span: Math.PI * 2,
        startVelocity: 0.02 / (1000 / 60),
        startAcceleration: 0.00001,
        startTime: 0,
        endTime: 750,
        relaxExtraWinding: true
    });

    assert.equal(axis.relaxed, true);
    approx(axis.target, 1.2);
    const start = sampleMinimumJerkTransition(axis.transition, 0);
    assert.equal(start.velocity, 0);
    assert.equal(start.acceleration, 0);
});

test('early canonical handoff preserves provisional position and derivatives', () => {
    const target = 0.475;
    const provisional = createMinimumJerkTransition({
        start: 0.1,
        target,
        startVelocity: 0.001,
        startTime: 0,
        endTime: 750
    });
    const current = sampleMinimumJerkTransition(provisional, 100);
    const canonical = createWrappedConvergenceTransition({
        start: current.value,
        target,
        span: 1.1,
        startVelocity: current.velocity,
        startAcceleration: current.acceleration,
        startTime: 100,
        endTime: 750,
        relaxExtraWinding: true
    });

    assert.equal(canonical.relaxed, false);
    const handoff = sampleMinimumJerkTransition(canonical.transition, 100);
    approx(handoff.value, current.value);
    approx(handoff.velocity, current.velocity);
    approx(handoff.acceleration, current.acceleration);
    approx(sampleMinimumJerkTransition(canonical.transition, 750).value, target);
});

test('production relaxes winding axes regardless of the late threshold', () => {
    const current = {
        x: 1.04,
        y: 0.2,
        angle: 1.25,
        velocityX: 0.00025,
        velocityY: 0.0001,
        angularVelocity: 0.002,
        accelerationX: 0.000002,
        accelerationY: 0.000001,
        angularAcceleration: 0.00001
    };
    const { createCanonicalTerminalTransition: create } = loadInlineGameFunctions(
        ['createCanonicalTerminalTransition'],
        {
            deterministicTerminalState: { directTargetIds: new Set() },
            sampleTerminalTransition: () => current,
            lastRenderedPose: () => current,
            velocityToNormalizedDeltaX: value => value,
            velocityToNormalizedDeltaY: value => value,
            CONFIG: {
                TARGET_FPS: 1000,
                DEADRECKON_GAMEOVER_MIN_CONVERGENCE_MS: 180,
                DEADRECKON_GAMEOVER_LATE_SETTLE_MS: 300
            },
            wrapRadiusFor: () => 0.05,
            wrapMarginX: () => 0.05,
            wrapMarginY: () => 0.05,
            ReplicationPresentation: { createWrappedConvergenceTransition }
        });
    const record = {
        id: 'asteroid',
        data: {
            terminalX: 1.04,
            terminalY: 0.5,
            terminalAngle: 1.25
        }
    };
    const now = 1000;

    const late = create(
        {}, record, { epoch: 1, terminalAt: now + 179 }, now, {});
    const onTime = create(
        {}, record, { epoch: 1, terminalAt: now + 180 }, now, {});

    const lateX = sampleMinimumJerkTransition(late.xTransition, now);
    const lateY = sampleMinimumJerkTransition(late.yTransition, now);
    const lateAngle = sampleMinimumJerkTransition(late.angleTransition, now);
    assert.equal(late.xTransition.target, 1.04);
    assert.equal(lateX.velocity, 0);
    assert.equal(lateX.acceleration, 0);
    approx(lateY.velocity, current.velocityY);
    approx(lateY.acceleration, current.accelerationY);
    assert.equal(late.angleTransition.target, 1.25);
    assert.equal(lateAngle.velocity, 0);
    assert.equal(lateAngle.acceleration, 0);

    approx(onTime.xTransition.target, 1.04);
    assert.equal(
        sampleMinimumJerkTransition(onTime.xTransition, now).velocity, 0);
    approx(onTime.angleTransition.target, 1.25);
    assert.equal(
        sampleMinimumJerkTransition(onTime.angleTransition, now).velocity, 0);
    approx(
        sampleMinimumJerkTransition(onTime.yTransition, now).velocity,
        current.velocityY);
});

test('production canonical convergence never reverses a fast spin', () => {
    // Angles persist normalized, so a spin projected more than half a turn
    // ahead comes back as a target that reads as "behind" the object. The
    // canonical transition must keep rotating in the spin's own direction.
    const angularVelocity = 0.012;
    const duration = 750;
    const forwardTravel = angularVelocity * duration / 2;
    let terminalAngle = forwardTravel % (Math.PI * 2);
    if (terminalAngle > Math.PI) terminalAngle -= Math.PI * 2;
    assert.ok(terminalAngle < 0);
    const current = {
        x: 0.5,
        y: 0.5,
        angle: 0,
        velocityX: 0,
        velocityY: 0,
        angularVelocity,
        accelerationX: 0,
        accelerationY: 0,
        angularAcceleration: 0
    };
    const { createCanonicalTerminalTransition: create } = loadInlineGameFunctions(
        ['createCanonicalTerminalTransition'],
        {
            deterministicTerminalState: { directTargetIds: new Set() },
            sampleTerminalTransition: () => current,
            lastRenderedPose: () => current,
            velocityToNormalizedDeltaX: value => value,
            velocityToNormalizedDeltaY: value => value,
            CONFIG: {
                TARGET_FPS: 1000,
                DEADRECKON_GAMEOVER_MIN_CONVERGENCE_MS: 180,
                DEADRECKON_GAMEOVER_LATE_SETTLE_MS: 300
            },
            wrapRadiusFor: () => 0.05,
            wrapMarginX: () => 0.05,
            wrapMarginY: () => 0.05,
            ReplicationPresentation: { createWrappedConvergenceTransition }
        });
    const now = 1000;
    const entry = create(
        {},
        { id: 'asteroid', data: { terminalX: 0.5, terminalY: 0.5, terminalAngle } },
        { epoch: 1, terminalAt: now + duration },
        now,
        {});

    let previous = sampleMinimumJerkTransition(entry.angleTransition, now);
    approx(previous.velocity, angularVelocity);
    for (let at = now + 5; at <= now + duration; at += 5) {
        const sample = sampleMinimumJerkTransition(entry.angleTransition, at);
        assert.ok(
            sample.value >= previous.value - 1e-12,
            `rotation reversed at ${at - now}ms: ${previous.value} -> ${sample.value}`);
        previous = sample;
    }
    approx(previous.value, forwardTravel);
    approx(
        (previous.value - terminalAngle) / (Math.PI * 2),
        Math.round((previous.value - terminalAngle) / (Math.PI * 2)));
});

test('production provisional convergence uses half-ballistic stopping distance', () => {
    const { createProvisionalTerminalTransition: create } = loadInlineGameFunctions(
        ['createProvisionalTerminalTransition'],
        {
            lastRenderedPose: obj => ({ x: obj.x, y: obj.y, angle: obj.angle }),
            velocityToNormalizedDeltaX: value => value,
            velocityToNormalizedDeltaY: value => value,
            CONFIG: {
                TARGET_FPS: 1000,
                DEADRECKON_GAMEOVER_MIN_CONVERGENCE_MS: 180,
                DEADRECKON_GAMEOVER_LATE_SETTLE_MS: 300
            },
            ReplicationPresentation: {
                createMinimumJerkTransition
            }
        });
    const entry = create({
        x: 0.1,
        y: 0.2,
        angle: 0.3,
        velocityX: 0.001,
        velocityY: -0.002,
        rotationSpeed: 0.003
    }, { epoch: 1, terminalAt: 500 }, 0);

    approx(entry.xTransition.target, 0.35);
    approx(entry.yTransition.target, -0.3);
    approx(entry.angleTransition.target, 1.05);
});

test('different displayed poses converge continuously to one exact terminal pose', () => {
    const make = (start, velocity) => createMinimumJerkTransition({
        start,
        target: 0.75,
        startVelocity: velocity,
        startTime: 1000,
        endTime: 1750,
    });
    const a = make(0.22, 0.0008);
    const b = make(0.17, 0.0008);

    assert.equal(sampleMinimumJerkTransition(a, 1000).value, 0.22);
    assert.equal(sampleMinimumJerkTransition(b, 1000).value, 0.17);
    assert.equal(sampleMinimumJerkTransition(a, 1750).value, 0.75);
    assert.equal(sampleMinimumJerkTransition(b, 1750).value, 0.75);
    assert.equal(sampleMinimumJerkTransition(a, 1750).velocity, 0);
    assert.equal(sampleMinimumJerkTransition(b, 1750).velocity, 0);
});

test('production starts first convergence from the last rendered pose', () => {
    assert.match(
        productionSource,
        /const displayed = lastRenderedPose\(obj\);[\s\S]*start: displayed\.x/);
    assert.match(
        productionSource,
        /rememberRenderedPose\(o\);[\s\S]*drawFn\(\)/);
    assert.match(
        productionSource,
        /rememberRenderedPose\(ship\);[\s\S]*ship\.draw\(ctx\)/);
});

test('production terminal bootstrap applies GameState before ship creation', () => {
    const initStart = productionSource.indexOf('async function init(');
    const initEnd = productionSource.indexOf('\n    /**\n     * Start game from start screen', initStart);
    const source = productionSource.slice(initStart, initEnd);
    const gameStateLookup = source.indexOf(
        'const existingGsObj = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE)');
    const shipCreate = source.indexOf('await createSyncedShip(colorIndex)');
    assert.ok(gameStateLookup >= 0 && shipCreate > gameStateLookup);
    assert.match(source, /if \(!terminalSession\) \{[\s\S]*await createSyncedShip/);
    assert.match(source, /else if \(terminalSession\) \{[\s\S]*applyGameStateData\(existingGsObj\.data\)/);
});

test('hidden tabs continue terminal reconciliation without gameplay simulation', () => {
    assert.match(
        productionSource,
        /document\.hidden && isSessionMode\(\)[\s\S]*\|\| isGameOver\(\)/);
    assert.match(
        productionSource,
        /if \(isGameOver\(\)\) \{[\s\S]*publishOwnedTerminalTargets\(\);[\s\S]*return;/);
});

test('production terminal snapshots bypass live join-age projection', () => {
    assert.match(
        productionSource,
        /if \(resolveTerminalSession\(\)\) return undefined;[\s\S]*presentationNow = RemoteObjects\.serverNowMs/);
});

test('terminal bootstrap deferral is deterministic-only and includes late records', () => {
    const state = {
        pendingBootstrapIds: new Set(['snapshot-object']),
        bootstrapEpoch: 123,
    };
    const factory = (
        deterministicTerminalState,
        isDeterministicMode,
        resolveTerminalSession,
        hasPersistedTerminalTarget) => loadInlineGameFunctions(
        ['shouldDeferTerminalBootstrap'],
        {
            deterministicTerminalState,
            isDeterministicMode,
            resolveTerminalSession,
            hasPersistedTerminalTarget
        }).shouldDeferTerminalBootstrap;
    const legacy = factory(state, () => false, () => ({ epoch: 123 }), () => false);
    assert.equal(legacy({ id: 'snapshot-object' }), false);

    const deterministic = factory(
        state,
        () => true,
        () => ({ epoch: 123 }),
        record => record.data?.terminalEpoch === 123);
    assert.equal(deterministic({ id: 'late-create', data: {} }), true);
    assert.equal(state.pendingBootstrapIds.has('late-create'), true);
    assert.equal(deterministic({
        id: 'late-create',
        data: { terminalEpoch: 123 }
    }), false);
    assert.equal(state.pendingBootstrapIds.has('late-create'), false);
});

test('production canonical retargeting carries sampled acceleration', () => {
    assert.match(
        productionSource,
        /createWrappedConvergenceTransition\(\{[\s\S]*startAcceleration: current\.accelerationX/);
    assert.match(
        productionSource,
        /createWrappedConvergenceTransition\(\{[\s\S]*startAcceleration: current\.accelerationY/);
    assert.match(
        productionSource,
        /startAcceleration: current\.angularAcceleration/);
    assert.equal(
        (productionSource.match(/relaxExtraWinding: true/g) || []).length,
        3,
        'shortest-path winding relaxation must cover x, y, and angle');
});

test('terminal target uses half-ballistic distance tied to terminalAt', () => {
    let nowServer = 1000;
    const { buildTerminalTargetPayload: build } = loadInlineGameFunctions(
        ['buildTerminalTargetPayload'],
        {
            CONFIG: { TARGET_FPS: 60, DEADRECKON_MAX_FRAMES: 30 },
            RemoteObjects: {
                serverNowMs: () => nowServer,
                getBoundingRadius: () => 0,
            },
            wrapRadiusFor: () => 0,
            wrapMarginX: () => 0,
            wrapMarginY: () => 0,
            wrapNormalizedMod: value => ((value % 1) + 1) % 1,
            velocityToNormalizedDeltaX: value => value,
            velocityToNormalizedDeltaY: value => value,
            normalizeTerminalAngle: value =>
                ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        });
    const record = {
        validAt: 1000,
        data: {
            x: 0.1,
            y: 0.2,
            angle: 0.3,
            velocityX: 0.01,
            velocityY: -0.02,
            rotationSpeed: 0.005,
        }
    };
    const terminal = { epoch: 900, terminalAt: 1250 };
    const owned = build(record.data, record, terminal);
    const first = build(null, record, terminal);
    approx(owned.terminalX, 0.175);
    approx(owned.terminalY, 0.05);
    approx(owned.terminalAngle, 0.3375);
    assert.deepEqual(first, owned);
    nowServer = 100_000;
    const muchLater = build(null, record, terminal);
    assert.deepEqual(muchLater, first);
});

test('a coasting wreck converges on the same stopping point for every member', () => {
    // A predicted-fatal death hold cuts the controls but keeps the ship
    // coasting (see handleShipHit / beginShipDeathHold), so the wreck is just
    // another moving object here: its target is the half-ballistic stopping
    // projection, identical for the ship's owner, the GameState owner, and
    // spectators. Once friction has bled the coast off, that target collapses
    // onto the wreck's own pose.
    const { buildTerminalTargetPayload: build } = loadInlineGameFunctions(
        ['buildTerminalTargetPayload'],
        {
            CONFIG: { TARGET_FPS: 60, DEADRECKON_MAX_FRAMES: 30 },
            RemoteObjects: { serverNowMs: () => 1000, getBoundingRadius: () => 0 },
            wrapRadiusFor: () => 0,
            wrapMarginX: () => 0,
            wrapMarginY: () => 0,
            wrapNormalizedMod: value => ((value % 1) + 1) % 1,
            velocityToNormalizedDeltaX: value => value,
            velocityToNormalizedDeltaY: value => value,
            normalizeTerminalAngle: value =>
                ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        });

    // Still coasting: the target leads the wreck by half its ballistic travel
    // through terminalAt, and rotation is cut so the angle is unchanged.
    const coasting = {
        x: 0.25, y: 0.75, angle: 1.25,
        velocityX: 0.002, velocityY: -0.001, rotationSpeed: 0
    };
    const stoppingFrames = ((1250 - 1000) / (1000 / 60)) / 2;
    const coastingPayload = build(
        coasting, { validAt: 1000, data: coasting }, { epoch: 900, terminalAt: 1250 });
    approx(coastingPayload.terminalX, 0.25 + 0.002 * stoppingFrames);
    approx(coastingPayload.terminalY, 0.75 - 0.001 * stoppingFrames);
    approx(coastingPayload.terminalAngle, 1.25);
    assert.equal(coastingPayload.x, 0.25, 'the anchor stays the live pose');
    assert.equal(coastingPayload.y, 0.75);

    // Fully decayed: no travel left, so every window yields the wreck's pose.
    const stopped = {
        x: 0.25, y: 0.75, angle: 1.25,
        velocityX: 0, velocityY: 0, rotationSpeed: 0
    };
    const record = { validAt: 1000, data: stopped };
    for (const terminalAt of [1000, 1250, 100_000]) {
        const payload = build(stopped, record, { epoch: 900, terminalAt });
        approx(payload.terminalX, stopped.x);
        approx(payload.terminalY, stopped.y);
        approx(payload.terminalAngle, stopped.angle);
        assert.equal(payload.x, stopped.x);
        assert.equal(payload.y, stopped.y);
    }
});

test('terminal publisher retries owned targets and retires ownership races', () => {
    const records = new Map([
        ['ours', {
            id: 'ours',
            type: 'ship',
            ownerMemberId: 'me',
            data: {}
        }],
        ['theirs', {
            id: 'theirs',
            type: 'asteroid',
            ownerMemberId: 'other',
            data: {}
        }],
        ['done', {
            id: 'done',
            type: 'bullet',
            ownerMemberId: 'me',
            data: { terminalEpoch: 10, terminalX: 0.2, terminalY: 0.4 }
        }],
    ]);
    const state = {
        pendingBootstrapIds: new Set(['deleted']),
        ownedWrites: new Map(),
    };
    const updates = [];
    const confirmed = new Map();
    let now = 0;
    const objectSync = {
        getObject: id => records.get(id),
        getObjectsByType: type => [...records.values()]
            .filter(record => record.type === type),
        isDataConfirmed(id, payload) {
            const data = confirmed.get(id);
            return !!data && Object.entries(payload).every(
                ([key, value]) => Object.is(data[key], value));
        },
        updateObject(id, payload, immediate) {
            updates.push({ id, payload, immediate });
            Object.assign(records.get(id).data, payload);
        },
    };
    const { publishOwnedTerminalTargets: publish } = loadInlineGameFunctions(
        ['publishOwnedTerminalTargets'],
        {
            isSessionMode: () => true,
            isDeterministicMode: () => true,
            resolveTerminalSession: () => ({ epoch: 10, terminalAt: 750 }),
            deterministicTerminalState: state,
            ObjectSync: objectSync,
            SessionClient: { getCurrentMember: () => ({ id: 'me' }) },
            performance: { now: () => now },
            OBJECT_TYPES: { SHIP: 'ship', ASTEROID: 'asteroid', BULLET: 'bullet' },
            hasPersistedTerminalTarget: record => record.data.terminalEpoch === 10,
            getKinematicInstance: () => null,
            buildTerminalTargetPayload: (instance, record) => ({
                terminalEpoch: 10,
                terminalX: record.id === 'ours' ? 0.3 : 0.6,
                terminalY: 0.7,
            })
        });

    publish();
    assert.deepEqual(updates.map(update => update.id), ['ours']);
    assert.equal(updates[0].immediate, true);
    assert.equal(state.pendingBootstrapIds.has('deleted'), false);

    now = 100;
    publish();
    assert.equal(updates.length, 1);
    now = 250;
    publish();
    assert.equal(updates.length, 2, 'cached writes remain retryable');

    confirmed.set('ours', updates.at(-1).payload);
    now = 500;
    publish();
    assert.equal(updates.length, 2, 'confirmation retires retries');
    assert.equal(state.ownedWrites.has('ours'), false);

    records.get('ours').ownerMemberId = 'other';
    records.set('migrated', {
        id: 'migrated',
        type: 'asteroid',
        ownerMemberId: 'me',
        data: {}
    });
    now = 750;
    publish();
    assert.equal(updates.at(-1).id, 'migrated');
});

test('unified ship schema persists every terminal field written by updates', () => {
    const shipSchema = SCHEMAS.find(schema => schema.id === 1);
    assert.ok(shipSchema);
    for (const field of [
        'terminalEpoch',
        'terminalX',
        'terminalY',
        'terminalAngle'
    ]) {
        assert.ok(
            shipSchema.fields.some(([name, type]) =>
                name === field && type === 'f64'),
            `${field} must be a ship f64 field`);
    }
    assert.equal(selectSchemaId(
        { type: 'ship', terminalEpoch: 1 },
        'create'), 1);
    assert.equal(selectSchemaId(
        { type: 'bullet', terminalEpoch: 1 },
        'create'), 3);
});
