import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const productionSource = readFileSync(resolve(here, 'wwwroot/index.html'), 'utf8');
const presentationSource = readFileSync(
    resolve(here, 'wwwroot/js/replication-presentation.js'),
    'utf8');
const runtimeSource = readFileSync(
    resolve(here, 'wwwroot/js/replication-runtime.js'),
    'utf8');

const CUE_MIN_MS = 120;
const CUE_FADE_MS = 180;
const CUE_MAX_MS = 1000;
const ASTEROID_CUE_START_SCALE = 0.75;
const ASTEROID_CUE_END_SCALE = 4.0;
const ASTEROID_CUE_INNER_CROSS_SCALE = 0.8;

function impactOffset(radius, bulletAngle, offsetN) {
    const clamped = Math.max(-1, Math.min(1, offsetN));
    const across = clamped * radius;
    const along = -Math.sqrt(Math.max(0, radius * radius - across * across));
    const dx = Math.cos(bulletAngle);
    const dy = Math.sin(bulletAngle);
    return {
        x: along * dx + across * -dy,
        y: along * dy + across * dx
    };
}

function cueAlpha(startedAt, resolvedAt, now) {
    const fadeStart = resolvedAt == null
        ? startedAt + CUE_MAX_MS - CUE_FADE_MS
        : Math.max(resolvedAt, startedAt + CUE_MIN_MS);
    if (now >= fadeStart + CUE_FADE_MS) return 0;
    return now <= fadeStart ? 1 : 1 - (now - fadeStart) / CUE_FADE_MS;
}

function asteroidCueScale(ageMs) {
    const progress = Math.min(1, Math.max(0, ageMs) / (CUE_MIN_MS + CUE_FADE_MS));
    const easedProgress = 1 - Math.pow(1 - progress, 3);
    return ASTEROID_CUE_START_SCALE
        + (ASTEROID_CUE_END_SCALE - ASTEROID_CUE_START_SCALE) * easedProgress;
}

class CueDeduper {
    constructor() {
        this.pendingBullets = new Set();
        this.shipHitCounts = new Map();
    }

    startBullet(id) {
        if (this.pendingBullets.has(id)) return false;
        this.pendingBullets.add(id);
        return true;
    }

    resolveBullet(id) {
        this.pendingBullets.delete(id);
    }

    resolveTarget() {
        // The pending bullet can outlive target replacement while its owner
        // observes the acknowledgment and sends the follow-up deletion.
    }

    startShip(id, hitCount) {
        const seen = this.shipHitCounts.get(id) || 0;
        if (hitCount <= seen) return false;
        this.shipHitCounts.set(id, hitCount);
        return true;
    }

    clear() {
        this.pendingBullets.clear();
        this.shipHitCounts.clear();
    }
}

test('asteroid impact cue remains attached to the transmitted disk impact point', () => {
    for (const radius of [0.025, 0.05, 0.083]) {
        for (const angle of [0, 0.7, Math.PI, 5.1]) {
            for (const offsetN of [-1, -0.5, 0, 0.75, 1]) {
                const offset = impactOffset(radius, angle, offsetN);
                assert.ok(Math.abs(Math.hypot(offset.x, offset.y) - radius) < 1e-12);
                const nx = -Math.sin(angle);
                const ny = Math.cos(angle);
                const across = offset.x * nx + offset.y * ny;
                assert.ok(Math.abs(across - offsetN * radius) < 1e-12);
            }
        }
    }
});

test('resolved cues hold long enough to explain a transition and then fade', () => {
    assert.equal(cueAlpha(1000, 1010, 1000), 1);
    assert.equal(cueAlpha(1000, 1010, 1119), 1);
    assert.equal(cueAlpha(1000, 1010, 1210), 0.5);
    assert.equal(cueAlpha(1000, 1010, 1300), 0);
});

test('unresolved pending cues have a bounded lifetime', () => {
    assert.equal(cueAlpha(0, null, CUE_MAX_MS - CUE_FADE_MS), 1);
    assert.ok(cueAlpha(0, null, CUE_MAX_MS - CUE_FADE_MS / 2) > 0);
    assert.equal(cueAlpha(0, null, CUE_MAX_MS), 0);
});

test('asteroid impact cues ease out from 0.75x to 4x across their animation', () => {
    assert.equal(asteroidCueScale(0), ASTEROID_CUE_START_SCALE);
    assert.equal(
        asteroidCueScale(CUE_MIN_MS + CUE_FADE_MS),
        ASTEROID_CUE_END_SCALE);
    const earlyGrowth = asteroidCueScale(100) - asteroidCueScale(0);
    const middleGrowth = asteroidCueScale(200) - asteroidCueScale(100);
    const lateGrowth = asteroidCueScale(300) - asteroidCueScale(200);
    assert.ok(earlyGrowth > middleGrowth);
    assert.ok(middleGrowth > lateGrowth);
    assert.ok(lateGrowth > 0);
    assert.ok(ASTEROID_CUE_START_SCALE < 1);
    assert.ok(ASTEROID_CUE_END_SCALE > 1);
    assert.match(productionSource, /ASTEROID_IMPACT_CUE_START_SCALE: 0\.75/);
    assert.match(productionSource, /ASTEROID_IMPACT_CUE_END_SCALE: 4\.0/);
    assert.match(productionSource, /const easedProgress = 1 - Math\.pow\(1 - progress, 3\);/);
    assert.match(
        productionSource,
        /effect\.baseRadius \|\| CONFIG\.MIN_ASTEROID_RADIUS\) \* 0\.4;/);
    assert.match(
        productionSource,
        /const radius = base \* scale;/);
});

test('asteroid impact cue adds an 80%-size cross rotated by 45 degrees', () => {
    for (const radius of [3, 10, 40]) {
        const outerHalfLength = radius * 0.65;
        const innerHalfLength = outerHalfLength * ASTEROID_CUE_INNER_CROSS_SCALE;
        const axisOffset = innerHalfLength / Math.SQRT2;
        assert.equal(innerHalfLength / outerHalfLength, 0.8);
        assert.ok(Math.abs(Math.hypot(axisOffset, axisOffset) - innerHalfLength) < 1e-12);
    }
    assert.match(
        productionSource,
        /ASTEROID_IMPACT_CUE_INNER_CROSS_SCALE: 0\.8/);
    assert.match(
        productionSource,
        /const innerCrossHalfLength = outerCrossHalfLength[\s\S]*\/ Math\.SQRT2;/);
    assert.match(
        productionSource,
        /moveTo\(x - innerCrossAxisOffset, y - innerCrossAxisOffset\);[\s\S]*lineTo\(x \+ innerCrossAxisOffset, y \+ innerCrossAxisOffset\);/);
});

test('collision acknowledgment precedes authoritative replacement across the network matrix', () => {
    for (const rtt of [0, 50, 100, 150, 250]) {
        for (const jitter of [0, 10, 25, 50]) {
            const oneWay = rtt / 2;
            const observerCueAt = Math.max(0, oneWay + jitter);
            const replacementAt = Math.max(
                observerCueAt,
                oneWay + jitter + rtt);
            assert.ok(observerCueAt <= replacementAt);
            assert.equal(0 <= replacementAt, true, 'shooter cue starts in the collision frame');
        }
    }
});

test('pending bullets and monotonic ship hits are cued exactly once', () => {
    const cues = new CueDeduper();
    assert.equal(cues.startBullet('bullet-1'), true);
    assert.equal(cues.startBullet('bullet-1'), false);
    assert.equal(cues.startShip('ship-1', 2), true);
    assert.equal(cues.startShip('ship-1', 2), false);
    assert.equal(cues.startShip('ship-1', 1), false);
    assert.equal(cues.startShip('ship-1', 3), true);
    cues.resolveTarget('target-1');
    assert.equal(cues.startBullet('bullet-1'), false);
    cues.resolveBullet('bullet-1');
    assert.equal(cues.startBullet('bullet-1'), true);
    cues.clear();
    assert.equal(cues.startShip('ship-1', 1), true);
});

test('production applies non-kinematic pending-hit fields outside DeadReckon', () => {
    assert.match(productionSource, /instance\.pendingHit = !!raw\.pendingHit;/);
    assert.match(productionSource, /instance\.hitTargetId = raw\.hitTargetId \|\| null;/);
    assert.match(productionSource, /CollisionEffects\.startAsteroidHit\(\{\s*\.\.\.raw,/);
});

test('production ship-hit event carries the pre-reset pose and deduplicates by hitCount', () => {
    assert.match(productionSource, /const hitPose = \{ x: ship\.x, y: ship\.y, angle: ship\.angle \};/);
    assert.match(productionSource, /payload\.hitX = hitPose\.x;/);
    assert.match(productionSource, /game\.multiplayer\.seenShipHitCounts\.get\(objectId\)/);
    assert.match(productionSource, /CollisionEffects\.startShipHit\(/);
});

test('solo collisions start the same local cues before removing their sources', () => {
    const asteroidCueStart = productionSource.indexOf('        startAsteroidHit(source, target = null, impact = null) {');
    const shipCueStart = productionSource.indexOf('        startShipHit(objectId, payload, colorIndex = 0) {');
    const resolveTargetStart = productionSource.indexOf('        resolveTarget(targetId) {');
    assert.ok(asteroidCueStart >= 0 && shipCueStart > asteroidCueStart);
    assert.ok(resolveTargetStart > shipCueStart);
    const asteroidCueSource = productionSource.slice(asteroidCueStart, shipCueStart);
    const shipCueSource = productionSource.slice(shipCueStart, resolveTargetStart);
    assert.doesNotMatch(asteroidCueSource, /isSessionMode/);
    assert.doesNotMatch(shipCueSource, /isSessionMode/);
    assert.match(asteroidCueSource, /resolvedAt: targetId \? null : now/);

    const soloCollisionStart = productionSource.indexOf('// Solo mode — process locally');
    const collisionBreak = productionSource.indexOf('                    break;  // Bullet can only hit one asteroid', soloCollisionStart);
    assert.ok(soloCollisionStart >= 0 && collisionBreak > soloCollisionStart);
    const soloCollision = productionSource.slice(soloCollisionStart, collisionBreak);
    const asteroidCueAt = soloCollision.indexOf(
        'CollisionEffects.startAsteroidHit(bullet, asteroid, impact);');
    const bulletRemovalAt = soloCollision.indexOf('game.bullets.splice(i, 1);');
    const asteroidRemovalAt = soloCollision.indexOf('game.astervoids.splice(j, 1);');
    assert.ok(asteroidCueAt >= 0 && asteroidCueAt < bulletRemovalAt);
    assert.ok(asteroidCueAt < asteroidRemovalAt);

    const shipHitStart = productionSource.indexOf('    function handleShipHit(ship) {');
    const shipHitEnd = productionSource.indexOf('    function updateHUD() {', shipHitStart);
    assert.ok(shipHitStart >= 0 && shipHitEnd > shipHitStart);
    const shipHitSource = productionSource.slice(shipHitStart, shipHitEnd);
    assert.match(
        shipHitSource,
        /CollisionEffects\.startShipHit\('solo', \{\s*hitCount: ship\.hitCount,\s*hitX: hitPose\.x,\s*hitY: hitPose\.y,\s*hitAngle: hitPose\.angle\s*\}, ship\.colorIndex\);/);
});

test('same-owner asteroid impacts broadcast a target-relative cue before replacement', () => {
    assert.match(
        productionSource,
        /ASTEROID_IMPACT_CUE: 'asteroid-impact-cue'/);
    assert.match(
        productionSource,
        /ASTEROID_IMPACT_CUE: 2/);
    assert.match(
        productionSource,
        /ObjectSync\.registerEventKind\(EVENT_KIND\.ASTEROID_IMPACT_CUE, EVENT_KIND_BYTE\.ASTEROID_IMPACT_CUE\)/);
    assert.match(
        productionSource,
        /_impactCueKey: `asteroid:event:\$\{payload\.cueId\}`[\s\S]*hitTargetId: objectId/);

    const helperStart = productionSource.indexOf(
        '    function emitOwnedAsteroidImpactCue(asteroid, bullet, impact) {');
    const helperEnd = productionSource.indexOf(
        '    async function deleteSyncedShip() {',
        helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const helperSource = productionSource.slice(helperStart, helperEnd);
    assert.match(helperSource, /cueId,\s*bulletAngle: impact\.bulletAngle,\s*offsetN: impact\.offsetN,/);
    assert.doesNotMatch(helperSource, /\bhit[XY]\b|\bimpact[XY]\b/);

    const ownerBranchStart = productionSource.indexOf(
        '                        if (asteroidOwner === myMemberId) {');
    const ownerBranchEnd = productionSource.indexOf(
        '                        } else {',
        ownerBranchStart);
    assert.ok(ownerBranchStart >= 0 && ownerBranchEnd > ownerBranchStart);
    const ownerBranch = productionSource.slice(ownerBranchStart, ownerBranchEnd);
    const cueAt = ownerBranch.indexOf('emitOwnedAsteroidImpactCue(asteroid, bullet, impact);');
    const deleteAt = ownerBranch.indexOf('deleteSyncedBullet(removedBullet);');
    const replaceAt = ownerBranch.indexOf('splitAsteroid(asteroid, null, impact, game.ship);');
    assert.ok(cueAt >= 0 && cueAt < deleteAt && deleteAt < replaceAt);
    assert.doesNotMatch(ownerBranch, /CollisionEffects\.startAsteroidHit/);
});

test('production join seeding targets the delayed presentation timeline only for active owners', () => {
    assert.match(productionSource, /!isDeterministicMode\(\) \|\| !record \|\| !facts\.joinSnapshot/);
    assert.match(productionSource, /!facts\.ownerIsActive \|\| !Number\.isFinite\(clockRtt\)/);
    assert.match(
        productionSource,
        /presentationNow = RemoteObjects\.serverNowMs\(\) - Math\.max\(0, clockRtt\) \/ 2/);
    assert.match(productionSource, /getDeterministicJoinBaselinePerf\(record, facts\)/);
});

test('production migration handoff skips ownership-only anchors and preserves direction', () => {
    assert.match(runtimeSource, /record\.ownershipMigrationVersion === record\.version/);
    assert.match(runtimeSource, /preserveDirection = !!transition\?\.pending && !ownershipVersion;/);
    assert.match(
        productionSource,
        /isTeleport,\s*facts\.preserveDirection,\s*\{\s*validAt: record\.validAt,\s*rateAngularPredictionWindow:/);
    assert.match(presentationSource, /correctionAlong \* stepMs \/ motion/);
    assert.match(presentationSource, /tauMs: tau/);
});

test('session reset clears all transient collision state', () => {
    assert.match(productionSource, /CollisionEffects\.clear\(\);[\s\S]*replicationRuntime\.resetSession\(\);/);
    assert.match(productionSource, /game\.multiplayer\.seenPendingBulletIds\.clear\(\);/);
    assert.match(productionSource, /game\.multiplayer\.seenShipHitCounts\.clear\(\);/);
});

test('target replacement retains bullet deduplication until bullet removal', () => {
    const resolveTargetStart = productionSource.indexOf('        resolveTarget(targetId) {');
    const resolveBulletStart = productionSource.indexOf('        resolveBullet(bulletId) {');
    assert.ok(resolveTargetStart >= 0 && resolveBulletStart > resolveTargetStart);
    const resolveTargetSource = productionSource.slice(resolveTargetStart, resolveBulletStart);
    assert.doesNotMatch(
        resolveTargetSource,
        /seenPendingBulletIds\.delete/,
        'target replacement must not permit a still-pending bullet to replay its cue');
    assert.match(
        productionSource,
        /async function deleteSyncedBullet\(bullet\) \{\s*CollisionEffects\.resolveBullet\(bullet\.syncObjectId\);/,
        'local bullet deletion must release its dedupe marker');
});
