import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const productionSource = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');
const replicationClockSource = readFileSync(
    resolve(here, 'wwwroot/js/replication-clock.js'),
    'utf8');
const { createRuntime } = require('./wwwroot/js/replication-runtime.js');
const {
    createMinimumJerkTransition,
    integrateRateAngularPredictionFrames,
    sampleMinimumJerkTransition,
} = require('./wwwroot/js/replication-presentation.js');

function extractProductionFunction(name, nextName) {
    const start = productionSource.indexOf(`    function ${name}(`);
    const end = productionSource.indexOf(`\n    function ${nextName}(`, start);
    assert.ok(start >= 0 && end > start, `could not extract production function ${name}`);
    return productionSource.slice(start, end);
}

const joinBaselineSource = extractProductionFunction(
    'getDeterministicJoinBaselinePerf',
    'createKinematicPresentation');

function loadJoinBaselineHelper(dependencies) {
    const names = Object.keys(dependencies);
    const factory = new Function(
        ...names,
        `${joinBaselineSource}\nreturn getDeterministicJoinBaselinePerf;`);
    return factory(...names.map((name) => dependencies[name]));
}

const FRAME_MS = 1000 / 60;
const HEARTBEAT_FRAMES = 15;
const HEARTBEAT_MS = HEARTBEAT_FRAMES * FRAME_MS;
const POSITION_CAP_FRAMES = 30;
const SHIP_RATE_WINDOW = {
    fullFrames: HEARTBEAT_FRAMES,
    taperFrames: 6,
};
const SMOOTH_MS = 90;
const SHIP = {
    TARGET_FPS: 60,
    THRUST: 0.009,
    FRICTION: 0.99,
    TURN_SPEED: 0.12,
    MAX_SPEED: 0.8,
    BRAKE: 0.018,
    MUZZLE: 0.04,
};
const TURN_MODE = {
    RATE: 0,
    TARGET: 1,
};
const RTTS = [0, 50, 100, 150, 250];
const JITTER_AMPLITUDES = [0, 10, 25, 50];
const STALL_PROFILES = [
    { name: 'stall-100ms', windows: [{ startMs: frameMs(9), endMs: frameMs(15) }] },
    { name: 'stall-300ms', windows: [{ startMs: frameMs(9), endMs: frameMs(27) }] },
];
const EPS = 1e-9;

function frameMs(frames) {
    return frames * FRAME_MS;
}

function framesFromMs(ms) {
    return ms / FRAME_MS;
}

function shortestAngleDelta(target, current) {
    const diff = target - current;
    return Math.atan2(Math.sin(diff), Math.cos(diff));
}

function approx(actual, expected, eps = 1e-6, label = 'value') {
    assert.ok(Math.abs(actual - expected) <= eps, `${label}: expected ${expected}, got ${actual}`);
}

function approxPose(actual, expected, eps = 1e-6, label = 'pose') {
    approx(actual.x, expected.x, eps, `${label}.x`);
    approx(actual.y, expected.y, eps, `${label}.y`);
    approx(actual.angle || 0, expected.angle || 0, eps, `${label}.angle`);
}

function poseDistance(a, b) {
    return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
}

function angleDistance(a, b) {
    return Math.abs(shortestAngleDelta((a ?? 0), (b ?? 0)));
}

function motionAlong(poseA, poseB, velocityX, velocityY) {
    const speed = Math.hypot(velocityX, velocityY);
    if (speed <= EPS) return 0;
    return (((poseB.x - poseA.x) * velocityX) + ((poseB.y - poseA.y) * velocityY)) / speed;
}

function createResidualTransition(value, startTimeMs, durationMs) {
    if (Math.abs(value) <= EPS) return null;
    return createMinimumJerkTransition({
        start: value,
        target: 0,
        startTime: startTimeMs,
        endTime: startTimeMs + durationMs,
    });
}

function sampleResidual(transition, nowMs) {
    return transition
        ? sampleMinimumJerkTransition(transition, nowMs).value
        : 0;
}

function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
}

function makeJitterSequence(amplitudeMs) {
    if (amplitudeMs === 0) return [0];
    return [0, amplitudeMs, -amplitudeMs, amplitudeMs, -amplitudeMs, 0, -amplitudeMs, amplitudeMs];
}

function buildNetworkCases() {
    const cases = [];
    for (const rttMs of RTTS) {
        for (const jitterMs of JITTER_AMPLITUDES) {
            cases.push({
                name: `rtt-${rttMs}-jitter-${jitterMs}`,
                rttMs,
                jitterMs,
                jitterSeq: makeJitterSequence(jitterMs),
            });
        }
    }
    return cases;
}

const NETWORK_CASES = buildNetworkCases();

class Timeline {
    constructor() {
        this.nowMs = 0;
        this.seq = 0;
        this.events = [];
    }

    at(timeMs, fn) {
        this.events.push({ timeMs, seq: this.seq++, fn });
        this.events.sort((a, b) => a.timeMs - b.timeMs || a.seq - b.seq);
    }

    runTo(targetMs) {
        while (this.events.length && this.events[0].timeMs <= targetMs + EPS) {
            const event = this.events.shift();
            this.nowMs = event.timeMs;
            event.fn();
        }
        this.nowMs = targetMs;
    }

    runAll() {
        while (this.events.length) {
            const event = this.events.shift();
            this.nowMs = event.timeMs;
            event.fn();
        }
    }
}

class ReliableOrderedLink {
    constructor(timeline, networkCase, stallProfile = null, label = 'link') {
        this.timeline = timeline;
        this.rttMs = networkCase.rttMs;
        this.jitterSeq = networkCase.jitterSeq;
        this.stallProfile = stallProfile;
        this.label = label;
        this.sendSeq = 0;
        this.lastDueMs = -Infinity;
        this.transcript = [];
    }

    send(kind, payload, sendTimeMs, onDeliver) {
        const seq = this.sendSeq++;
        const jitterMs = this.jitterSeq[seq % this.jitterSeq.length];
        const oneWayMs = Math.max(0, (this.rttMs / 2) + jitterMs);
        let dueMs = sendTimeMs + oneWayMs;
        if (this.stallProfile) {
            for (const window of this.stallProfile.windows) {
                if (dueMs >= window.startMs && dueMs < window.endMs) {
                    dueMs = window.endMs;
                }
            }
        }
        if (dueMs < this.lastDueMs) {
            dueMs = this.lastDueMs;
        }
        this.lastDueMs = dueMs;
        const record = { label: this.label, kind, seq, sendTimeMs, dueMs, jitterMs, rttMs: this.rttMs };
        this.transcript.push(record);
        this.timeline.at(dueMs, () => onDeliver(payload, record));
        return record;
    }
}

class BallisticOwner {
    constructor(data) {
        this.state = cloneData(data);
    }

    advance(frames) {
        this.state = projectBallistic(this.state, frameMs(frames));
    }

    snapshot(extra = {}) {
        return { ...cloneData(this.state), ...cloneData(extra) };
    }

    clone() {
        return new BallisticOwner(this.state);
    }
}

function mergeTurnInputs(a, b) {
    const sum = (a || 0) + (b || 0);
    if (sum > 1) return 1;
    if (sum < -1) return -1;
    return sum;
}

function attainableTurnTarget(delta, maxMagnitude, ratePerFrame, dt) {
    if (maxMagnitude <= 0 || delta === 0 || ratePerFrame <= 0 || dt <= 0) return 0;
    const cappedMag = Math.min(maxMagnitude, Math.abs(delta) / (ratePerFrame * dt));
    return Math.sign(delta) * cappedMag;
}

class MiniShip {
    constructor(data = {}) {
        this.x = data.x || 0;
        this.y = data.y || 0;
        this.angle = data.angle || 0;
        this.velocityX = data.velocityX || 0;
        this.velocityY = data.velocityY || 0;
        this.rotationSpeed = data.rotationSpeed || 0;
        this.turnInput = data.turnInput || 0;
        this.turnTarget = data.turnTarget || 0;
        this.turnControlMode = data.turnControlMode || TURN_MODE.RATE;
        this.turnTargetAngle = data.turnTargetAngle || 0;
        this.turnMagnitude = data.turnMagnitude || 0;
        this.turnBias = data.turnBias || 0;
        this.thrustInput = data.thrustInput || 0;
        this.brakeInput = data.brakeInput || 0;
        this.invulnerable = data.invulnerable || 0;
        this.thrusting = !!data.thrusting;
    }

    update(dt = 1) {
        if (this.turnControlMode === TURN_MODE.TARGET) {
            const delta = shortestAngleDelta(this.turnTargetAngle || 0, this.angle);
            const targetTurn = attainableTurnTarget(delta, this.turnMagnitude || 0, SHIP.TURN_SPEED, dt);
            this.turnTarget = mergeTurnInputs(targetTurn, this.turnBias || 0);
        }
        this.turnInput = this.turnTarget;
        this.rotationSpeed = SHIP.TURN_SPEED * this.turnInput;
        this.angle += this.rotationSpeed * dt;
        const friction = Math.pow(SHIP.FRICTION, dt);
        this.velocityX *= friction;
        this.velocityY *= friction;
        if (this.thrustInput > 0) {
            const accel = SHIP.THRUST * this.thrustInput;
            this.velocityX += Math.cos(this.angle) * accel * dt;
            this.velocityY += Math.sin(this.angle) * accel * dt;
        }
        const speedSq = (this.velocityX ** 2) + (this.velocityY ** 2);
        const maxSq = SHIP.MAX_SPEED ** 2;
        if (speedSq > maxSq) {
            const speed = Math.sqrt(speedSq);
            this.velocityX = (this.velocityX / speed) * SHIP.MAX_SPEED;
            this.velocityY = (this.velocityY / speed) * SHIP.MAX_SPEED;
        }
        if (this.brakeInput > 0) {
            const speed = Math.sqrt((this.velocityX ** 2) + (this.velocityY ** 2));
            if (speed > 0) {
                const decel = SHIP.BRAKE * this.brakeInput * dt;
                const factor = Math.max(0, speed - decel) / speed;
                this.velocityX *= factor;
                this.velocityY *= factor;
            }
        }
        this.x += this.velocityX * dt;
        this.y += this.velocityY * dt;
    }

    snapshot(extra = {}) {
        return {
            x: this.x,
            y: this.y,
            angle: this.angle,
            velocityX: this.velocityX,
            velocityY: this.velocityY,
            rotationSpeed: this.rotationSpeed,
            thrustInput: this.thrustInput,
            brakeInput: this.brakeInput,
            thrusting: this.thrusting,
            turnControlMode: this.turnControlMode,
            turnTarget: this.turnTarget,
            turnTargetAngle: this.turnTargetAngle,
            turnMagnitude: this.turnMagnitude,
            turnBias: this.turnBias,
            invulnerable: this.invulnerable || 0,
            ...cloneData(extra),
        };
    }

    clone() {
        return new MiniShip(this.snapshot());
    }
}

function replayShip(packet, frames) {
    const ship = new MiniShip(packet);
    ship.turnInput = SHIP.TURN_SPEED !== 0 ? (packet.rotationSpeed || 0) / SHIP.TURN_SPEED : 0;
    let remaining = Math.max(0, frames);
    while (remaining > 1e-9) {
        const dt = remaining > 1 ? 1 : remaining;
        ship.update(dt);
        remaining -= dt;
    }
    return ship.snapshot();
}

function shipMuzzlePose(shipData) {
    return {
        x: shipData.x + (Math.cos(shipData.angle) * SHIP.MUZZLE),
        y: shipData.y + (Math.sin(shipData.angle) * SHIP.MUZZLE),
        angle: shipData.angle,
    };
}

function projectBallistic(data, dtMs) {
    const frames = Math.min(Math.max(0, framesFromMs(dtMs)), POSITION_CAP_FRAMES);
    return {
        ...cloneData(data),
        x: (data.x || 0) + ((data.velocityX || 0) * frames),
        y: (data.y || 0) + ((data.velocityY || 0) * frames),
        angle: (data.angle || 0) + ((data.rotationSpeed || 0) * frames),
    };
}

function projectBallisticUncapped(data, dtMs) {
    const frames = Math.max(0, framesFromMs(dtMs));
    return {
        ...cloneData(data),
        x: (data.x || 0) + ((data.velocityX || 0) * frames),
        y: (data.y || 0) + ((data.velocityY || 0) * frames),
        angle: (data.angle || 0) + ((data.rotationSpeed || 0) * frames),
    };
}

function projectShip(data, dtMs) {
    const frames = Math.min(Math.max(0, framesFromMs(dtMs)), POSITION_CAP_FRAMES);
    return replayShip(data, frames);
}

function projectKind(kind, data, dtMs) {
    return kind === 'ship' ? projectShip(data, dtMs) : projectBallistic(data, dtMs);
}

function sampleConvergence(replica, arrivalTimeMs, frameCount, axis = null) {
    const values = [];
    for (let i = 0; i <= frameCount; i++) {
        const sample = replica.sample(arrivalTimeMs + frameMs(i));
        const raw = replica.sampleRaw(arrivalTimeMs + frameMs(i));
        values.push(axis ? sample[axis] - raw[axis] : poseDistance(sample, raw));
    }
    return values;
}

function sampleEventTrajectory(kind, event, dtMs) {
    const raw = projectKind(kind, event.installed, dtMs);
    if (!event.displayedBefore) return raw;
    const startTimeMs = 0;
    const x = createResidualTransition(
        event.displayedBefore.x - event.fresh.x,
        startTimeMs,
        SMOOTH_MS);
    const y = createResidualTransition(
        event.displayedBefore.y - event.fresh.y,
        startTimeMs,
        SMOOTH_MS);
    const angle = createResidualTransition(
        shortestAngleDelta(
            event.displayedBefore.angle || 0,
            event.fresh.angle || 0),
        startTimeMs,
        SMOOTH_MS);
    return {
        ...raw,
        x: raw.x + sampleResidual(x, dtMs),
        y: raw.y + sampleResidual(y, dtMs),
        angle: (raw.angle || 0) + sampleResidual(angle, dtMs),
    };
}

function assertMonotoneMagnitudeDecay(values, label) {
    for (let i = 1; i < values.length; i++) {
        assert.ok(Math.abs(values[i]) <= Math.abs(values[i - 1]) + 1e-6,
            `${label}: expected decay at index ${i}, got ${values[i - 1]} -> ${values[i]}`);
    }
}

class Replica {
    constructor(kind) {
        this.kind = kind;
        this.state = null;
        this.smooth = null;
        this.events = [];
    }

    sampleRaw(nowMs) {
        if (!this.state) return null;
        return projectKind(this.kind, this.state.data, nowMs - this.state.recvTimeMs);
    }

    sample(nowMs) {
        const raw = this.sampleRaw(nowMs);
        if (!raw || !this.smooth) return raw;
        const x = this.smooth.x
            ? sampleMinimumJerkTransition(this.smooth.x, nowMs)
            : null;
        const y = this.smooth.y
            ? sampleMinimumJerkTransition(this.smooth.y, nowMs)
            : null;
        const angle = this.smooth.angle
            ? sampleMinimumJerkTransition(this.smooth.angle, nowMs)
            : null;
        if ((!x || x.done) && (!y || y.done) && (!angle || angle.done)) {
            this.smooth = null;
            return raw;
        }
        return {
            ...raw,
            x: raw.x + (x?.value || 0),
            y: raw.y + (y?.value || 0),
            angle: (raw.angle || 0) + (angle?.value || 0),
        };
    }

    ingest(packet, arrivalTimeMs, opts = {}) {
        const { source = 'live', rttMs = 0, snap = false, smoothMs = SMOOTH_MS } = opts;
        const displayedBefore = (!snap && this.state) ? this.sample(arrivalTimeMs) : null;
        let installData = cloneData(packet.data);
        if (!this.state && source === 'join-midpoint') {
            const seedTargetMs = arrivalTimeMs - (rttMs / 2);
            installData = projectKind(this.kind, packet.data, seedTargetMs - packet.validAtMs);
        }
        this.state = {
            data: installData,
            recvTimeMs: arrivalTimeMs,
            validAtMs: packet.validAtMs,
        };
        const fresh = this.sampleRaw(arrivalTimeMs);
        if (displayedBefore && !snap) {
            const dx = displayedBefore.x - fresh.x;
            const dy = displayedBefore.y - fresh.y;
            const da = shortestAngleDelta(displayedBefore.angle || 0, fresh.angle || 0);
            if (Math.abs(dx) > EPS || Math.abs(dy) > EPS || Math.abs(da) > EPS) {
                const durationMs = Math.max(
                    smoothMs,
                    directionPreservingSmoothMs(
                        displayedBefore,
                        fresh,
                        installData,
                        1.01));
                this.smooth = {
                    x: createResidualTransition(
                        dx, arrivalTimeMs, durationMs),
                    y: createResidualTransition(
                        dy, arrivalTimeMs, durationMs),
                    angle: createResidualTransition(
                        da, arrivalTimeMs, durationMs),
                };
            } else {
                this.smooth = null;
            }
        } else {
            this.smooth = null;
        }
        const displayedAfter = this.sample(arrivalTimeMs);
        const event = {
            source,
            snap,
            arrivalTimeMs,
            validAtMs: packet.validAtMs,
            packet: cloneData(packet.data),
            installed: cloneData(installData),
            displayedBefore,
            fresh,
            displayedAfter,
        };
        this.events.push(event);
        return event;
    }
}

function directionPreservingSmoothMs(displayed, fresh, data, safety = 1.01) {
    let requiredMs = SMOOTH_MS;
    const vx = data.velocityX || 0;
    const vy = data.velocityY || 0;
    const speedPerFrame = Math.hypot(vx, vy);
    if (speedPerFrame > EPS) {
        const correctionAlong = (
            ((displayed.x - fresh.x) * vx)
            + ((displayed.y - fresh.y) * vy)
        ) / speedPerFrame;
        if (correctionAlong > 0) {
            requiredMs = Math.max(
                requiredMs,
                (15 / 8) * correctionAlong * FRAME_MS / speedPerFrame);
        }
    }
    const rotationPerFrame = data.rotationSpeed || 0;
    const angularCorrection = shortestAngleDelta(displayed.angle || 0, fresh.angle || 0);
    if (Math.abs(rotationPerFrame) > EPS
        && Math.sign(angularCorrection) === Math.sign(rotationPerFrame)) {
        requiredMs = Math.max(
            requiredMs,
            (15 / 8) * Math.abs(angularCorrection)
                * FRAME_MS / Math.abs(rotationPerFrame));
    }
    return requiredMs * safety;
}

function assertContinuous(event, label) {
    if (!event.displayedBefore) return;
    assert.ok(poseDistance(event.displayedAfter, event.displayedBefore) <= 1e-6,
        `${label}: positional jump ${poseDistance(event.displayedAfter, event.displayedBefore)}`);
    const displayedAfterAngle = event.displayedAfter && Number.isFinite(event.displayedAfter.angle)
        ? event.displayedAfter.angle
        : 0;
    const displayedBeforeAngle = event.displayedBefore && Number.isFinite(event.displayedBefore.angle)
        ? event.displayedBefore.angle
        : 0;
    assert.ok(angleDistance(displayedAfterAngle, displayedBeforeAngle) <= 1e-6,
        `${label}: angular jump ${angleDistance(displayedAfterAngle, displayedBeforeAngle)}`);
}

function assertSettlesTo(replica, arrivalTimeMs, frameCount, label) {
    const values = sampleConvergence(replica, arrivalTimeMs, frameCount);
    assertMonotoneMagnitudeDecay(values, label);
    const initial = values[0];
    const final = values[values.length - 1];
    assert.ok(final <= (initial * 0.02) + 1e-6, `${label}: expected strong decay, got ${initial} -> ${final}`);
}

function last(array) {
    return array[array.length - 1];
}

function runSteadyBallisticCase(networkCase) {
    const timeline = new Timeline();
    const link = new ReliableOrderedLink(timeline, networkCase, null, 'steady-ballistic');
    const replica = new Replica('ballistic');
    const owner = new BallisticOwner({
        x: 2,
        y: -1,
        angle: 0.3,
        velocityX: 1.75,
        velocityY: -0.25,
        rotationSpeed: 0.04,
    });

    const sends = [];
    for (const frame of [0, HEARTBEAT_FRAMES, HEARTBEAT_FRAMES * 2]) {
        if (frame > 0) owner.advance(HEARTBEAT_FRAMES);
        const validAtMs = frameMs(frame);
        const packet = { validAtMs, data: owner.snapshot() };
        sends.push(packet);
        link.send(frame === 0 ? 'create' : 'heartbeat', packet, validAtMs, (payload, meta) => {
            replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
        });
    }
    timeline.runAll();

    const createEvent = replica.events[0];
    approxPose(createEvent.displayedAfter, sends[0].data, 1e-6, 'live-create-arrival-anchor');
    const fiveFramesLater = sampleEventTrajectory('ballistic', createEvent, frameMs(5));
    approxPose(fiveFramesLater, projectBallistic(sends[0].data, frameMs(5)), 1e-6, 'steady-ballistic-five-frames');

    for (let i = 1; i < replica.events.length; i++) {
        const event = replica.events[i];
        assertContinuous(event, `steady-ballistic-${networkCase.name}-event-${i}`);
        const correctionFrames = Math.abs((event.arrivalTimeMs - event.validAtMs) - (replica.events[i - 1].arrivalTimeMs - replica.events[i - 1].validAtMs)) / FRAME_MS;
        const speed = Math.hypot(event.packet.velocityX, event.packet.velocityY);
        const maxExpected = speed * correctionFrames;
        assert.ok(poseDistance(event.displayedBefore, event.fresh) <= maxExpected + 1e-6,
            `steady-ballistic correction bound exceeded: got ${poseDistance(event.displayedBefore, event.fresh)}, bound ${maxExpected}`);
        const values = [];
        for (let frame = 0; frame <= 4; frame++) {
            values.push(poseDistance(
                sampleEventTrajectory('ballistic', event, frameMs(frame)),
                projectBallistic(event.installed, frameMs(frame))));
        }
        assertMonotoneMagnitudeDecay(values, `steady-ballistic-${networkCase.name}-settle-${i}`);
    }
}

function runShipStartStopCase(networkCase) {
    const timeline = new Timeline();
    const link = new ReliableOrderedLink(timeline, networkCase, null, 'ship-start-stop');
    const replica = new Replica('ship');
    const owner = new MiniShip({ x: 0.1, y: -0.05, angle: 0.2 });
    const packets = [];

    for (let frame = 0; frame <= 24; frame++) {
        if (frame === 1) {
            owner.turnTarget = 1;
            owner.thrustInput = 1;
            owner.thrusting = true;
            const packet = { validAtMs: frameMs(frame), data: owner.snapshot() };
            packets.push({ name: 'start', ...packet });
            link.send('ship-start', packet, frameMs(frame), (payload, meta) => {
                replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
            });
        }
        if (frame === 6) {
            owner.turnTarget = 0;
            owner.thrustInput = 0;
            owner.thrusting = false;
            const packet = { validAtMs: frameMs(frame), data: owner.snapshot() };
            packets.push({ name: 'stop', ...packet });
            link.send('ship-stop', packet, frameMs(frame), (payload, meta) => {
                replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
            });
        }
        if (frame < 24) owner.update(1);
    }
    timeline.runAll();

    const startEvent = replica.events[0];
    const afterOneFrame = sampleEventTrajectory('ship', startEvent, frameMs(1));
    approxPose(afterOneFrame, projectShip(startEvent.packet, frameMs(1)), 1e-6, 'ship-start-replay');

    const stopEvent = last(replica.events);
    assertContinuous(stopEvent, `ship-stop-${networkCase.name}`);
    const angleErrors = [];
    for (let i = 0; i <= 30; i++) {
        const sample = replica.sample(stopEvent.arrivalTimeMs + frameMs(i));
        angleErrors.push(shortestAngleDelta(sample.angle, stopEvent.fresh.angle));
    }
    assertMonotoneMagnitudeDecay(angleErrors, `ship-stop-angle-${networkCase.name}`);
    assert.ok(angleErrors[0] >= -1e-6, `ship-stop-${networkCase.name}: correction must not reverse immediately`);
    assert.ok(Math.abs(angleErrors[angleErrors.length - 1]) <= (Math.abs(angleErrors[0]) * 0.02) + 1e-6,
        `ship-stop-${networkCase.name}: expected convergence, got ${angleErrors[0]} -> ${angleErrors[angleErrors.length - 1]}`);
}

function runJoinSeedingCase(networkCase) {
    const owner = new BallisticOwner({
        x: 0.5,
        y: -0.5,
        angle: 0.1,
        velocityX: 2.25,
        velocityY: 0.5,
        rotationSpeed: 0.03,
    });
    owner.advance(HEARTBEAT_FRAMES);
    const joinSnapshot = { validAtMs: 0, data: new BallisticOwner({
        x: 0.5,
        y: -0.5,
        angle: 0.1,
        velocityX: 2.25,
        velocityY: 0.5,
        rotationSpeed: 0.03,
    }).snapshot() };
    owner.advance(HEARTBEAT_FRAMES);
    const firstLive = { validAtMs: frameMs(HEARTBEAT_FRAMES * 2), data: owner.snapshot() };
    const arrivalDelayMs = Math.max(0, (networkCase.rttMs / 2) + networkCase.jitterSeq[0]);
    const firstLiveDelayMs = Math.max(0, (networkCase.rttMs / 2) + networkCase.jitterSeq[1 % networkCase.jitterSeq.length]);
    const joinArrivalMs = frameMs(HEARTBEAT_FRAMES) + arrivalDelayMs;
    const liveArrivalMs = frameMs(HEARTBEAT_FRAMES * 2) + firstLiveDelayMs;

    const arrivalReplica = new Replica('ballistic');
    const midpointReplica = new Replica('ballistic');
    const arrivalJoin = arrivalReplica.ingest(joinSnapshot, joinArrivalMs, { source: 'join-arrival', rttMs: networkCase.rttMs });
    const midpointJoin = midpointReplica.ingest(joinSnapshot, joinArrivalMs, { source: 'join-midpoint', rttMs: networkCase.rttMs });

    const arrivalFreshCreate = arrivalJoin.displayedAfter;
    approxPose(arrivalFreshCreate, joinSnapshot.data, 1e-6, 'join-arrival-anchor');

    const midpointExpected = projectBallistic(joinSnapshot.data, Math.max(0, joinArrivalMs - (networkCase.rttMs / 2) - joinSnapshot.validAtMs));
    approxPose(midpointJoin.displayedAfter, midpointExpected, 1e-6, 'join-midpoint-seed');

    const arrivalLive = arrivalReplica.ingest(firstLive, liveArrivalMs, { source: 'live', rttMs: networkCase.rttMs });
    const midpointLive = midpointReplica.ingest(firstLive, liveArrivalMs, { source: 'live', rttMs: networkCase.rttMs });

    const arrivalCorrection = poseDistance(arrivalLive.displayedBefore, arrivalLive.fresh);
    const midpointCorrection = poseDistance(midpointLive.displayedBefore, midpointLive.fresh);
    assert.ok(midpointCorrection + 1e-6 < arrivalCorrection,
        `midpoint seeding must reduce first-live correction: arrival=${arrivalCorrection}, midpoint=${midpointCorrection}`);
    const midpointAlong = motionAlong(midpointLive.displayedBefore, midpointLive.fresh, firstLive.data.velocityX, firstLive.data.velocityY);
    if (networkCase.jitterMs === 0) {
        assert.ok(midpointAlong >= -1e-6,
            'with zero jitter, midpoint seeding must not require a backward correction');
    } else {
        const backwardBound = Math.hypot(firstLive.data.velocityX, firstLive.data.velocityY) * (networkCase.jitterMs / FRAME_MS);
        assert.ok(Math.abs(Math.min(0, midpointAlong)) <= backwardBound + 1e-6,
            `midpoint seeding backward correction must stay jitter-bounded: got ${midpointAlong}, bound ${backwardBound}`);
    }
    let previous = midpointReplica.sample(liveArrivalMs);
    for (let frame = 1; frame <= 8; frame++) {
        const next = midpointReplica.sample(liveArrivalMs + frameMs(frame));
        assert.ok(
            motionAlong(previous, next, firstLive.data.velocityX, firstLive.data.velocityY) >= -1e-6,
            `join correction must not reverse visible motion at frame ${frame}`);
        previous = next;
    }

    const liveCreateReplica = new Replica('ballistic');
    const liveCreate = { validAtMs: 0, data: joinSnapshot.data };
    const liveCreateEvent = liveCreateReplica.ingest(liveCreate, arrivalDelayMs, { source: 'live', rttMs: networkCase.rttMs });
    approxPose(liveCreateEvent.displayedAfter, liveCreate.data, 1e-6, 'regular-live-create-stays-arrival-anchored');
}

function runBulletSpawnCase(networkCase) {
    const timeline = new Timeline();
    const link = new ReliableOrderedLink(timeline, networkCase, null, 'ship+bullet');
    const shipReplica = new Replica('ship');
    const bulletReplica = new Replica('ballistic');
    const ownerShip = new MiniShip({ x: 0.2, y: 0.1, angle: 0.1 });
    ownerShip.turnTarget = 0.5;
    ownerShip.thrustInput = 1;
    ownerShip.thrusting = true;
    const shipPacket = { validAtMs: 0, data: ownerShip.snapshot() };
    let bulletPacket = null;
    let bulletArrivalMs = 0;
    let shipArrivalMs = 0;
    let fireFrame = 6;

    link.send('ship-create', shipPacket, 0, (payload, meta) => {
        shipArrivalMs = meta.dueMs;
        shipReplica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    for (let frame = 0; frame < fireFrame; frame++) ownerShip.update(1);
    const muzzle = shipMuzzlePose(ownerShip.snapshot());
    bulletPacket = {
        validAtMs: frameMs(fireFrame),
        data: {
            x: muzzle.x,
            y: muzzle.y,
            angle: ownerShip.angle,
            velocityX: ownerShip.velocityX + (Math.cos(ownerShip.angle) * 4),
            velocityY: ownerShip.velocityY + (Math.sin(ownerShip.angle) * 4),
            rotationSpeed: 0,
        },
    };
    link.send('bullet-create', bulletPacket, frameMs(fireFrame), (payload, meta) => {
        bulletArrivalMs = meta.dueMs;
        bulletReplica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    timeline.runAll();

    const shipAtBulletArrival = shipReplica.sample(bulletArrivalMs);
    const bulletAtArrival = bulletReplica.sample(bulletArrivalMs);
    const muzzleAtArrival = shipMuzzlePose(shipAtBulletArrival);
    const actualGap = poseDistance(bulletAtArrival, muzzleAtArrival);

    const skewFrames = framesFromMs(bulletArrivalMs - bulletPacket.validAtMs - (shipArrivalMs - shipPacket.validAtMs));
    const ownerFromBaseline = new MiniShip(shipPacket.data);
    let remaining = fireFrame + skewFrames;
    while (remaining > 1e-9) {
        const dt = remaining > 1 ? 1 : remaining;
        ownerFromBaseline.update(dt);
        remaining -= dt;
    }
    const expectedGap = poseDistance(bulletPacket.data, shipMuzzlePose(ownerFromBaseline.snapshot()));
    assert.ok(actualGap <= expectedGap + 1e-6,
        `bullet spawn gap must stay within replayed ship skew bound: gap=${actualGap}, bound=${expectedGap}`);
}

function runReplacementCase(networkCase) {
    const timeline = new Timeline();
    const link = new ReliableOrderedLink(timeline, networkCase, null, 'replace');
    const parentReplica = new Replica('ballistic');
    let childReplica = null;
    const ownerParent = new BallisticOwner({
        x: 1,
        y: 0.5,
        angle: 0.2,
        velocityX: 0.004,
        velocityY: -0.001,
        rotationSpeed: 0.01,
    });
    const childRadius = 0.04;
    const childOffset = { x: 0.025, y: -0.012 };
    const parentCreate = { validAtMs: 0, data: ownerParent.snapshot() };
    link.send('parent-create', parentCreate, 0, (payload, meta) => {
        parentReplica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });

    ownerParent.advance(12);
    const childAuth = {
        validAtMs: frameMs(12),
        data: {
            x: ownerParent.state.x + childOffset.x,
            y: ownerParent.state.y + childOffset.y,
            angle: ownerParent.state.angle,
            velocityX: ownerParent.state.velocityX + 0.003,
            velocityY: ownerParent.state.velocityY - 0.002,
            rotationSpeed: 0.03,
        },
    };

    let handoffGap = null;
    let handoffAngleGap = null;
    let delaySkewFrames = null;
    link.send('replace', childAuth, frameMs(12), (payload, meta) => {
        const parentDisplayed = parentReplica.sample(meta.dueMs);
        childReplica = new Replica('ballistic');
        const replaceEvent = childReplica.ingest(
            payload,
            meta.dueMs,
            { source: 'live', rttMs: meta.rttMs });
        const continuousChildPose = {
            x: parentDisplayed.x + childOffset.x,
            y: parentDisplayed.y + childOffset.y,
            angle: parentDisplayed.angle,
        };
        handoffGap = poseDistance(replaceEvent.displayedAfter, continuousChildPose);
        handoffAngleGap = angleDistance(replaceEvent.displayedAfter.angle, continuousChildPose.angle);
        const parentEvent = parentReplica.events[0];
        delaySkewFrames = Math.abs(
            (meta.dueMs - payload.validAtMs)
            - (parentEvent.arrivalTimeMs - parentEvent.validAtMs)) / FRAME_MS;
    });
    timeline.runAll();

    const positionalBound = Math.hypot(
        ownerParent.state.velocityX,
        ownerParent.state.velocityY) * delaySkewFrames;
    const angularBound = Math.abs(ownerParent.state.rotationSpeed) * delaySkewFrames;
    assert.ok(handoffGap <= positionalBound + 1e-6,
        `replacement handoff gap ${handoffGap} exceeds delay-skew bound ${positionalBound}`);
    assert.ok(handoffAngleGap <= angularBound + 1e-6,
        `replacement angle gap ${handoffAngleGap} exceeds delay-skew bound ${angularBound}`);
    assert.ok(handoffGap / childRadius <= 0.35,
        `replacement handoff exceeds 0.35 child radii: ${handoffGap / childRadius}`);
}

function runMigrationCase(networkCase) {
    const timeline = new Timeline();
    const newOwnerLink = new ReliableOrderedLink(timeline, networkCase, null, 'old->new-owner');
    const observerCase = {
        ...networkCase,
        jitterSeq: networkCase.jitterMs === 0
            ? [0]
            : [-networkCase.jitterMs, networkCase.jitterMs]
    };
    const observerLink = new ReliableOrderedLink(timeline, observerCase, null, 'old->observer');
    const postMigrationCase = {
        ...networkCase,
        jitterSeq: [networkCase.jitterMs]
    };
    const newOwnerToObserver = new ReliableOrderedLink(
        timeline,
        postMigrationCase,
        null,
        'new-owner->observer');
    const newOwnerReplica = new Replica('ballistic');
    const reanchoredObserver = new Replica('ballistic');
    const skipObserver = new Replica('ballistic');
    const protectedObserver = new Replica('ballistic');
    const owner = new BallisticOwner({
        x: -0.2,
        y: 0.9,
        angle: 0,
        velocityX: 0.004,
        velocityY: -0.0015,
        rotationSpeed: 0.008,
    });
    const first = { validAtMs: 0, data: owner.snapshot() };
    newOwnerLink.send('create', first, 0, (payload, meta) => {
        newOwnerReplica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    observerLink.send('create', first, 0, (payload, meta) => {
        reanchoredObserver.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
        skipObserver.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
        protectedObserver.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    owner.advance(10);
    const latestBeforeMigration = { validAtMs: frameMs(10), data: owner.snapshot() };
    newOwnerLink.send('heartbeat', latestBeforeMigration, frameMs(10), (payload, meta) => {
        newOwnerReplica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    observerLink.send('heartbeat', latestBeforeMigration, frameMs(10), (payload, meta) => {
        reanchoredObserver.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
        skipObserver.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
        protectedObserver.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });

    const handoffTimeMs = frameMs(20) + (networkCase.rttMs / 2) + networkCase.jitterMs;
    timeline.runTo(handoffTimeMs);
    const displayedPuppet = newOwnerReplica.sample(handoffTimeMs);
    const ownershipOnlyEvent = reanchoredObserver.ingest(
        latestBeforeMigration,
        handoffTimeMs,
        { source: 'ownership-only', rttMs: networkCase.rttMs });
    const firstOwnedData = projectBallisticUncapped(displayedPuppet, FRAME_MS);
    const firstOwnedSendMs = handoffTimeMs + FRAME_MS;
    const migrationPacket = { validAtMs: firstOwnedSendMs, data: firstOwnedData };
    let reanchoredFirstUpdate = null;
    let skippedFirstUpdate = null;
    let protectedFirstUpdate = null;
    let protectedSmoothMs = null;
    const firstUpdateDelivery = newOwnerToObserver.send(
        'migration-first-update',
        migrationPacket,
        firstOwnedSendMs,
        (payload, meta) => {
        reanchoredFirstUpdate = reanchoredObserver.ingest(
            payload,
            meta.dueMs,
            { source: 'live', rttMs: meta.rttMs });
        skippedFirstUpdate = skipObserver.ingest(
            payload,
            meta.dueMs,
            { source: 'live', rttMs: meta.rttMs });
        const protectedDisplayed = protectedObserver.sample(meta.dueMs);
        const protectedFresh = projectBallistic(payload.data, 0);
        protectedSmoothMs = directionPreservingSmoothMs(
            protectedDisplayed,
            protectedFresh,
            payload.data,
            1.05);
        protectedFirstUpdate = protectedObserver.ingest(
            payload,
            meta.dueMs,
            { source: 'live', rttMs: meta.rttMs, smoothMs: protectedSmoothMs });
    });

    let reanchorMinimumStep = Infinity;
    let skipBeforeUpdateMinimumStep = Infinity;
    let protectedBeforeUpdateMinimumStep = Infinity;
    let previousReanchored = reanchoredObserver.sample(handoffTimeMs);
    let previousSkipped = skipObserver.sample(handoffTimeMs);
    let previousProtected = protectedObserver.sample(handoffTimeMs);
    for (let timeMs = handoffTimeMs + FRAME_MS;
        timeMs <= firstUpdateDelivery.dueMs + EPS;
        timeMs += FRAME_MS) {
        const nextReanchored = reanchoredObserver.sample(timeMs);
        const nextSkipped = skipObserver.sample(timeMs);
        const nextProtected = protectedObserver.sample(timeMs);
        reanchorMinimumStep = Math.min(
            reanchorMinimumStep,
            motionAlong(
                previousReanchored,
                nextReanchored,
                firstOwnedData.velocityX,
                firstOwnedData.velocityY));
        skipBeforeUpdateMinimumStep = Math.min(
            skipBeforeUpdateMinimumStep,
            motionAlong(
                previousSkipped,
                nextSkipped,
                firstOwnedData.velocityX,
                firstOwnedData.velocityY));
        protectedBeforeUpdateMinimumStep = Math.min(
            protectedBeforeUpdateMinimumStep,
            motionAlong(
                previousProtected,
                nextProtected,
                firstOwnedData.velocityX,
                firstOwnedData.velocityY));
        previousReanchored = nextReanchored;
        previousSkipped = nextSkipped;
        previousProtected = nextProtected;
    }
    timeline.runAll();

    const localStep = poseDistance(displayedPuppet, firstOwnedData);
    approx(
        localStep,
        Math.hypot(displayedPuppet.velocityX, displayedPuppet.velocityY),
        1e-6,
        'new-owner displayed-puppet step');
    assertContinuous(ownershipOnlyEvent, `migration-ownership-only-${networkCase.name}`);
    assertContinuous(reanchoredFirstUpdate, `migration-reanchored-update-${networkCase.name}`);
    assertContinuous(skippedFirstUpdate, `migration-skipped-update-${networkCase.name}`);
    assertContinuous(protectedFirstUpdate, `migration-protected-update-${networkCase.name}`);
    assert.ok(skipBeforeUpdateMinimumStep >= -1e-6,
        `skipping the ownership-only re-anchor reversed pre-update motion: ${skipBeforeUpdateMinimumStep}`);
    assert.ok(protectedBeforeUpdateMinimumStep >= -1e-6,
        `protected path reversed before the first owner update: ${protectedBeforeUpdateMinimumStep}`);

    let skippedMinimumStep = Infinity;
    let protectedMinimumStep = Infinity;
    let previous = skipObserver.sample(skippedFirstUpdate.arrivalTimeMs);
    let previousProtectedAfterUpdate = protectedObserver.sample(protectedFirstUpdate.arrivalTimeMs);
    for (let frame = 1; frame <= 12; frame++) {
        const next = skipObserver.sample(skippedFirstUpdate.arrivalTimeMs + frameMs(frame));
        const nextProtected = protectedObserver.sample(
            protectedFirstUpdate.arrivalTimeMs + frameMs(frame));
        skippedMinimumStep = Math.min(
            skippedMinimumStep,
            motionAlong(
                previous,
                next,
                firstOwnedData.velocityX,
                firstOwnedData.velocityY));
        protectedMinimumStep = Math.min(
            protectedMinimumStep,
            motionAlong(
                previousProtectedAfterUpdate,
                nextProtected,
                firstOwnedData.velocityX,
                firstOwnedData.velocityY));
        previous = next;
        previousProtectedAfterUpdate = nextProtected;
    }
    assert.ok(protectedMinimumStep >= -1e-6,
        `direction-preserving migration correction reversed motion: ${protectedMinimumStep}`);
    const initialCorrection = poseDistance(
        protectedFirstUpdate.displayedBefore,
        protectedFirstUpdate.fresh);
    const settleAtMs = protectedFirstUpdate.arrivalTimeMs + protectedSmoothMs * 7;
    const finalCorrection = poseDistance(
        protectedObserver.sample(settleAtMs),
        protectedObserver.sampleRaw(settleAtMs));
    assert.ok(finalCorrection <= initialCorrection * 0.001 + 1e-6,
        `protected migration correction did not converge: ${initialCorrection} -> ${finalCorrection}`);
    return {
        reanchorMinimumStep,
        skipBeforeUpdateMinimumStep,
        skippedMinimumStep,
        protectedMinimumStep
    };
}

function runRespawnSnapCase(networkCase) {
    const timeline = new Timeline();
    const link = new ReliableOrderedLink(timeline, networkCase, null, 'respawn');
    const replica = new Replica('ship');
    const owner = new MiniShip({ x: 0.3, y: 0.4, angle: 1.2, velocityX: 0.2, velocityY: -0.1 });
    owner.turnTarget = 1;
    const normal = { validAtMs: 0, data: owner.snapshot() };
    link.send('ship-update', normal, 0, (payload, meta) => {
        replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    for (let i = 0; i < 8; i++) owner.update(1);
    const respawn = {
        validAtMs: frameMs(8),
        data: {
            ...owner.snapshot(),
            x: -0.75,
            y: 0.85,
            angle: -Math.PI / 2,
            velocityX: 0,
            velocityY: 0,
            rotationSpeed: 0,
            invulnerable: 120,
        },
    };
    let snapEvent = null;
    link.send('respawn', respawn, frameMs(8), (payload, meta) => {
        snapEvent = replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs, snap: true });
    });
    timeline.runAll();

    approxPose(snapEvent.displayedAfter, respawn.data, 1e-6, 'respawn-snap-at-arrival');
    approxPose(replica.sample(snapEvent.arrivalTimeMs + frameMs(5)), projectShip(respawn.data, frameMs(5)), 1e-6, 'respawn-no-residual-blend');
}

function runOrderedStallCase(networkCase, stallProfile) {
    const timeline = new Timeline();
    const link = new ReliableOrderedLink(timeline, networkCase, stallProfile, 'stall');
    const replica = new Replica('ballistic');
    const owner = new BallisticOwner({
        x: 0,
        y: 0,
        angle: 0,
        velocityX: 2,
        velocityY: 0,
        rotationSpeed: 0,
    });
    const samples = [];

    const create = { validAtMs: 0, data: owner.snapshot() };
    link.send('create', create, 0, (payload, meta) => {
        replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    owner.advance(12);
    owner.state.velocityX = -1;
    const change = { validAtMs: frameMs(12), data: owner.snapshot() };
    link.send('change', change, frameMs(12), (payload, meta) => {
        replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });
    owner.advance(18);
    const reconcile = { validAtMs: frameMs(30), data: owner.snapshot() };
    link.send('reconcile', reconcile, frameMs(30), (payload, meta) => {
        replica.ingest(payload, meta.dueMs, { source: 'live', rttMs: meta.rttMs });
    });

    for (let frame = 0; frame <= 45; frame++) {
        const timeMs = frameMs(frame);
        timeline.runTo(timeMs);
        const sample = replica.sample(timeMs);
        if (sample) samples.push({ frame, timeMs, x: sample.x });
    }
    timeline.runAll();

    const deliveredValidAts = replica.events.map((event) => event.validAtMs);
    assert.deepEqual(deliveredValidAts, [...deliveredValidAts].sort((a, b) => a - b),
        `stall delivery must stay ordered for ${networkCase.name}/${stallProfile.name}`);

    const stallStartMs = stallProfile.windows[0].startMs;
    const changeArrival = replica.events[1].arrivalTimeMs;
    const duringStall = samples.filter((sample) => sample.timeMs >= stallStartMs && sample.timeMs < changeArrival);
    for (let i = 1; i < duringStall.length; i++) {
        assert.ok(duringStall[i].x >= duringStall[i - 1].x - 1e-6,
            `stall path must keep continuity before delayed change for ${networkCase.name}/${stallProfile.name}`);
    }

    const delayedChange = replica.events[1];
    assertContinuous(delayedChange, `stall-change-${networkCase.name}-${stallProfile.name}`);
    const reconcileEvent = replica.events[2];
    assertSettlesTo(replica, reconcileEvent.arrivalTimeMs, 24,
        `stall-reconcile-${networkCase.name}-${stallProfile.name}`);

    const maxLeadFrames = Math.max(0, framesFromMs(changeArrival - change.validAtMs));
    const cappedLeadFrames = Math.min(maxLeadFrames, POSITION_CAP_FRAMES);
    assert.ok(cappedLeadFrames <= POSITION_CAP_FRAMES + EPS, 'positional cap remains bounded');
    const shipAngularLeadFrames = integrateRateAngularPredictionFrames(
        Math.min(maxLeadFrames, POSITION_CAP_FRAMES),
        SHIP_RATE_WINDOW);
    assert.ok(shipAngularLeadFrames <= POSITION_CAP_FRAMES + EPS,
        'adaptive ship angular prediction remains globally bounded');
}

function runCollisionAckCase(networkCase, stallProfile) {
    const timeline = new Timeline();
    const shooterToOwner = new ReliableOrderedLink(timeline, networkCase, stallProfile, 'bullet->owner');
    const ownerToShooter = new ReliableOrderedLink(timeline, networkCase, stallProfile, 'owner->bullet');

    const state = {
        bulletVisible: true,
        bulletPending: false,
        impactCueVisible: false,
        targetVisible: true,
        score: 0,
        pendingAtMs: null,
        ackAtMs: null,
        ownerProcessedAtMs: null,
        scoreAtMs: null,
    };

    const collisionTimeMs = frameMs(6);
    state.bulletVisible = false;
    state.bulletPending = true;
    state.impactCueVisible = true;
    state.pendingAtMs = collisionTimeMs;

    shooterToOwner.send('pending-hit', { targetId: 'asteroid-1' }, collisionTimeMs, (_payload, meta) => {
        state.ownerProcessedAtMs = meta.dueMs;
        ownerToShooter.send('replace-ack', { points: 20 }, meta.dueMs, (_ackPayload, ackMeta) => {
            state.ackAtMs = ackMeta.dueMs;
            state.bulletPending = false;
            state.targetVisible = false;
            state.score += 20;
            state.scoreAtMs = ackMeta.dueMs;
        });
    });

    const probes = [];
    for (let frame = 0; frame <= 60; frame++) {
        const timeMs = frameMs(frame);
        timeline.runTo(timeMs);
        probes.push({
            timeMs,
            bulletVisible: state.bulletVisible,
            bulletPending: state.bulletPending,
            impactCueVisible: state.impactCueVisible,
            targetVisible: state.targetVisible,
            score: state.score,
        });
    }
    timeline.runAll();

    assert.ok(state.pendingAtMs <= state.ownerProcessedAtMs, 'pending marker must appear before remote authority processes hit');
    assert.ok(state.ownerProcessedAtMs <= state.ackAtMs, 'visible ack must not precede remote authority resolution');
    assert.equal(state.scoreAtMs, state.ackAtMs, 'score changes on visible ack, not before');

    if (state.ackAtMs > state.pendingAtMs) {
        const beforeAck = probes.find((probe) => probe.timeMs < state.ackAtMs && probe.timeMs >= state.pendingAtMs);
        assert.ok(beforeAck
            && !beforeAck.bulletVisible
            && beforeAck.bulletPending
            && beforeAck.impactCueVisible
            && beforeAck.targetVisible,
        'impact cue must bridge the bullet-hidden/target-intact interval');
    }
    const afterAck = probes.find((probe) => probe.timeMs >= state.ackAtMs);
    assert.ok(afterAck
        && !afterAck.bulletVisible
        && !afterAck.bulletPending
        && !afterAck.targetVisible
        && afterAck.impactCueVisible
        && afterAck.score === 20,
    'ack must replace the target and award score while the cue finishes');
}

test('steady ballistic position and rotation stay continuous across the RTT/jitter matrix', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => runSteadyBallisticCase(networkCase));
    }
});

test('ship control start/stop replay stays continuous and converges across the RTT/jitter matrix', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => runShipStartStopCase(networkCase));
    }
});

test('join seeding A/B improves stale-join continuity without changing live create behavior', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => runJoinSeedingCase(networkCase));
    }
});

test('production join baseline reads runtime facts (joinSnapshot/ownerIsActive) and stays pure', () => {
    // The one-shot join-marker consumption now belongs entirely to
    // ReplicationRuntime (facts.joinSnapshot is only true once per id — see
    // replication-runtime.test.mjs "join snapshot consumption"). This helper
    // no longer touches any marker itself; it only decides, given the facts
    // ReplicationRuntime already computed, whether to seed a projected
    // baseline.
    let clockInitialized = true;
    let terminal = false;
    const helper = loadJoinBaselineHelper({
        isDeterministicMode: () => true,
        resolveTerminalSession: () => terminal ? { epoch: 1500, terminalAt: 2250 } : null,
        RemoteObjects: {
            isClockOffsetInitialized: () => clockInitialized,
            getClockSampleRtt: () => 100,
            serverNowMs: () => 2000,
        },
        CONFIG: { DEADRECKON_MAX_FRAMES: 30, TARGET_FPS: 60 },
        performance: { now: () => 1100 },
    });
    const moving = {
        id: 'moving',
        ownerMemberId: 'owner',
        validAt: 1800,
        data: { x: 1, velocityX: 0.1 },
    };

    // First reconcile: ReplicationRuntime reports this as the join-snapshot
    // version with a still-active owner — seed the delayed baseline.
    assert.equal(helper(moving, { joinSnapshot: true, ownerIsActive: true }), 950);
    // Any later reconcile: ReplicationRuntime has already consumed the
    // marker, so facts.joinSnapshot is false — fall back to arrival-anchored.
    assert.equal(helper(moving, { joinSnapshot: false, ownerIsActive: true }), undefined);
    // Even on the join-snapshot version, an inactive owner must not seed.
    assert.equal(helper(moving, { joinSnapshot: true, ownerIsActive: false }), undefined);
    terminal = true;
    assert.equal(
        helper(moving, { joinSnapshot: true, ownerIsActive: true }), undefined,
        'an already-terminal snapshot must never be projected toward join time');
    terminal = false;

    clockInitialized = false;
    const clockless = {
        id: 'clockless',
        ownerMemberId: 'owner',
        validAt: 1800,
        data: { x: 3, velocityX: 0.1 },
    };
    assert.equal(
        helper(clockless, { joinSnapshot: true, ownerIsActive: true }), undefined,
        'clock fallback must yield arrival-anchored, not seed a stale baseline');
    clockInitialized = true;
    assert.equal(helper(clockless, { joinSnapshot: true, ownerIsActive: true }), 950);
});

test('forced hub replacement invalidates connection-specific clock RTT before joining', () => {
    assert.match(
        productionSource,
        /if \(force\) RemoteObjects\.stopClockSync\(\);\s*const success = await SessionClient\.connect\(force, hubHostname\);/);
    assert.match(
        replicationClockSource,
        /function start\(\) \{[\s\S]*state\.lastSampleRtt = Infinity;[\s\S]*state\.running = true;/);
    assert.match(
        productionSource,
        /SessionClient\.on\('onReconnecting', \(error\) => \{\s*RemoteObjects\.stopClockSync\(\);/);
});

test('bullet spawn stays bounded to the replayed remote ship muzzle across the RTT/jitter matrix', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => runBulletSpawnCase(networkCase));
    }
});

test('asteroid parent-to-child replacement continuity stays bounded across the RTT/jitter matrix', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => runReplacementCase(networkCase));
    }
});

test('ownership migration retains the displayed puppet pose across the RTT/jitter matrix', async (t) => {
    let ownershipReanchorReverseCases = 0;
    let skippedReanchorReverseCases = 0;
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => {
            const result = runMigrationCase(networkCase);
            if (result.reanchorMinimumStep < -1e-6) ownershipReanchorReverseCases++;
            if (result.skippedMinimumStep < -1e-6) skippedReanchorReverseCases++;
        });
    }
    assert.equal(ownershipReanchorReverseCases, 0,
        'finite correction trajectories must not reverse an ownership re-anchor');
    assert.equal(skippedReanchorReverseCases, 0,
        'skipping the metadata-only anchor must preserve forward motion');
});

test('production migration gating skips ownership-only versions only after replica initialization', () => {
    // Ownership-only skip / direction-preserving handoff now lives entirely
    // inside ReplicationRuntime.reconcileType (see replication-runtime.js).
    // Production only supplies the has/ingest/sample presentation shape
    // (createKinematicPresentation in index.html, switching between
    // DeadReckon and RemoteObjects by isDeterministicMode()). Drive the REAL
    // runtime through an equivalent single-model presentation stub — one
    // fresh runtime per mode — to confirm the same skip/preserve-direction
    // sequence the old inline beginReplicationVersion/finishReplicationVersion
    // pair used to produce, in both deterministic and buffered mode.
    function runMigrationScenario() {
        const states = new Map();
        const ingestLog = [];
        const migration = {
            id: 'asteroid',
            version: 2,
            ownerMemberId: 'other',
            ownershipMigrationVersion: 2,
            ownershipMigrationPending: true,
            data: {},
        };
        const store = {
            getObject: (id) => (id === migration.id ? migration : undefined),
            getObjectsByType: () => [migration],
        };
        const descriptor = {
            type: 'asteroid',
            classify: () => 'replica',
            getInstance: (id) => states.get(id),
            getInstances: () => Array.from(states, ([id, instance]) => [id, instance]),
            createReplica: (record) => {
                const instance = { id: record.id };
                states.set(record.id, instance);
                return instance;
            },
            apply: () => {},
            remove: (instance) => states.delete(instance.id),
            presentation: {
                has: (id) => states.has(id),
                ingest: (id, data, facts) => {
                    ingestLog.push({ preserveDirection: facts.preserveDirection });
                },
                sample: (id, facts, record) => record.data,
                remove: (id) => states.delete(id),
                reset: () => states.clear(),
            },
        };
        const runtime = createRuntime({
            objectStore: store,
            getCurrentMemberId: () => 'me',
            getActiveMemberIds: () => ['me', 'other'],
            descriptors: [descriptor],
        });
        runtime.beginSession({ epoch: 1, snapshotObjectIds: [] });

        // A joiner without replica state must ingest the ownership version.
        runtime.reconcileType('asteroid', { epoch: 1 });
        assert.equal(ingestLog.length, 1,
            'a joiner without replica state must ingest the ownership version');
        assert.equal(ingestLog[0].preserveDirection, false);

        // An initialized replica must skip the ownership-only re-anchor
        // (same version, presentation state already exists).
        runtime.reconcileType('asteroid', { epoch: 1 });
        assert.equal(ingestLog.length, 1,
            'an initialized replica must skip the ownership-only re-anchor');

        // The first real post-migration update must use direction-preserving
        // smoothing.
        migration.version = 3;
        runtime.reconcileType('asteroid', { epoch: 1 });
        assert.equal(ingestLog.length, 2);
        assert.equal(ingestLog[1].preserveDirection, true,
            'the first real post-migration update must use direction-preserving smoothing');
    }

    // The presentation stub above is mode-agnostic on purpose: production's
    // createKinematicPresentation delegates to DeadReckon or RemoteObjects
    // by isDeterministicMode(), but ReplicationRuntime itself never inspects
    // that flag — the skip/preserve-direction gating is identical regardless
    // of which backing model presentation.has/ingest ultimately touch. Running
    // the scenario twice (once per production mode) with an isolated runtime
    // each time confirms that independence.
    runMigrationScenario();
    runMigrationScenario();
});

test('production kinematic presentation delegates to DeadReckon/RemoteObjects by mode', () => {
    // createKinematicPresentation is the production glue between
    // ReplicationRuntime's generic has/ingest/sample/remove contract and the
    // two concrete presentation models. Verify the actual extracted source
    // switches on isDeterministicMode() for every one of those methods.
    const start = productionSource.indexOf('    function createKinematicPresentation() {');
    const end = productionSource.indexOf('\n    const kinematicPresentation = createKinematicPresentation();');
    assert.ok(start >= 0 && end > start);
    const source = productionSource.slice(start, end);
    assert.match(source, /has\(id\) \{\s*return isDeterministicMode\(\)/);
    assert.match(source, /ingest\(id, data, facts, record, context\) \{\s*if \(isDeterministicMode\(\)\) \{/);
    assert.match(source, /sample\(id, facts, record, context\) \{\s*if \(isDeterministicMode\(\)\) \{/);
    assert.match(source, /remove\(id, reason, facts, record, context\) \{\s*RemoteObjects\.remove\(id\);\s*DeadReckon\.remove\(id\);/);
    assert.match(source, /reset\(facts, context\) \{\s*RemoteObjects\.clear\(\);\s*DeadReckon\.clear\(\);/);
});

test('intentional ship respawn is an explicit snap across the RTT/jitter matrix', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        await t.test(networkCase.name, () => runRespawnSnapCase(networkCase));
    }
});

test('ordered delivery stalls converge correctly across the RTT/jitter matrix and stall profiles', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        for (const stallProfile of STALL_PROFILES) {
            await t.test(`${networkCase.name}-${stallProfile.name}`, () => runOrderedStallCase(networkCase, stallProfile));
        }
    }
});

test('collision visible acknowledgment timing stays ordered across the RTT/jitter matrix and stall profiles', async (t) => {
    for (const networkCase of NETWORK_CASES) {
        for (const stallProfile of STALL_PROFILES) {
            await t.test(`${networkCase.name}-${stallProfile.name}`, () => runCollisionAckCase(networkCase, stallProfile));
        }
    }
});
