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

// ── Respawn teleport at the game-over boundary ──────────────────────────────
// Losing the last life still respawns the ship at the centre: the shared lives
// counter is authoritative, so the owner cannot know the hit was fatal. The
// terminal transition is then built on the very next frame from the object's
// displayed pose, so an unanchored respawn makes the ship glide from where it
// died to the spawn point instead of appearing there.

const SPAWN = { x: 0.5, y: 0.5, angle: -Math.PI / 2 };

function loadShipRuntime(overrides = {}) {
    const config = {
        TARGET_FPS: 60,
        INVULNERABILITY_TIME: 180,
        SHIP_SIZE: 0.02,
        DEADRECKON_GAMEOVER_MIN_CONVERGENCE_MS: 180,
        DEADRECKON_GAMEOVER_LATE_SETTLE_MS: 300
    };
    const deterministicTerminalState = {
        transitions: new Map(),
        directTargetIds: new Set(),
        pendingBootstrapIds: new Set(),
        ownedWrites: new Map()
    };
    const game = {
        ship: null,
        lives: 1,
        state: 'playing',
        multiplayer: { myShipObjectId: 'mine', remoteShips: new Map() }
    };
    const writes = [];
    const events = [];
    const production = loadInlineGameFunctions([
        'Ship', 'ShipInvulnerability', 'assignDefined',
        'rampInputToward', 'handleShipHit', 'anchorPoseAfterTeleport',
        'rememberRenderedPose', 'lastRenderedPose',
        'createProvisionalTerminalTransition', 'createCanonicalTerminalTransition',
        'sampleTerminalTransition'
    ], {
        CONFIG: config,
        game,
        deterministicTerminalState,
        TURN_CONTROL_MODE: { KEYBOARD_RATE: 0 },
        normalizeTurnControlMode: value => value,
        getShipTurnSpeed: () => 0.1,
        isSessionMode: () => true,
        isDeterministicMode: () => true,
        AudioSystem: {
            playShipExplosion() {},
            thrustSound: { stop() {} },
            beat: { stop() {} }
        },
        CollisionEffects: { startShipHit: (...args) => events.push(args) },
        emitShipStateChanged: pose => events.push(pose),
        ObjectSync: {
            updateObject: (id, data, immediate) =>
                writes.push({ id, data, immediate })
        },
        updateHUD() {},
        publishDebugMetrics() {},
        velocityToNormalizedDeltaX: value => value,
        velocityToNormalizedDeltaY: value => value,
        wrapRadiusFor: () => config.SHIP_SIZE,
        wrapMarginX: () => 0,
        wrapMarginY: () => 0,
        ReplicationPresentation: {
            createMinimumJerkTransition,
            createWrappedConvergenceTransition,
            sampleMinimumJerkTransition
        },
        RemoteObjects: { clock: { offsetInitialized: false } },
        ...overrides
    });
    return { ...production, config, game, deterministicTerminalState, writes };
}

test('a fatal hit respawns the ship and re-anchors both blend anchors', () => {
    const runtime = loadShipRuntime();
    const ship = new runtime.Ship(0.85, 0.2);
    ship.syncObjectId = 'mine';
    ship.velocityX = 3;
    ship.velocityY = -2;
    // The pre-hit pose is what the preceding tick and frame displayed.
    ship._prevX = 0.84;
    ship._prevY = 0.21;
    ship._prevAngle = 1.1;
    runtime.rememberRenderedPose(ship);
    runtime.game.ship = ship;

    runtime.handleShipHit(ship);

    assert.equal(ship.x, SPAWN.x);
    assert.equal(ship.y, SPAWN.y);
    assert.equal(ship.angle, SPAWN.angle);
    assert.equal(ship._prevX, SPAWN.x, 'render interpolation must not sweep');
    assert.equal(ship._prevY, SPAWN.y);
    assert.equal(ship._prevAngle, SPAWN.angle);
    const displayed = runtime.lastRenderedPose(ship);
    assert.equal(displayed.x, SPAWN.x, 'convergence anchor must be the spawn pose');
    assert.equal(displayed.y, SPAWN.y);
    assert.equal(displayed.angle, SPAWN.angle);
    assert.equal(runtime.writes.at(-1).immediate, true);
});

test('game over after the last life holds the ship at spawn instead of blending', () => {
    const runtime = loadShipRuntime();
    const ship = new runtime.Ship(0.85, 0.2);
    ship.syncObjectId = 'mine';
    ship.velocityX = 3;
    ship.velocityY = -2;
    runtime.rememberRenderedPose(ship);
    runtime.game.ship = ship;

    runtime.handleShipHit(ship);

    // The shared lives counter reaches zero and this member starts converging
    // on the very next frame, before any canonical target has been accepted.
    const terminal = { epoch: 5000, terminalAt: 5750 };
    const provisional = runtime.createProvisionalTerminalTransition(
        ship, terminal, 5000);
    for (const at of [5000, 5100, 5375, 5750]) {
        const sample = runtime.sampleTerminalTransition(provisional, at);
        approx(sample.x, SPAWN.x);
        approx(sample.y, SPAWN.y);
        approx(sample.angle, SPAWN.angle);
    }

    // The owner's canonical target is the same spawn pose at rest, so adopting
    // it must not reintroduce motion either.
    const record = {
        id: 'mine',
        data: {
            terminalEpoch: terminal.epoch,
            terminalX: SPAWN.x,
            terminalY: SPAWN.y,
            terminalAngle: SPAWN.angle
        }
    };
    const canonical = runtime.createCanonicalTerminalTransition(
        ship, record, terminal, 5000, provisional);
    for (const at of [5000, 5375, 5750]) {
        const sample = runtime.sampleTerminalTransition(canonical, at);
        approx(sample.x, SPAWN.x);
        approx(sample.y, SPAWN.y);
        approx(sample.angle, SPAWN.angle);
    }
});

test('without re-anchoring the terminal convergence would sweep from the death pose', () => {
    // Regression guard: proves the fixture above would fail on the old path.
    const runtime = loadShipRuntime();
    const ship = new runtime.Ship(0.85, 0.2);
    ship.syncObjectId = 'mine';
    runtime.rememberRenderedPose(ship);
    // Respawn WITHOUT re-anchoring, exactly as the unfixed code did.
    ship.reset();

    const provisional = runtime.createProvisionalTerminalTransition(
        ship, { epoch: 5000, terminalAt: 5750 }, 5000);
    const start = runtime.sampleTerminalTransition(provisional, 5000);
    approx(start.x, 0.85);
    approx(start.y, 0.2);
    assert.notEqual(start.x, SPAWN.x);
});

test('a respawn ingested after the terminal epoch snaps the replica', () => {
    const runtime = loadShipRuntime();
    let terminalSession = null;
    const removed = [];
    const presentationRuntime = loadInlineGameFunctions([
        'createKinematicPresentation', 'anchorPoseAfterTeleport',
        'rememberRenderedPose'
    ], {
        game: runtime.game,
        deterministicTerminalState: runtime.deterministicTerminalState,
        isDeterministicMode: () => true,
        resolveTerminalSession: () => terminalSession,
        OBJECT_TYPES: { SHIP: 'ship' },
        DeadReckon: {
            states: new Map(),
            lastVersions: new Map(),
            updateState() {},
            remove: id => removed.push(id)
        },
        RemoteObjects: {},
        getDeterministicIngestBaselinePerf: () => 0,
        calculateShipRateAngularPredictionWindow: () => null,
        currentKinematicData: (type, id, record) => record.data
    });
    const presentation = presentationRuntime.createKinematicPresentation();

    const replica = new runtime.Ship(0.85, 0.2);
    runtime.game.multiplayer.remoteShips.set('theirs', replica);
    runtime.rememberRenderedPose(replica);
    // A pre-hit heartbeat establishes the invulnerability anchor so the next
    // revision change is recognised as an explicit transition.
    const facts = { type: 'ship' };
    presentation.ingest('theirs', {
        x: 0.85, y: 0.2, angle: 1.1, invulnerable: 0, invulnerabilityRevision: 2
    }, facts, { id: 'theirs', validAt: 4900, version: 1 }, {});

    // This member observes the fatal hitCount event first, so the terminal
    // epoch is already open when the owner's respawn pose lands.
    terminalSession = { epoch: 5000, terminalAt: 5750 };
    runtime.deterministicTerminalState.transitions.set('theirs', { stale: true });
    presentation.ingest('theirs', {
        x: SPAWN.x,
        y: SPAWN.y,
        angle: SPAWN.angle,
        velocityX: 0,
        velocityY: 0,
        invulnerable: 180,
        invulnerabilityRevision: 3
    }, facts, { id: 'theirs', validAt: 5001, version: 2 }, {});

    assert.equal(replica.x, SPAWN.x, 'replica adopts the authoritative spawn pose');
    assert.equal(replica.y, SPAWN.y);
    assert.equal(replica.angle, SPAWN.angle);
    assert.equal(
        runtime.lastRenderedPose(replica).x, SPAWN.x,
        'convergence anchor must follow the teleport');
    assert.equal(
        runtime.deterministicTerminalState.transitions.has('theirs'), false,
        'a stale convergence built from the pre-hit pose must be discarded');
    assert.deepEqual(removed, ['theirs']);
});

test('a respawn ingested while play is observed survives a same-step game over', () => {
    // The observed ordering on a watching member: the respawn arrives while
    // play is still live, so it takes the dead-reckoned path, and the fatal
    // hitCount turns the very same step terminal. Replicas are only moved at
    // render time, so without re-anchoring the first game-over frame still
    // sees the pre-hit pose and sweeps the ship across the arena.
    const runtime = loadShipRuntime();
    let terminalSession = null;
    const updates = [];
    const presentationRuntime = loadInlineGameFunctions([
        'createKinematicPresentation', 'anchorPoseAfterTeleport',
        'rememberRenderedPose'
    ], {
        game: runtime.game,
        deterministicTerminalState: runtime.deterministicTerminalState,
        isDeterministicMode: () => true,
        resolveTerminalSession: () => terminalSession,
        OBJECT_TYPES: { SHIP: 'ship' },
        DeadReckon: {
            states: new Map([['theirs', {}]]),
            lastVersions: new Map(),
            updateState: (id, data, baseline, isTeleport) =>
                updates.push({ id, isTeleport }),
            remove() {}
        },
        RemoteObjects: {},
        getDeterministicIngestBaselinePerf: () => 0,
        calculateShipRateAngularPredictionWindow: () => null,
        currentKinematicData: (type, id, record) => record.data
    });
    const presentation = presentationRuntime.createKinematicPresentation();

    const replica = new runtime.Ship(0.2, 0.2);
    runtime.game.multiplayer.remoteShips.set('theirs', replica);
    runtime.rememberRenderedPose(replica);
    const facts = { type: 'ship' };
    presentation.ingest('theirs', {
        x: 0.2, y: 0.2, angle: 1.1, invulnerable: 0, invulnerabilityRevision: 2
    }, facts, { id: 'theirs', validAt: 4900, version: 1 }, {});

    presentation.ingest('theirs', {
        x: SPAWN.x,
        y: SPAWN.y,
        angle: SPAWN.angle,
        velocityX: 0,
        velocityY: 0,
        invulnerable: 180,
        invulnerabilityRevision: 3
    }, facts, { id: 'theirs', validAt: 5001, version: 2 }, {});

    assert.deepEqual(
        updates.map(u => u.isTeleport), [false, true],
        'the respawn must still reach DeadReckon as an explicit teleport');
    assert.equal(
        runtime.lastRenderedPose(replica).x, SPAWN.x,
        'the convergence anchor must follow the teleport, not the render');
    assert.equal(runtime.lastRenderedPose(replica).y, SPAWN.y);

    // Game over is resolved later in the same step, before the next render.
    terminalSession = { epoch: 5000, terminalAt: 5750 };
    const provisional = runtime.createProvisionalTerminalTransition(
        replica, terminalSession, 5000);
    for (const at of [5000, 5100, 5375, 5750]) {
        const sample = runtime.sampleTerminalTransition(provisional, at);
        approx(sample.x, SPAWN.x);
        approx(sample.y, SPAWN.y);
    }
});
