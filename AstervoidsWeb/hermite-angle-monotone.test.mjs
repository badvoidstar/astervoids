/**
 * Tests for the Fritsch–Carlson monotone-Hermite clamp applied to the
 * production interpolation policy. Without the clamp, short-lived
 * turn-input taps on the owner side produce a Hermite tangent bulge on
 * remote observers: prev.rotationSpeed is near a turn-speed cap but the actual
 * endpoint chord dAngle is much smaller, so the cubic curves past a1
 * before settling — visible as a one-frame angular overshoot even with
 * good network conditions and no extrapolation. The owner never sees
 * this because they render the live Ship directly.
 *
 * Run with:  node --test AstervoidsWeb/hermite-angle-monotone.test.mjs
 *
 * Exercises ReplicationPresentation.interpolateHermiteAngle directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const CONFIG = { TARGET_FPS: 60 };
const require = createRequire(import.meta.url);
const { interpolateHermiteAngle } = require(
    './wwwroot/js/replication-presentation.js');

/**
 * Adapter around the production angle interpolator. Position tangents are
 * intentionally not clamped in production.
 *
 * Inputs:
 *   prevAngle, currAngle     — endpoint angles (radians)
 *   prevRotSpeed, rotSpeed   — endpoint rotationSpeed (radians per 60fps frame)
 *   t                        — parameter in [0, 1]
 *   timeDiffMs               — bracket interval in milliseconds
 */
function interpAngle(prevAngle, currAngle, prevRotSpeed, rotSpeed, t, timeDiffMs) {
    return interpolateHermiteAngle({
        previousAngle: prevAngle,
        currentAngle: currAngle,
        previousRotationSpeed: prevRotSpeed,
        rotationSpeed: rotSpeed,
        targetFps: CONFIG.TARGET_FPS,
        t,
        timeDiff: timeDiffMs
    });
}

/** Same as above but WITHOUT the clamp, used to demonstrate the bug it fixes. */
function interpAngleUnclamped(prevAngle, currAngle, prevRotSpeed, rotSpeed, t, timeDiffMs) {
    const dt = timeDiffMs / 1000;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    let dAngle = currAngle - prevAngle;
    while (dAngle > Math.PI) dAngle -= Math.PI * 2;
    while (dAngle < -Math.PI) dAngle += Math.PI * 2;
    if (Math.abs(dAngle) < 1e-6) return currAngle;

    const a0 = prevAngle;
    const a1 = a0 + dAngle;
    const rpsToPerSec = CONFIG.TARGET_FPS;
    const am0 = (prevRotSpeed || 0) * rpsToPerSec * dt;
    const am1 = (rotSpeed || 0) * rpsToPerSec * dt;
    return h00 * a0 + h10 * am0 + h01 * a1 + h11 * am1;
}

// Scan parameter t for max excursion past max(a0,a1) or below min(a0,a1).
function maxOvershoot(fn, prevAngle, currAngle, prevRotSpeed, rotSpeed, timeDiffMs, steps = 200) {
    const lo = Math.min(prevAngle, currAngle);
    const hi = Math.max(prevAngle, currAngle);
    let worst = 0;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const v = fn(prevAngle, currAngle, prevRotSpeed, rotSpeed, t, timeDiffMs);
        if (v > hi) worst = Math.max(worst, v - hi);
        else if (v < lo) worst = Math.max(worst, lo - v);
    }
    return worst;
}

test('endpoint identity: t=0 returns prev, t=1 returns curr', () => {
    const a0 = 0.3, a1 = 0.5, m0 = 0.05, m1 = 0.02;
    assert.ok(Math.abs(interpAngle(a0, a1, m0, m1, 0, 100) - a0) < 1e-9);
    assert.ok(Math.abs(interpAngle(a0, a1, m0, m1, 1, 100) - a1) < 1e-9);
});

test('zero-chord short-circuit returns currAngle (preserves spawn-bridge fix)', () => {
    // Both endpoints identical but rotationSpeed non-zero — must not bulge.
    for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const v = interpAngle(0.0, 0.0, 0.12, 0.12, t, 100);
        assert.equal(v, 0.0);
    }
});

test('short-tap with prior rotation then stop does NOT overshoot', () => {
    // Owner taps turn key briefly: prev snapshot caught the tap mid-flight
    // (rotationSpeed ≈ +0.12 rad/frame), curr snapshot is after release
    // (rotationSpeed = 0). The chord dAngle is small relative to the
    // 100 ms send interval × 7.2 rad/s tangent.
    const prevAngle = 0;
    const currAngle = 0.05;   // ≈ 2.9° of net rotation across the bracket
    const prevRot = 0.12;     // Representative rotation speed, rad/frame at 60fps
    const currRot = 0;
    const timeDiffMs = 100;

    const overshootClamped = maxOvershoot(interpAngle, prevAngle, currAngle, prevRot, currRot, timeDiffMs);
    const overshootUnclamped = maxOvershoot(interpAngleUnclamped, prevAngle, currAngle, prevRot, currRot, timeDiffMs);

    assert.equal(overshootClamped, 0, 'monotone clamp must eliminate overshoot');
    assert.ok(overshootUnclamped > 0.05,
        `unclamped Hermite must overshoot here (got ${overshootUnclamped}); test premise is broken otherwise`);
});

test('short-tap on the release edge (prevRot=0, currRot>0) does not overshoot', () => {
    // Mirror: the bracket spans the tap-start instead of the tap-end.
    const prevAngle = 0;
    const currAngle = 0.05;
    const prevRot = 0;
    const currRot = 0.12;
    const timeDiffMs = 100;

    assert.equal(maxOvershoot(interpAngle, prevAngle, currAngle, prevRot, currRot, timeDiffMs), 0);
});

test('opposite-sign tangents (wrong direction) get clamped to 0', () => {
    // If a rotationSpeed sample points the wrong way relative to the chord
    // (e.g. ship reversed turn between snapshots), tangent should be zeroed.
    const prevAngle = 0;
    const currAngle = 0.1;     // chord is positive
    const prevRot = -0.12;     // wrong sign vs chord
    const currRot = -0.12;     // wrong sign vs chord
    const timeDiffMs = 100;

    // With both tangents zeroed, Hermite degenerates to smoothstep between
    // a0 and a1 — strictly bounded in [a0, a1].
    for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const v = interpAngle(prevAngle, currAngle, prevRot, currRot, t, timeDiffMs);
        assert.ok(v >= prevAngle - 1e-12 && v <= currAngle + 1e-12,
            `t=${t}: v=${v} must be within [${prevAngle}, ${currAngle}]`);
    }
});

test('steady-state turn (rot consistent with chord) is unaffected by clamp', () => {
    // When the rotation rate is consistent with the endpoint chord, the
    // tangents are well below the 3·|chord| limit and the clamp is a no-op.
    // Verify the clamped and unclamped versions agree to machine precision.
    const prevAngle = 0;
    const timeDiffMs = 100;
    const rot = 0.05;             // moderate, steady turn
    const dt = timeDiffMs / 1000;
    // Net angular delta over the bracket from the steady rate:
    const currAngle = prevAngle + rot * CONFIG.TARGET_FPS * dt;
    for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const a = interpAngle(prevAngle, currAngle, rot, rot, t, timeDiffMs);
        const b = interpAngleUnclamped(prevAngle, currAngle, rot, rot, t, timeDiffMs);
        assert.ok(Math.abs(a - b) < 1e-12,
            `clamp must be a no-op when tangents agree with chord; diff=${a - b} at t=${t}`);
    }
});

test('wrap-around chord (currAngle straddles ±π) uses shortest path and stays monotone', () => {
    // prevAngle just under +π, currAngle just over -π. The normalization
    // in the interp function must compute dAngle as the shortest-path
    // chord (+0.04 rad across the ±π seam), not the wrong-way near-2π
    // negative step.
    const prevAngle = Math.PI - 0.02;
    const currAngle = -Math.PI + 0.02;     // shortest-path chord across the seam: +0.04 rad
    const prevRot = 0.01;
    const currRot = 0.01;
    const timeDiffMs = 100;

    // Endpoint identity still holds modulo numerical noise.
    assert.ok(Math.abs(interpAngle(prevAngle, currAngle, prevRot, currRot, 0, timeDiffMs) - prevAngle) < 1e-9);

    // No overshoot relative to the unwrapped chord [prevAngle, prevAngle + 0.04].
    const lo = prevAngle;
    const hi = prevAngle + 0.04;
    for (let i = 0; i <= 50; i++) {
        const t = i / 50;
        const v = interpAngle(prevAngle, currAngle, prevRot, currRot, t, timeDiffMs);
        assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9,
            `t=${t}: v=${v} outside unwrapped chord [${lo}, ${hi}]`);
    }
});
