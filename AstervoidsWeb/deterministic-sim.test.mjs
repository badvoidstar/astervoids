import { test } from 'node:test';
import assert from 'node:assert/strict';

// These mirror the inline deterministic-simulation helpers in
// wwwroot/index.html (the game layer). Per the repo convention (see
// config-overrides.test.mjs), pure inline logic is re-implemented here and
// asserted, since index.html is not a importable module.

// ── Mode normalization (mirrors normalizeSimMode) ───────────────────────────
const SIM_MODES = { LEGACY: 'legacy', DETERMINISTIC: 'deterministic' };
const VALID_SIM_MODES = new Set(Object.values(SIM_MODES));
function normalizeSimMode(raw) {
    if (typeof raw === 'string') {
        const n = raw.toLowerCase();
        if (VALID_SIM_MODES.has(n)) return n;
    }
    return SIM_MODES.LEGACY;
}

// ── Seeded RNG (mirrors makeSeededRandom + simRng) ──────────────────────────
function makeSeededRandom(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Render interpolation (mirrors interpNormalized / interpAngle) ───────────
function interpNormalized(prev, curr, alpha, range = 1) {
    let d = curr - prev;
    if (d > 0.5) d -= range;
    else if (d < -0.5) d += range;
    return prev + d * alpha;
}
function interpAngle(prev, curr, alpha) {
    let d = curr - prev;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return prev + d * alpha;
}

// ── Fixed-timestep accumulator (mirrors gameLoop's deterministic branch) ────
function stepFixed(accumulatorMs, elapsed, stepMs, maxSteps, maxAccum) {
    accumulatorMs = Math.min(accumulatorMs + elapsed, maxAccum);
    let steps = 0;
    while (accumulatorMs >= stepMs && steps < maxSteps) {
        accumulatorMs -= stepMs;
        steps++;
    }
    if (steps === maxSteps) accumulatorMs = 0;
    const alpha = stepMs > 0 ? Math.min(accumulatorMs / stepMs, 1) : 1;
    return { steps, accumulatorMs, alpha };
}

// ── Dead-reckoning integrator (mirrors DeadReckon.getReckoned) ──────────────
function reckon(state, nowPerf, stepMs, maxFrames, velToDeltaX, velToDeltaY) {
    let frames = stepMs > 0 ? (nowPerf - state.recvPerf) / stepMs : 0;
    if (!(frames > 0)) frames = 0;
    if (frames > maxFrames) frames = maxFrames;
    const out = {
        x: state.x,
        y: state.y,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        rotationSpeed: state.rotationSpeed,
    };
    if (frames > 0) {
        out.x = state.x + velToDeltaX(state.velocityX) * frames;
        out.y = state.y + velToDeltaY(state.velocityY) * frames;
    }
    if (state.angle !== null && state.angle !== undefined) {
        out.angle = state.angle + state.rotationSpeed * frames;
    }
    return out;
}

// ───────────────────────────────── tests ───────────────────────────────────

test('normalizeSimMode: accepts known modes case-insensitively, defaults legacy', () => {
    assert.equal(normalizeSimMode('deterministic'), 'deterministic');
    assert.equal(normalizeSimMode('DETERMINISTIC'), 'deterministic');
    assert.equal(normalizeSimMode('legacy'), 'legacy');
    assert.equal(normalizeSimMode('nonsense'), 'legacy');
    assert.equal(normalizeSimMode(undefined), 'legacy');
    assert.equal(normalizeSimMode(42), 'legacy');
});

test('seeded RNG: same seed yields identical sequence (reproducible)', () => {
    const a = makeSeededRandom(12345);
    const b = makeSeededRandom(12345);
    for (let i = 0; i < 100; i++) {
        assert.equal(a(), b());
    }
});

test('seeded RNG: different seeds diverge', () => {
    const a = makeSeededRandom(1);
    const b = makeSeededRandom(2);
    let differing = 0;
    for (let i = 0; i < 50; i++) {
        if (a() !== b()) differing++;
    }
    assert.ok(differing > 40, 'expected most draws to differ across seeds');
});

test('seeded RNG: outputs are within [0, 1)', () => {
    const r = makeSeededRandom(999);
    for (let i = 0; i < 1000; i++) {
        const v = r();
        assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
    }
});

test('seeded RNG: seed 0 is treated as 1 (no zero-lock)', () => {
    const a = makeSeededRandom(0);
    const b = makeSeededRandom(1);
    assert.equal(a(), b());
});

test('interpNormalized: midpoint without wrap', () => {
    assert.ok(Math.abs(interpNormalized(0.2, 0.4, 0.5) - 0.3) < 1e-9);
});

test('interpNormalized: takes short way across wrap boundary 0.95 -> 0.05', () => {
    // Forward wrap: prev 0.95, curr 0.05 (crossed 1.0). Short path increases
    // through 1.0; at alpha 0.25 we land at 0.975.
    const v = interpNormalized(0.95, 0.05, 0.25);
    assert.ok(Math.abs(v - 0.975) < 1e-9, `got ${v}`);
});

test('interpNormalized: short way across wrap boundary 0.05 -> 0.95', () => {
    // Backward wrap: prev 0.05, curr 0.95. Short path decreases toward 0.0;
    // at alpha 0.25 we land at 0.025.
    const v = interpNormalized(0.05, 0.95, 0.25);
    assert.ok(Math.abs(v - 0.025) < 1e-9, `got ${v}`);
});

test('interpNormalized: stays wrap-continuous near edges without snapping inward', () => {
    // The blended value may sit slightly outside [0,1) near a wrap (that is the
    // whole point: an object glides just off one edge before the sim wraps it).
    // It must never sweep the long way around, so it stays within a small band.
    for (let p = 0; p < 1; p += 0.13) {
        for (let c = 0; c < 1; c += 0.17) {
            const v = interpNormalized(p, c, 0.5);
            assert.ok(v > -0.5 && v < 1.5, `value ${v} swept too far`);
        }
    }
});

test('interpNormalized: an object just past the right edge is NOT teleported left', () => {
    // prev 0.99 -> curr 1.02 (still gliding off the right edge, no wrap). The
    // interpolated value must remain just past 1.0, not be clamped back to ~0.
    const v = interpNormalized(0.99, 1.02, 0.5);
    assert.ok(v > 1.0 && v < 1.05, `expected just past right edge, got ${v}`);
});

test('interpNormalized: across a wrap, motion stays forward (no one-frame backward hitch)', () => {
    // margin 0.02 -> wrap span range = 1.04. Object at 1.02 moving +0.03 wraps
    // to 0.01. Interpolating with range=1.04 must carry it FORWARD past 1.02
    // (toward 1.05/off-edge), never backward to ~1.01.
    const range = 1.04;
    const vMid = interpNormalized(1.02, 0.01, 0.5, range);
    assert.ok(vMid > 1.02, `expected forward motion past 1.02, got ${vMid}`);
    // Monotonic forward across the whole alpha sweep.
    let last = 1.02;
    for (let a = 0; a <= 1.0001; a += 0.1) {
        const v = interpNormalized(1.02, 0.01, a, range);
        assert.ok(v >= last - 1e-9, `non-monotonic at alpha ${a}: ${v} < ${last}`);
        last = v;
    }
});

test('interpNormalized: bare range=1 leaves a backward error at the seam (regression guard)', () => {
    // Demonstrates why the range argument matters: with range=1 the same wrap
    // drifts backward (1.02 -> 1.01), which is the one-frame hitch we fixed.
    const vBad = interpNormalized(1.02, 0.01, 0.5, 1);
    assert.ok(vBad < 1.02, 'sanity: range=1 regresses (backward)');
    const vGood = interpNormalized(1.02, 0.01, 0.5, 1.04);
    assert.ok(vGood > 1.02, 'range=1.04 corrects it (forward)');
});

test('interpAngle: shortest arc across -pi/pi seam', () => {
    const prev = 3.0;          // ~172deg
    const curr = -3.0;         // ~-172deg; short arc is +0.28 rad through pi
    const v = interpAngle(prev, curr, 0.5);
    // Halfway along the short (+) arc from 3.0: 3.0 + 0.5*0.28319 ≈ 3.1416
    assert.ok(Math.abs(Math.atan2(Math.sin(v), Math.cos(v))) > 3.0,
        `expected near pi, got ${v}`);
});

test('interpAngle: alpha 0 and 1 return endpoints', () => {
    assert.ok(Math.abs(interpAngle(0.4, 1.2, 0) - 0.4) < 1e-9);
    assert.ok(Math.abs(interpAngle(0.4, 1.2, 1) - 1.2) < 1e-9);
});

test('stepFixed: 16.67ms elapsed at 60Hz yields exactly one step', () => {
    const stepMs = 1000 / 60;
    const r = stepFixed(0, stepMs, stepMs, 5, 250);
    assert.equal(r.steps, 1);
    assert.ok(Math.abs(r.accumulatorMs) < 1e-9);
    assert.ok(Math.abs(r.alpha) < 1e-9);
});

test('stepFixed: partial frame produces zero steps and fractional alpha', () => {
    const stepMs = 1000 / 60;
    const r = stepFixed(0, stepMs / 2, stepMs, 5, 250);
    assert.equal(r.steps, 0);
    assert.ok(Math.abs(r.alpha - 0.5) < 1e-9);
});

test('stepFixed: accumulates leftover across frames', () => {
    const stepMs = 1000 / 60;
    // Two 10ms frames = 20ms total -> one step (16.67ms), ~3.33ms leftover.
    let acc = 0;
    let r = stepFixed(acc, 10, stepMs, 5, 250);
    assert.equal(r.steps, 0);
    r = stepFixed(r.accumulatorMs, 10, stepMs, 5, 250);
    assert.equal(r.steps, 1);
    assert.ok(r.accumulatorMs > 0 && r.accumulatorMs < stepMs);
});

test('stepFixed: clamps to maxSteps and drops backlog (spiral-of-death guard)', () => {
    const stepMs = 1000 / 60;
    // A huge stall: 1000ms but capped at maxAccum 250ms -> 15 steps worth, but
    // maxSteps=5 caps it and the remainder is dropped.
    const r = stepFixed(0, 1000, stepMs, 5, 250);
    assert.equal(r.steps, 5);
    assert.equal(r.accumulatorMs, 0);
    assert.equal(r.alpha, 0);
});

test('reckon: zero elapsed returns the authoritative snapshot unchanged', () => {
    const stepMs = 1000 / 60;
    const state = { x: 0.5, y: 0.5, angle: 1.0, velocityX: 0.1, velocityY: -0.2, rotationSpeed: 0.05, recvPerf: 1000 };
    const out = reckon(state, 1000, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.equal(out.x, 0.5);
    assert.equal(out.y, 0.5);
    assert.equal(out.angle, 1.0);
});

test('reckon: integrates by constant velocity/rotation over elapsed frames', () => {
    const stepMs = 1000 / 60;
    const state = { x: 0.5, y: 0.5, angle: 0.0, velocityX: 1, velocityY: 2, rotationSpeed: 0.1, recvPerf: 0 };
    // 3 frames elapsed.
    const out = reckon(state, 3 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.ok(Math.abs(out.x - (0.5 + 0.01 * 1 * 3)) < 1e-9);
    assert.ok(Math.abs(out.y - (0.5 + 0.01 * 2 * 3)) < 1e-9);
    assert.ok(Math.abs(out.angle - (0.1 * 3)) < 1e-9);
});

test('reckon: clamps to maxFrames so packet loss cannot fling a replica away', () => {
    const stepMs = 1000 / 60;
    const state = { x: 0, y: 0, angle: null, velocityX: 1, velocityY: 0, rotationSpeed: 0, recvPerf: 0 };
    // 1000 frames elapsed but clamp at 30.
    const out = reckon(state, 1000 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.ok(Math.abs(out.x - (0.01 * 1 * 30)) < 1e-9);
    assert.ok(!('angle' in out), 'angle omitted when state.angle is null');
});

test('reckon: a fresh authoritative packet snaps (resets recvPerf baseline)', () => {
    const stepMs = 1000 / 60;
    // Reckoned far from snapshot...
    let state = { x: 0, y: 0, angle: 0, velocityX: 1, velocityY: 0, rotationSpeed: 0, recvPerf: 0 };
    const drifted = reckon(state, 10 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.ok(drifted.x > 0);
    // New packet arrives: snapshot replaced, recvPerf reset to "now".
    state = { x: 0.42, y: 0.7, angle: 0.0, velocityX: 1, velocityY: 0, rotationSpeed: 0, recvPerf: 10 * stepMs };
    const snapped = reckon(state, 10 * stepMs, stepMs, 30, v => v * 0.01, v => v * 0.01);
    assert.equal(snapped.x, 0.42);
    assert.equal(snapped.y, 0.7);
});

// ── Dead-reckon baseline anchoring (arrival-anchored: render authoritative truth)
//
// DeadReckon.updateState anchors recvPerf at ARRIVAL (performance.now() when the
// packet's version change is applied), NOT at the owner's authoring instant.
// getReckoned then projects forward only by the inter-packet gap (0..send
// interval), so a replica renders the AUTHORITATIVE position the owner sent and
// dead-reckons just enough to bridge to the next packet.
//
// The rejected alternative — anchoring at the authoring instant (validAt mapped
// to perf-now) — projects every replica straight through to "now" (predicting
// the owner's present pose). That makes a freshly-spawned object pop in already
// advanced from its spawn point and keeps an expiring object travelling past
// where the owner's copy died until the delete lands: the "spawn ahead" /
// "over-travel" artifacts. Arrival-anchoring trades a constant ~latency lag for
// rendering only authoritative truth, matching the deterministic design intent.
//
// Continuity across successive packets does NOT depend on the anchor: as long as
// each new snapshot's base has advanced by the real elapsed motion, the handoff
// is seamless. The earlier "stuck bullet" sawtooth was a frozen base (a wire
// decode bug), not an anchoring problem.

// Model the baseline choice: validAt-anchored uses the authoring perf time;
// arrival-anchored uses the (latency-delayed) arrival perf time.
function reckonAt(authoredPerf, arrivalPerf, frame, anchor, renderPerf, stepMs, vyPerFrame) {
    const y0 = 0.5;
    const yAuthored = y0 + vyPerFrame * frame; // owner pose at authoring instant
    const recvPerf = anchor === 'validAt' ? authoredPerf : arrivalPerf;
    const state = { x: 0, y: yAuthored, angle: null, velocityX: 0, velocityY: 1, rotationSpeed: 0, recvPerf };
    // velToDeltaY is identity * vyPerFrame so each elapsed frame adds vyPerFrame.
    return reckon(state, renderPerf, stepMs, 1000, () => 0, () => vyPerFrame).y;
}

test('reckon baseline: arrival-anchoring renders the authoritative pose at arrival (no spawn-ahead)', () => {
    const stepMs = 1000 / 60;
    const vy = -0.01;
    // A fresh packet authored at frame 3 lands at arrival; we render AT arrival.
    // The displayed position must equal the authored base exactly — the replica
    // appears where the owner sent it (e.g. a bullet at its muzzle), not ahead.
    const arrival = 3 * stepMs + 40; // 40ms transit
    const y = reckonAt(3 * stepMs, arrival, 3, 'arrival', arrival, stepMs, vy);
    assert.ok(Math.abs(y - (0.5 + vy * 3)) < 1e-9, `expected authored base, got ${y}`);
    // validAt-anchoring at the same instant would instead lead by the transit
    // latency (40ms ≈ 2.4 frames) — the spawn-ahead the fix removes.
    const lead = reckonAt(3 * stepMs, arrival, 3, 'validAt', arrival, stepMs, vy);
    assert.ok(Math.abs(lead - y) > 1e-4, `validAt should lead the authoritative pose, got ${lead} vs ${y}`);
});

test('reckon baseline: arrival-anchoring hands off continuously when the base advances', () => {
    const stepMs = 1000 / 60;
    const vy = -0.01;
    const latency = 40; // constant transit (the real fix is the advancing base)
    // Packet 1 authored@frame3 arrives@(3*step+latency); packet 2 authored@frame6
    // arrives@(6*step+latency). At a render instant just before packet 2 lands,
    // packet 1 reckons to base1 + vy*(elapsed). When packet 2 lands its base has
    // advanced by exactly vy*3 frames, so the displayed value is continuous.
    const arrival1 = 3 * stepMs + latency;
    const arrival2 = 6 * stepMs + latency;
    const justBefore = arrival2 - 1e-6;
    const before = reckonAt(3 * stepMs, arrival1, 3, 'arrival', justBefore, stepMs, vy);
    const after = reckonAt(6 * stepMs, arrival2, 6, 'arrival', arrival2, stepMs, vy);
    // The gap between the two displayed positions is sub-frame (no lurch/sawtooth)
    // because base2 - base1 = vy*3 ≈ the motion over the (arrival2-arrival1) gap.
    assert.ok(Math.abs(after - before) < Math.abs(vy) + 1e-9, `expected continuous handoff, got ${before} vs ${after}`);
});

// ── Correction-decay smoothing (projective velocity blending) ───────────────
//
// getReckoned extrapolates angle as base + rotationSpeed*frames. When the owner
// STOPS rotating, the replica has already projected past the true angle by up to
// rotationSpeed*sendGap (the gap — and thus the overshoot — grows with latency).
// Without smoothing the stop packet snaps the replica back: visible rubberband.
// DeadReckon instead seeds a decaying angular offset = (displayed − fresh) on
// each new snapshot and bleeds it out over DEADRECKON_SMOOTH_MS, so the replica
// eases back to truth. In steady rotation the extrapolation already agrees with
// the next snapshot, so the offset is ~0 and adds no lag.

function shortestAngleDelta(target, current) {
    const d = target - current;
    return Math.atan2(Math.sin(d), Math.cos(d));
}

// Minimal mirror of DeadReckon's angular path with correction smoothing.
function makeReckoner(stepMs, tau, maxFrames = 30) {
    let state = null;        // { angle, rotationSpeed, recvPerf }
    let smooth = null;       // { da, t0 }
    function reckonRaw(now) {
        if (!state) return null;
        let frames = stepMs > 0 ? (now - state.recvPerf) / stepMs : 0;
        if (!(frames > 0)) frames = 0;
        if (frames > maxFrames) frames = maxFrames;
        return state.angle + state.rotationSpeed * frames;
    }
    function sample(now) {
        const raw = reckonRaw(now);
        if (raw == null) return null;
        if (smooth) {
            const k = tau > 0 ? Math.exp(-(now - smooth.t0) / tau) : 0;
            if (k <= 1e-3) smooth = null;
            else return raw + smooth.da * k;
        }
        return raw;
    }
    function update(now, angle, rotationSpeed, snap) {
        const displayed = (!snap && state) ? sample(now) : null;
        state = { angle, rotationSpeed, recvPerf: now };
        if (displayed != null && tau > 0) {
            const fresh = reckonRaw(now);
            const da = shortestAngleDelta(displayed, fresh);
            smooth = (da !== 0) ? { da, t0: now } : null;
        } else {
            smooth = null;
        }
    }
    return { update, sample, resting: () => (state ? state.angle : null) };
}

test('smoothing: rotation stop eases back to truth instead of snapping', () => {
    const stepMs = 1000 / 60;
    const tau = 90;
    const omega = 0.05;       // rad per frame while rotating
    const gap = 8 * stepMs;   // high-latency send gap → big pre-stop overshoot
    const r = makeReckoner(stepMs, tau);

    // Steady rotation: two snapshots whose bases advance by exactly omega*gap.
    r.update(0, 0, omega);
    r.update(gap, omega * (gap / stepMs), omega);
    // Just before the stop packet, the replica has extrapolated forward assuming
    // rotation continued (base 0.4 at t=gap, +omega per frame).
    const tStop = 2 * gap;
    const displayedBeforeStop = r.sample(tStop); // = 0.4 + omega*8 = 0.8 (overshoot)
    // The owner actually stopped EARLIER than the replica predicted: it rotated a
    // little past 0.4 and halted at 0.5, so the extrapolation overshot by 0.3.
    const trueStopAngle = 0.5;

    // Stop packet: rotationSpeed → 0, base = true stop angle.
    r.update(tStop, trueStopAngle, 0);
    const atStop = r.sample(tStop);
    // No snap: the displayed value at the stop instant equals where the replica
    // already was (continuous), NOT the raw authoritative angle.
    assert.ok(Math.abs(atStop - displayedBeforeStop) < 1e-9,
        `expected continuous handoff at stop, got ${atStop} vs ${displayedBeforeStop}`);
    assert.ok(atStop > trueStopAngle, 'replica starts beyond the true stop angle (the overshoot)');

    // Over the next frames it decays monotonically toward truth, never past it.
    let prev = atStop;
    for (let f = 1; f <= 30; f++) {
        const v = r.sample(tStop + f * stepMs);
        assert.ok(v <= prev + 1e-12, `must not move further from truth at frame ${f}`);
        assert.ok(v >= trueStopAngle - 1e-9, `must not undershoot past truth at frame ${f}`);
        prev = v;
    }
    // Settled within a few tau.
    assert.ok(Math.abs(r.sample(tStop + 6 * tau) - trueStopAngle) < 1e-3, 'settles at the true angle');
});

test('smoothing: steady rotation adds no offset (no lag)', () => {
    const stepMs = 1000 / 60;
    const omega = 0.05;
    const gap = 4 * stepMs;
    const r = makeReckoner(stepMs, 90);
    r.update(0, 0, omega);
    // Each subsequent snapshot's base advanced by exactly omega*(gap/stepMs):
    // the extrapolation already predicted it, so the seeded offset is ~0 and the
    // sampled angle equals the pure extrapolation (latency-bounded, no rubberband).
    for (let i = 1; i <= 5; i++) {
        const base = omega * (gap / stepMs) * i;
        r.update(i * gap, base, omega);
        const sampled = r.sample(i * gap);
        assert.ok(Math.abs(sampled - base) < 1e-9, `steady-state offset should be ~0 at packet ${i}`);
    }
});

test('smoothing: disabled (tau=0) snaps immediately', () => {
    const stepMs = 1000 / 60;
    const omega = 0.05;
    const gap = 8 * stepMs;
    const r = makeReckoner(stepMs, 0); // disabled
    r.update(0, 0, omega);
    r.update(gap, omega * (gap / stepMs), omega);
    const trueStopAngle = omega * (gap / stepMs) * 1.5;
    r.update(2 * gap, trueStopAngle, 0);
    // With smoothing off, the replica is exactly the authoritative angle (snap).
    assert.equal(r.sample(2 * gap), trueStopAngle);
});

test('snap: intentional teleport (respawn) jumps instead of blending', () => {
    const stepMs = 1000 / 60;
    const tau = 90;
    const omega = 0.05;
    const gap = 8 * stepMs;
    const r = makeReckoner(stepMs, tau);

    // Steady rotation builds up extrapolation overshoot, just like before a stop.
    r.update(0, 0, omega);
    r.update(gap, omega * (gap / stepMs), omega);
    const tReset = 2 * gap;
    const displayedBeforeReset = r.sample(tReset);

    // Respawn pose is discontinuous (e.g. angle reset to the spawn heading) and
    // arrives WITH the snap flag set: no decaying offset is seeded, so the very
    // first sample is the authoritative angle — no glide from the old pose.
    const spawnAngle = -Math.PI / 2;
    assert.ok(Math.abs(displayedBeforeReset - spawnAngle) > 0.1, 'precondition: poses differ');
    r.update(tReset, spawnAngle, 0, /* snap */ true);
    assert.equal(r.sample(tReset), spawnAngle,
        'snap must place the replica exactly at the authoritative spawn pose');
    // And it stays put (no residual offset decaying in over the next frames).
    assert.equal(r.sample(tReset + 5 * stepMs), spawnAngle);
});

test('snap: without the flag a small reset would blend (regression guard)', () => {
    const stepMs = 1000 / 60;
    const tau = 90;
    const omega = 0.05;
    const gap = 8 * stepMs;
    const r = makeReckoner(stepMs, tau);
    r.update(0, 0, omega);
    r.update(gap, omega * (gap / stepMs), omega);
    const tReset = 2 * gap;
    const displayedBeforeReset = r.sample(tReset);
    const spawnAngle = -Math.PI / 2;
    // Same reset WITHOUT snap: a decaying offset is seeded, so the first sample
    // stays at the old displayed pose and eases over — the artifact snap fixes.
    r.update(tReset, spawnAngle, 0, /* snap */ false);
    assert.ok(Math.abs(r.sample(tReset) - displayedBeforeReset) < 1e-9,
        'no-snap path blends from the old pose (continuous handoff)');
});

// ── Ownership migration: clear dead-reckon state so local sim isn't re-pinned ─
//
// In deterministic mode repositionDeadReckonedRemotes() overwrites an object's
// pose with its dead-reckoned (clamp-frozen) extrapolation EVERY render frame as
// long as the object id is still present in DeadReckon.states. When ownership
// migrates to us we begin simulating the object locally (asteroid.update steps
// it by v·dt); if the stale dead-reckon state isn't dropped, the reposition pass
// pins the object back to the frozen pose and it appears stationary until it is
// destroyed (shooting it spawns split children with fresh ids — not in
// DeadReckon.states — so they move, matching the observed symptom).

// Minimal model of the migration handoff + per-frame reposition overwrite.
function makeMigrationModel() {
    const states = new Map();        // id -> { frozenX } (dead-reckon clamp)
    const owned = new Set();
    const objX = new Map();          // local simulated x
    function observeRemote(id, frozenX, startX) {
        states.set(id, { frozenX });
        objX.set(id, startX);
    }
    // The bug: reposition pins any object still in `states` to its frozen pose.
    function reposition() {
        for (const [id] of objX) {
            if (states.has(id)) objX.set(id, states.get(id).frozenX);
        }
    }
    function simulateLocalOwned(dt, vx) {
        for (const id of owned) objX.set(id, objX.get(id) + vx * dt);
    }
    // The fix: on migration to us, drop the dead-reckon state.
    function migrateToUs(id, clearDeadReckon) {
        owned.add(id);
        if (clearDeadReckon) states.delete(id);
    }
    return { observeRemote, reposition, simulateLocalOwned, migrateToUs,
             getX: (id) => objX.get(id) };
}

test('migration: without clearing dead-reckon state the owned object freezes', () => {
    const m = makeMigrationModel();
    m.observeRemote('a', /* frozenX */ 0.5, /* startX */ 0.5);
    m.migrateToUs('a', /* clearDeadReckon */ false); // BUG path
    // We now own it and simulate it forward, but reposition re-pins it.
    for (let f = 0; f < 10; f++) {
        m.simulateLocalOwned(1, 0.01);
        m.reposition();
    }
    assert.equal(m.getX('a'), 0.5, 'stale dead-reckon state pins the object (frozen)');
});

test('migration: clearing dead-reckon state lets local simulation move the object', () => {
    const m = makeMigrationModel();
    m.observeRemote('a', /* frozenX */ 0.5, /* startX */ 0.5);
    m.migrateToUs('a', /* clearDeadReckon */ true); // FIX path
    for (let f = 0; f < 10; f++) {
        m.simulateLocalOwned(1, 0.01);
        m.reposition();
    }
    assert.ok(Math.abs(m.getX('a') - 0.6) < 1e-9,
        'local simulation advances the object once it is no longer dead-reckoned');
});

// ── Game over: rest at the authoritative base, not the extrapolation ─────────
//
// repositionDeadReckonedRemotes() runs every render frame regardless of game
// state. In game over the owner stops simulating/sending, so getReckoned() keeps
// extrapolating the last snapshot forward to the clamp — and each member, having
// observed the snapshot at a different instant, drifts ahead by a different
// amount, so their resting poses disagree. getResting() returns the raw base
// snapshot (frames=0), which is identical for every member.

test('game over: extrapolation diverges across members but resting agrees', () => {
    const stepMs = 1000 / 60;
    const omega = 0.05;
    // Two members receive the SAME authoritative snapshot (angle 1.0, spinning)
    // but render it at different "now" offsets (different latency/timing).
    const a = makeReckoner(stepMs, 90);
    const b = makeReckoner(stepMs, 90);
    a.update(0, 1.0, omega);
    b.update(0, 1.0, omega);

    // While still extrapolating, the two members disagree (drift apart).
    const aExtrap = a.sample(10 * stepMs);
    const bExtrap = b.sample(4 * stepMs);
    assert.ok(Math.abs(aExtrap - bExtrap) > 1e-6,
        'precondition: forward extrapolation diverges between members');

    // At game over both rest at the base snapshot — identical, no drift.
    assert.equal(a.resting(), 1.0);
    assert.equal(b.resting(), 1.0);
    assert.equal(a.resting(), b.resting());
});

// ── Legacy game over: ease onto the shared snapshot without a pop ────────────
//
// Legacy remotes render from RemoteObjects.getInterpolated at
// (renderTime - adaptiveDelay): a per-member delay, so each member displays the
// object at a different offset from the authoritative snapshot. At game over the
// owner stops sending. Pinning straight to the snapshot (getSettling) converges
// every member but POPS, because game over is detected ~one round-trip after the
// final snapshot, by which point each replica has drifted off it. So
// repositionLegacyRemotesAtRest EASES the visible transform toward the snapshot
// with a frame-rate-independent exponential decay: the first game-over frame
// doesn't move (k = 0), then every member glides onto the identical shared pose
// and holds. Mirror models below.

// Per-member view of one object: a stream of snapshots + an interpolation delay.
// displayed(now) is the (delayed) pose the member currently shows; target() is
// the shared authoritative snapshot all members must converge to.
function makeLegacyRemote(delayMs) {
    const snaps = []; // { t, x }
    return {
        push: (t, x) => snaps.push({ t, x }),
        displayed(now) {
            const target = now - delayMs;
            if (snaps.length === 0) return null;
            if (target <= snaps[0].t) return snaps[0].x;
            const last = snaps[snaps.length - 1];
            if (target >= last.t) return last.x;
            for (let i = 1; i < snaps.length; i++) {
                if (snaps[i].t >= target) {
                    const p = snaps[i - 1], q = snaps[i];
                    return p.x + (q.x - p.x) * ((target - p.t) / (q.t - p.t));
                }
            }
            return last.x;
        },
        target: () => (snaps.length ? snaps[snaps.length - 1].x : null),
    };
}

// Mirror of repositionLegacyRemotesAtRest's frame-rate-independent ease (1-D).
// k = 1 - exp(-dt/tau); pose += (target - pose) * k. First frame dt = 0 ⇒ k = 0.
function makeSettler(startPose, tau) {
    let pose = startPose;
    let active = false;
    return {
        step(dtMs, target) {
            const k = active && tau > 0 && dtMs > 0 ? 1 - Math.exp(-dtMs / tau) : (tau <= 0 ? 1 : 0);
            active = true;
            pose += (target - pose) * k;
            return pose;
        },
        get: () => pose,
    };
}

test('legacy game over: members ease onto one shared pose, no first-frame pop', () => {
    const stepMs = 1000 / 60;
    const vx = 0.01; // per ms
    const tau = 140;
    // Two members observe the SAME snapshots but with different interpolation
    // delays, so they DISPLAY the object at different poses (the divergence).
    const a = makeLegacyRemote(2 * stepMs);
    const b = makeLegacyRemote(9 * stepMs);
    const lastSentT = 20 * stepMs;
    for (let t = 0; t <= lastSentT; t += stepMs) { a.push(t, vx * t); b.push(t, vx * t); }

    const goNow = lastSentT + 8 * stepMs; // game over detected a few frames later
    const aStart = a.displayed(goNow);
    const bStart = b.displayed(goNow);
    assert.ok(Math.abs(aStart - bStart) > 1e-6,
        'precondition: members display the object at different poses at game over');

    const target = a.target(); // shared authoritative snapshot (== b.target())
    assert.equal(a.target(), b.target());

    const sa = makeSettler(aStart, tau);
    const sb = makeSettler(bStart, tau);

    // First game-over frame: no movement (k = 0) — no pop.
    assert.equal(sa.step(0, target), aStart);
    assert.equal(sb.step(0, target), bStart);

    // Subsequent frames ease toward the shared target and converge.
    for (let f = 0; f < 240; f++) { sa.step(stepMs, target); sb.step(stepMs, target); }
    assert.ok(Math.abs(sa.get() - target) < 1e-6, 'member A settles onto the shared snapshot');
    assert.ok(Math.abs(sb.get() - target) < 1e-6, 'member B settles onto the shared snapshot');
    assert.ok(Math.abs(sa.get() - sb.get()) < 1e-9, 'both members converge to the identical pose');
});

test('legacy game over settle: motion is monotonic toward the target (no overshoot)', () => {
    const tau = 140, stepMs = 1000 / 60, target = 1.0;
    const s = makeSettler(0, tau);
    let prev = s.step(0, target); // k=0 → stays at 0
    assert.equal(prev, 0);
    for (let f = 0; f < 120; f++) {
        const cur = s.step(stepMs, target);
        assert.ok(cur >= prev - 1e-12 && cur <= target + 1e-12,
            'each step moves toward the target without overshooting');
        prev = cur;
    }
});