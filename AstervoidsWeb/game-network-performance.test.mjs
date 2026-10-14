import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';
import { loadClassicModule } from './test-support/classic-module.mjs';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const BULLET_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const PARTICIPANT_ID = '44444444-4444-4444-8444-444444444444';
const SHIP_ID = '55555555-5555-4555-8555-555555555555';

async function bulletHarness({ deltaEncoding = true, attributed = true, joinSnapshot = true } = {}) {
    const handlers = {};
    const creates = [];
    const requests = [];
    let accept = true;
    const SessionClient = {
        on: (event, callback) => { handlers[event] = callback; },
        isInSession: () => true,
        getCurrentMember: () => ({ id: OWNER_ID }),
        createObject: async (data, scope, ownerMemberId, validAt, schemaId) => {
            creates.push({ data: structuredClone(data), scope, ownerMemberId, schemaId });
            return {
                objectInfo: {
                    id: BULLET_ID, data: structuredClone(data), version: 1, schemaId,
                    ownerMemberId: OWNER_ID, creatorMemberId: OWNER_ID, scope,
                },
                validAt: 1000, memberSequence: 1,
            };
        },
        updateObjects: async updates => {
            requests.push(structuredClone(updates));
            return {
                versions: accept ? { [BULLET_ID]: requests.length + 1 } : {},
                memberSequence: requests.length + 1,
            };
        },
    };
    const ObjectSync = loadClassicModule('object-sync.js', 'ObjectSync',
        { SessionClient, AuthoritativeObject, window: {} });
    ObjectSync.init();
    ObjectSync.configure({ deltaEncoding });
    const game = { bullets: [] };
    const { Bullet, createSyncedBullet, syncLocalBullets, updateLocalBullet } = loadInlineGameFunctions(
        ['Bullet', 'assignDefined', 'createSyncedBullet', 'syncLocalBullets', 'updateLocalBullet'], {
            CONFIG: { BULLET_LIFETIME: 60, BULLET_RADIUS: 0.0033 },
            OBJECT_TYPES: { BULLET: 'bullet' },
            SessionClient, ObjectSync, crypto: { randomUUID }, game,
            isSessionMode: () => true,
            SendGate: { shouldSend: () => false },
            velocityToNormalizedDeltaX: value => value / 60,
            velocityToNormalizedDeltaY: value => value / 60,
            wrapMarginX: () => 0.0033, wrapMarginY: () => 0.0033,
            wrapNormalized: value => value,
            deleteSyncedBullet: value => deleted.push(value.syncObjectId),
            _error: (...args) => assert.fail(args.join(' ')),
        });
    const bullet = new Bullet(0.2, 0.3, 0.1, 0, 0, OWNER_ID, attributed ? {
        participantId: PARTICIPANT_ID, participantTag: 'Pilot_1', shipId: SHIP_ID,
    } : null);
    game.bullets.push(bullet);
    const deleted = [];
    handlers.onSessionJoined({ objects: [] });
    await createSyncedBullet(bullet);
    if (joinSnapshot) {
        handlers.onSessionJoined({
            objects: [{
                id: BULLET_ID, data: structuredClone(creates[0].data), version: 1, schemaId: 0,
                ownerMemberId: OWNER_ID, creatorMemberId: OWNER_ID, scope: 'Member',
            }],
        });
    }
    return {
        bullet, ObjectSync, syncLocalBullets, updateLocalBullet, creates, requests, deleted, attributed, joinSnapshot,
        reject: () => { accept = false; },
        accept: () => { accept = true; },
    };
}

function assertBulletCreation(h) {
    assert.ok(GuidUtils.isGuid(h.bullet.damageId));
    assert.equal(h.bullet.syncObjectId, BULLET_ID, 'the real create path assigns the accepted object ID');
    assert.deepEqual(h.creates, [{
        data: {
            type: 'bullet', x: 0.2, y: 0.3, velocityX: 0.1, velocityY: 0,
            lifetime: 60, colorIndex: 0, ownerMemberId: OWNER_ID, damageId: h.bullet.damageId,
            ...(h.attributed ? { participantId: PARTICIPANT_ID } : {}),
            participantTag: h.attributed ? 'Pilot_1' : '', shipId: h.attributed ? SHIP_ID : null,
        },
        scope: 'Member', ownerMemberId: null, schemaId: 0,
    }], 'attribution is durably present in the full creation before any claim delta');
    assert.deepEqual(h.ObjectSync.getObject(BULLET_ID).data, h.creates[0].data);
    assert.equal(h.ObjectSync.isDataConfirmed(BULLET_ID, h.creates[0].data), h.joinSnapshot,
        'a joined snapshot supplies a full delta baseline; fresh creation registers canonical data only');
}

function pendingClaim(h) {
    Object.assign(h.bullet, {
        pendingHit: true, hitTargetId: TARGET_ID,
        hitImpactTorque: 0.25, hitBulletAngle: 0.5, hitOffsetN: -0.1,
    });
    return {
        pendingHit: true, hitTargetId: TARGET_ID,
        hitImpactTorque: 0.25, hitBulletAngle: 0.5, hitOffsetN: -0.1,
    };
}

function fullClaim(h, rareFields) {
    return {
        ...rareFields, damageId: h.bullet.damageId,
        ...(h.attributed ? { participantId: PARTICIPANT_ID } : {}),
        participantTag: h.attributed ? 'Pilot_1' : '', shipId: h.attributed ? SHIP_ID : null,
    };
}

for (const deltaEncoding of [true, false]) {
    for (const joinSnapshot of [true, false]) {
        for (const attributed of [true, false]) {
            test(`pending claims stop motion traffic after confirmation (delta=${deltaEncoding}, snapshot=${joinSnapshot}, attributed=${attributed})`, async () => {
                const h = await bulletHarness({ deltaEncoding, attributed, joinSnapshot });
                assertBulletCreation(h);
                const rareFields = pendingClaim(h);
                const claim = fullClaim(h, rareFields);
                for (let frame = 0; frame < 60; frame++) {
                    h.syncLocalBullets();
                    await h.ObjectSync.flushUpdates();
                    h.updateLocalBullet(h.bullet, 1, OWNER_ID);
                }
                assert.equal(h.requests.length, 1, 'one accepted claim, not 60 changing poses');
                assert.deepEqual(h.requests[0], [{
                    objectId: BULLET_ID, schemaId: 0,
                    data: deltaEncoding && joinSnapshot ? rareFields : { x: 0.2, y: 0.3, lifetime: 60, ...claim },
                }]);
                assert.deepEqual({ ...h.creates[0].data, ...h.requests[0][0].data },
                    { ...h.creates[0].data, ...claim }, 'claim deltas retain all original attribution');
                assert.equal(h.ObjectSync.isDataConfirmed(BULLET_ID, claim), true);
                assert.ok(h.bullet.x > 0.2, 'local motion continues without publishing hidden-bullet poses');
                assert.equal(h.bullet.lifetime, 0);
                assert.deepEqual(h.deleted, [BULLET_ID], 'local expiration still retires the object');
            });
        }
    }
}

for (const deltaEncoding of [true, false]) {
    test(`unconfirmed pending claims retry exact claim data with current pose, then stop (delta=${deltaEncoding})`, async () => {
        const h = await bulletHarness({ deltaEncoding });
        assertBulletCreation(h);
        const rareFields = pendingClaim(h);
        const claim = fullClaim(h, rareFields);
        h.reject();
        for (let frame = 0; frame < 3; frame++) {
            const pose = { x: h.bullet.x, y: h.bullet.y, lifetime: h.bullet.lifetime };
            h.syncLocalBullets();
            await h.ObjectSync.flushUpdates();
            assert.deepEqual(h.requests[frame], [{
                objectId: BULLET_ID, schemaId: 0,
                data: !deltaEncoding ? { ...pose, ...claim }
                    : frame === 0 ? rareFields : { x: pose.x, lifetime: pose.lifetime, ...rareFields },
            }], 'only unconfirmed fields retry; current pose anchors each retry version');
            assert.equal(h.ObjectSync.isDataConfirmed(BULLET_ID, claim), false);
            h.updateLocalBullet(h.bullet, 1, OWNER_ID);
        }
        assert.equal(h.requests.length, 3);
        h.accept();
        const pose = { x: h.bullet.x, y: h.bullet.y, lifetime: h.bullet.lifetime };
        h.syncLocalBullets();
        await h.ObjectSync.flushUpdates();
        assert.deepEqual(h.requests[3][0].data, deltaEncoding
            ? { x: pose.x, lifetime: pose.lifetime, ...rareFields } : { ...pose, ...claim });
        assert.equal(h.ObjectSync.isDataConfirmed(BULLET_ID, claim), true);
        h.updateLocalBullet(h.bullet, 1, OWNER_ID);
        h.syncLocalBullets();
        await h.ObjectSync.flushUpdates();
        assert.equal(h.requests.length, 4);
    });
}

test('non-pending bullets still respect their motion gate', async () => {
    const h = await bulletHarness();
    h.syncLocalBullets();
    await h.ObjectSync.flushUpdates();
    assert.equal(h.requests.length, 0);
    h.bullet.ownerMemberId = 'other';
    h.bullet.pendingHit = true;
    h.syncLocalBullets();
    await h.ObjectSync.flushUpdates();
    assert.equal(h.requests.length, 0, 'never publish another owner’s claim');
});

function waveHarness(session = true) {
    const game = { wave: 0 };
    const pending = [];
    let nextId = 0;
    let active = 0;
    let maximum = 0;
    const { spawnWave } = loadInlineGameFunctions(['spawnWave'], {
        game, isSessionMode: () => session,
        CONFIG: {
            ASTEROID_BASE_COUNT: 10, WAVE_ASTEROID_INCREMENT: 1,
            MAX_SPEED_MULTIPLIER: 3, WAVE_SPEED_MULTIPLIER: 1.1,
        },
        spawnAsteroidAwayFromShip: isCurrent => {
            const id = nextId++;
            active++;
            maximum = Math.max(maximum, active);
            return new Promise(resolve => pending.push({
                id, isCurrent,
                complete: () => { active--; resolve(id); },
            }));
        },
        updateHUD() {}, publishDebugMetrics() {},
    });
    return { spawnWave, pending, get maximum() { return maximum; } };
}

test('ten wave creates use three bounded rounds instead of ten sequential round trips', async () => {
    const h = waveHarness();
    const task = h.spawnWave();
    assert.deepEqual(h.pending.map(value => value.id), [0, 1, 2, 3]);
    let completed = 0;
    let rounds = 0;
    while (completed < 10) {
        const batch = h.pending.slice(completed);
        completed += batch.length;
        for (const create of batch.reverse()) create.complete();
        rounds++;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(await task, true);
    assert.equal(rounds, 3);
    assert.equal(h.maximum, 4);
    assert.deepEqual(h.pending.map(value => value.id), Array.from({ length: 10 }, (_, i) => i));
});

test('wave cancellation stops scheduling further batches', async () => {
    const h = waveHarness();
    let current = true;
    const task = h.spawnWave(() => current);
    current = false;
    for (const create of h.pending) create.complete();
    assert.equal(await task, false);
    assert.equal(h.pending.length, 4);
});

test('solo spawning retains sequential generation', async () => {
    const h = waveHarness(false);
    let current = true;
    const task = h.spawnWave(() => current);
    assert.equal(h.pending.length, 1);
    current = false;
    h.pending[0].complete();
    assert.equal(await task, false);
    assert.equal(h.maximum, 1);
});

test('cancelled wave creates use existing response-first cleanup instead of installing late asteroids', async () => {
    const handlers = {};
    const deletes = [];
    let finish;
    let current = true;
    const SessionClient = {
        on: (event, callback) => { handlers[event] = callback; },
        isInSession: () => true,
        getCurrentMember: () => ({ id: 'owner' }),
        createObject: () => new Promise(resolve => { finish = resolve; }),
        deleteObject: async id => {
            deletes.push(id);
            return { success: true, memberSequence: 2 };
        },
    };
    const ObjectSync = loadClassicModule('object-sync.js', 'ObjectSync',
        { SessionClient, AuthoritativeObject, window: {} });
    ObjectSync.init();
    const { createSyncedAsteroid } = loadInlineGameFunctions(['createSyncedAsteroid'], {
        ObjectSync, isSessionMode: () => true,
        _error: (...args) => assert.fail(args.join(' ')),
    });
    const asteroid = { clampMotion() {}, toSyncData: () => ({ type: 'asteroid' }) };
    const pending = createSyncedAsteroid(asteroid, null, () => current);
    current = false;
    finish({
        objectInfo: {
            id: 'late', ownerMemberId: 'owner', creatorMemberId: 'owner',
            scope: 'Session', version: 1, data: { type: 'asteroid' },
        },
        memberSequence: 1, validAt: 1234,
    });
    await pending;
    assert.deepEqual(deletes, ['late']);
    assert.equal(ObjectSync.getObject('late'), undefined);
    assert.equal(asteroid.syncObjectId, undefined);
});
