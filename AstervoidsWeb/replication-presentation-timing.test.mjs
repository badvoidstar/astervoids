import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Clock = require('./wwwroot/js/replication-clock.js');
const Presentation = require('./wwwroot/js/replication-presentation.js');
const Send = require('./wwwroot/js/replication-send-policy.js');
const frameMs = 1000 / 60;
const close = (actual, expected, epsilon = 1e-8) =>
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const shortestAngleDelta = (target, current) =>
    Math.atan2(Math.sin(target - current), Math.cos(target - current));
const wrap = (value, state) => {
    const radius = state.radius || 0;
    const span = 1 + 2 * radius;
    return ((value + radius) % span + span) % span - radius;
};
const shortest = (from, to, state) => {
    const span = 1 + 2 * (state.radius || 0);
    const delta = to - from;
    return delta - Math.round(delta / span) * span;
};
const pose = (values = {}) => ({
    x: 0.2, y: 0.3, angle: 0, velocityX: 0.001, velocityY: 0,
    rotationSpeed: 0.01, radius: 0.05, ...values
});

function deadReckoning(overrides = {}) {
    return Presentation.createDeadReckoningPolicy({
        config: {
            TARGET_FPS: 60, DEADRECKON_MAX_FRAMES: 120,
            DEADRECKON_SMOOTH_MS: 90, DEADRECKON_SNAP_DIST: 0.2
        },
        nowMs: () => { throw new Error('explicit frame time required'); },
        createState: (data, recvPerf) => ({ ...data, recvPerf }),
        velocityToDeltaX: value => value,
        velocityToDeltaY: value => value,
        shortestAngleDelta,
        wrapX: wrap, wrapY: wrap,
        shortestDeltaX: shortest, shortestDeltaY: shortest,
        ...overrides
    });
}

function snapshotPolicy(overrides = {}) {
    return Presentation.createSnapshotInterpolationPolicy({
        config: {
            TARGET_FPS: 60, SNAPSHOT_BUFFER_SIZE: 6, INTERPOLATION_ENABLED: true,
            MAX_EXTRAPOLATION: 1, SNAP_THRESHOLD: 0.25,
            INTERPOLATION_SMOOTH_MS: 90
        },
        nowMs: () => 0,
        validAtToTime: value => value,
        getDelayForMember: () => 0,
        velocityToDeltaX: value => value * 60,
        velocityToDeltaY: value => value * 60,
        shortestDeltaX: shortest, shortestDeltaY: shortest,
        wrapX: wrap, wrapY: wrap,
        distanceBetween: (a, b) => Math.hypot(shortest(a.x, b.x, b), shortest(a.y, b.y, b)),
        isRotationTarget: data => data.targetMode,
        ...overrides
    });
}

test('server presentation time ignores wall jumps and slews accepted offset refreshes', async () => {
    let perf = 1000;
    let wall = 100000;
    let serverOffset = 100000;
    const clock = Clock.create({
        ping: async () => perf + serverOffset,
        monotonicNowMs: () => perf,
        wallNowMs: () => wall,
        setTimeout: () => { throw new Error('no timers expected'); },
        clearTimeout: () => {},
        emaAlpha: 1
    });
    clock.state.running = true;
    await clock.runPingBurst(1);
    close(clock.serverNowMs(), 101000);
    perf += 50;
    wall -= 3600000;
    close(clock.serverNowMs(), 101050);
    close(clock.validAtToMonotonicMs(101050), perf);
    await clock.runPingBurst(1);
    assert.equal(clock.state.rejectedCount, 0, 'wall jumps are not rejected clock samples');
    serverOffset -= 10;
    const beforeRefresh = clock.serverNowMs();
    await clock.runPingBurst(1);
    close(clock.serverNowMs(), beforeRefresh, 1e-6);
    for (let i = 0; i < 20; i++) {
        const before = clock.serverNowMs();
        perf += 10;
        wall += 1000000;
        const after = clock.serverNowMs();
        assert.ok(after >= before + 9.8 - 1e-6 && after <= before + 10.2 + 1e-6);
        close(clock.validAtToMonotonicMs(after), perf);
    }
});

test('ballistic prediction uses injected radius-aware wrapping and separate bounded horizons', () => {
    const policy = deadReckoning({
        getMaxPredictionFrames: state => state.controlled ? 90 : 120
    });
    policy.updateState('rock', pose({ x: 1.04, velocityX: 0.02 }), 0, true, false, null, 0);
    close(policy.getReckoned('rock', frameMs).x, -0.04);
    close(policy.getReckoned('rock', 3000).x,
        policy.getReckoned('rock', 2000).x);
    assert.equal(policy.getReckoned('rock', 3000).velocityX, 0);
    policy.updateState('ship', pose({ controlled: true }), 0, true, false, null, 0);
    close(policy.getReckoned('ship', 3000).x, 0.29);
    close(policy.getReckoned('rock', 1000).x, 0.04);
});

test('re-anchors preserve displayed position and velocity including an active correction', () => {
    const policy = deadReckoning();
    policy.updateState('rock', pose(), 0, true, false, null, 0);
    for (const time of [100, 130, 170]) {
        const old = policy.getReckoned('rock', time);
        policy.updateState('rock', pose({
            x: old.x - 0.02, velocityX: 0.002, angle: old.angle + 0.1,
            rotationSpeed: 0.02
        }), time, false, false, null, time);
        const current = policy.getReckoned('rock', time);
        close(current.x, old.x);
        close(current.velocityX, old.velocityX);
        close(current.angle, old.angle);
        close(current.rotationSpeed, old.rotationSpeed);
        const after = policy.getReckoned('rock', time + 0.001);
        close((after.x - current.x) / 0.001 * frameMs, current.velocityX, 1e-7);
    }
});

test('stateContext.nowPerf supplies the shared correction time without another clock sample', () => {
    const policy = deadReckoning();
    policy.updateState('rock', pose(), 0, true, false, { nowPerf: 0 });
    const before = policy.getReckoned('rock', 100);
    policy.updateState('rock', pose({ x: 0.19, velocityX: 0.002 }),
        100, false, false, { nowPerf: 100 });
    const after = policy.getReckoned('rock', 100);
    close(after.x, before.x);
    close(after.velocityX, before.velocityX);
});

test('shared presentation timeline stays monotonic and derivative-continuous across delay changes', () => {
    const timeline = Presentation.createPresentationTimeline({ maxSlewRate: 0.1 });
    close(timeline.sampleTime(100, 50), 50);
    close(timeline.sampleTime(200, 50), 150);
    close(timeline.sampleTime(200, 250), 150);
    close(timeline.getRate(), 1);
    let previous = 150;
    for (let now = 210; now <= 5000; now += 10) {
        const desired = now < 1000 ? 250 : now < 2000 ? 0 : 150;
        const next = timeline.sampleTime(now, desired);
        assert.ok(next > previous);
        assert.ok(next - previous >= 9 - 1e-8 && next - previous <= 11 + 1e-8);
        assert.ok(timeline.getRate() >= 0.9 && timeline.getRate() <= 1.1);
        previous = next;
    }
    close(timeline.sampleTime(0, 0), previous, 1e-8);
    timeline.reset();
    close(timeline.sampleTime(10, 2), 8);
    close(timeline.getRate(), 1);
});

test('wrap corrections take the short displacement; impulses intentionally bypass smoothing', () => {
    const policy = deadReckoning();
    policy.updateState('rock', pose({ x: 1.04, velocityX: 0 }), 0, true, false, null, 0);
    policy.updateState('rock', pose({ x: -0.04, velocityX: 0.001 }), 0, false, false, null, 0);
    close(policy.getReckoned('rock', 0).x, 1.04);
    assert.ok(Math.abs(policy.smooth.get('rock').dx) < 0.03);
    policy.updateState('rock', pose({ x: 0.8, velocityX: -0.01 }), 10, false, false,
        { impulse: true }, 10);
    close(policy.getReckoned('rock', 10).x, 0.8);
    close(policy.getReckoned('rock', 10).velocityX, -0.01);
});

test('near-coincident buffered endpoints converge to the exact newer key', () => {
    const policy = snapshotPolicy();
    policy.updateState('rock', pose({ x: 0.2 }), 'owner', 100, 0);
    policy.updateState('rock', pose({ x: 0.2006 }), 'owner', 110, 0);
    const before = policy.getInterpolated('rock', 109.999);
    const endpoint = policy.getInterpolated('rock', 110);
    close(before.x, endpoint.x, 1e-6);
    close(endpoint.x, 0.2006);
    close(before.velocityX, endpoint.velocityX, 1e-6);
    policy.updateState('rock', pose({ x: 0.2006 }), 'owner', 110, 0);
    assert.equal(policy.states.get('rock').snapshots.length, 2, 'duplicate keys coalesce');
});

test('ballistic buffered rotation uses rate-informed windings while target ships use shortest arcs', () => {
    const policy = snapshotPolicy();
    const speed = 0.12;
    for (const [id, targetMode] of [['rock', false], ['ship', true]]) {
        policy.updateState(id, pose({ velocityX: 0, angle: 0, rotationSpeed: speed, targetMode }),
            'owner', 0, 0);
        policy.updateState(id, pose({ velocityX: 0, angle: speed * 60 - Math.PI * 2,
            rotationSpeed: speed, targetMode }), 'owner', 1000, 0);
    }
    close(policy.getInterpolated('rock', 500).angle, 3.6);
    assert.ok(policy.getInterpolated('ship', 500).angle < 1);
    close(policy.getInterpolated('rock', 999.999).angle,
        policy.getInterpolated('rock', 1000).angle, 1e-5);
});

test('buffered fresh anchors preserve value and first derivative', () => {
    const policy = snapshotPolicy();
    policy.updateState('rock', pose(), 'owner', 0, 0);
    const displayed = policy.getInterpolated('rock', 100);
    policy.updateState('rock', pose({ x: 0.19, velocityX: 0.003 }), 'owner', 100, 100);
    const current = policy.getInterpolated('rock', 100);
    close(current.x, displayed.x);
    close(current.velocityX, displayed.velocityX);
    const next = policy.getInterpolated('rock', 100.001);
    close((next.x - current.x) / 0.001 * frameMs, current.velocityX, 1e-7);
});

test('adaptive delay changes slew the buffered timeline without rewinding it', () => {
    let delay = 50;
    const policy = snapshotPolicy({ getDelayForMember: () => delay });
    policy.updateState('rock', pose(), 'owner', 0, 0);
    const a = policy.getInterpolated('rock', 200);
    delay = 250;
    const changed = policy.getInterpolated('rock', 200);
    close(changed.x, a.x);
    close(changed.velocityX, a.velocityX);
    const immediate = policy.getInterpolated('rock', 200.001);
    close((immediate.x - changed.x) / 0.001 * frameMs, changed.velocityX, 1e-8);
    const b = policy.getInterpolated('rock', 210);
    assert.ok(b.x >= a.x);
    assert.ok(b.x - a.x <= 0.001 * 10 / frameMs);
    delay = 0;
    const c = policy.getInterpolated('rock', 220);
    assert.ok(c.x > b.x && c.x - b.x < 0.001);
});

test('buffered impulses discard the old timeline rather than smoothing across the event', () => {
    const policy = snapshotPolicy();
    policy.updateState('rock', pose(), 'owner', 0, 0);
    policy.getInterpolated('rock', 100);
    policy.updateState('rock', pose({ x: 0.15, velocityX: -0.001 }),
        'owner', 100, 100, { impulse: true });
    const current = policy.getInterpolated('rock', 100);
    close(current.x, 0.15);
    close(current.velocityX, -0.001);
    assert.equal(policy.states.get('rock').snapshots.length, 1);
});

test('adaptive delay gives one vote per packet, not per object', () => {
    const config = {
        INTERPOLATION_DELAY: 33, ADAPTIVE_DELAY_ENABLED: true, ADAPTIVE_DELAY_MIN: 16,
        ADAPTIVE_DELAY_SAMPLES: 30, ADAPTIVE_DELAY_MIN_SAMPLES: 5,
        ADAPTIVE_DELAY_JITTER_MULT: 2, ADAPTIVE_DELAY_SMOOTHING: 0.1
    };
    const policy = Presentation.createAdaptiveDelayPolicy({ config, getRttMs: () => 0 });
    for (let i = 0; i < 40; i++) policy.recordObjectSample('owner', 1000, 1030, 1);
    assert.deepEqual(policy.getMemberDelay('owner').lagSamples, [30]);
    policy.recordObjectSample('owner', 1000, 1040, 2);
    assert.deepEqual(policy.getMemberDelay('owner').lagSamples, [30, 40],
        'distinct packet identifiers can disambiguate equal operation stamps');
});

test('send policies accept a shared explicit step time without resampling the clock', () => {
    const options = {
        config: {
            SEND_ON_CHANGE_ENABLED: true, SHIP_SEND_ON_CHANGE_ENABLED: true,
            SHIP_INPUT_REPLAY_ENABLED: true, SEND_ON_CHANGE_HEARTBEAT_MS: 250,
            SEND_ON_CHANGE_VEL_EPS: 0.001, SEND_ON_CHANGE_ROT_EPS: 0.001,
            SEND_ON_CHANGE_WRAP_JUMP: 0.5
        },
        nowMs: () => { throw new Error('unexpected clock sample'); },
        isDeterministic: () => true
    };
    const ballistic = Send.createBallisticGate(options);
    assert.equal(ballistic.decide('rock', { x: 0, y: 0 }, 100).send, true);
    assert.equal(ballistic.decide('rock', { x: 0, y: 0 }, 200).send, false);
    assert.equal(ballistic.decide('rock', { x: 0, y: 0 }, 350).reason, 'heartbeat');
    const ship = Send.createShipGate(options);
    assert.equal(ship.decide('ship', {}, false, 100).send, true);
    assert.equal(ship.decide('ship', {}, false, 200).send, false);
    assert.equal(ship.decide('ship', {}, false, 350).reason, 'heartbeat');
});
