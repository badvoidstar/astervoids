import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function extractProductionFunction(name, nextMarker) {
    const start = productionSource.indexOf(`function ${name}(`);
    const end = productionSource.indexOf(nextMarker, start);
    assert.ok(start >= 0 && end > start, `could not extract ${name}`);
    return productionSource.slice(start, end);
}

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

test('production relaxes winding axes regardless of the late threshold', () => {
    const source = extractProductionFunction(
        'createCanonicalTerminalTransition',
        'function terminalTargetMatches');
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
    const factory = new Function(
        'deterministicTerminalState',
        'sampleTerminalTransition',
        'lastRenderedPose',
        'velocityToNormalizedDeltaX',
        'velocityToNormalizedDeltaY',
        'CONFIG',
        'wrapRadiusFor',
        'wrapMarginX',
        'wrapMarginY',
        'ReplicationPresentation',
        `${source}\nreturn createCanonicalTerminalTransition;`);
    const create = factory(
        {
            directTargetIds: new Set()
        },
        () => current,
        () => current,
        value => value,
        value => value,
        {
            TARGET_FPS: 1000,
            DEADRECKON_GAMEOVER_MIN_CONVERGENCE_MS: 180,
            DEADRECKON_GAMEOVER_LATE_SETTLE_MS: 300
        },
        () => 0.05,
        () => 0.05,
        () => 0.05,
        {
            createWrappedConvergenceTransition
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
    const source = extractProductionFunction(
        'createProvisionalTerminalTransition',
        'function createCanonicalTerminalTransition');
    const factory = new Function(
        'lastRenderedPose',
        'velocityToNormalizedDeltaX',
        'velocityToNormalizedDeltaY',
        'CONFIG',
        'ReplicationPresentation',
        `${source}\nreturn createProvisionalTerminalTransition;`);
    const create = factory(
        obj => ({ x: obj.x, y: obj.y, angle: obj.angle }),
        value => value,
        value => value,
        {
            TARGET_FPS: 1000,
            DEADRECKON_GAMEOVER_MIN_CONVERGENCE_MS: 180,
            DEADRECKON_GAMEOVER_LATE_SETTLE_MS: 300
        },
        {
            createMinimumJerkTransition
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
    const source = extractProductionFunction(
        'shouldDeferTerminalBootstrap',
        '// Pause menu element reference');
    const state = {
        pendingBootstrapIds: new Set(['snapshot-object']),
        bootstrapEpoch: 123,
    };
    const factory = new Function(
        'deterministicTerminalState',
        'isDeterministicMode',
        'resolveTerminalSession',
        'hasPersistedTerminalTarget',
        `${source}\nreturn shouldDeferTerminalBootstrap;`);
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
    const source = extractProductionFunction(
        'buildTerminalTargetPayload',
        'function publishOwnedTerminalTargets');
    let nowServer = 1000;
    const factory = new Function(
        'CONFIG',
        'RemoteObjects',
        'wrapRadiusFor',
        'wrapMarginX',
        'wrapMarginY',
        'wrapNormalizedMod',
        'velocityToNormalizedDeltaX',
        'velocityToNormalizedDeltaY',
        'normalizeTerminalAngle',
        `${source}\nreturn buildTerminalTargetPayload;`);
    const build = factory(
        { TARGET_FPS: 60, DEADRECKON_MAX_FRAMES: 30 },
        {
            serverNowMs: () => nowServer,
            getBoundingRadius: () => 0,
        },
        () => 0,
        () => 0,
        () => 0,
        value => ((value % 1) + 1) % 1,
        value => value,
        value => value,
        value => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
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
    const source = extractProductionFunction(
        'publishOwnedTerminalTargets',
        'async function deleteSyncedBullet');
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
    const factory = new Function(
        'isSessionMode',
        'isDeterministicMode',
        'resolveTerminalSession',
        'deterministicTerminalState',
        'ObjectSync',
        'SessionClient',
        'performance',
        'OBJECT_TYPES',
        'hasPersistedTerminalTarget',
        'getKinematicInstance',
        'buildTerminalTargetPayload',
        `${source}\nreturn publishOwnedTerminalTargets;`);
    const publish = factory(
        () => true,
        () => true,
        () => ({ epoch: 10, terminalAt: 750 }),
        state,
        objectSync,
        { getCurrentMember: () => ({ id: 'me' }) },
        { now: () => now },
        { SHIP: 'ship', ASTEROID: 'asteroid', BULLET: 'bullet' },
        record => record.data.terminalEpoch === 10,
        () => null,
        (instance, record) => ({
            terminalEpoch: 10,
            terminalX: record.id === 'ours' ? 0.3 : 0.6,
            terminalY: 0.7,
        }));

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
