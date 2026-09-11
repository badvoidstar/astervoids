import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');
const source = readFileSync(new URL('./wwwroot/js/object-sync.js', import.meta.url), 'utf8');

function bulletHarness({ deltaEncoding = true } = {}) {
    const handlers = {};
    const requests = [];
    let accept = true;
    const SessionClient = {
        on: (event, callback) => { handlers[event] = callback; },
        isInSession: () => true,
        getCurrentMember: () => ({ id: 'owner' }),
        updateObjects: async updates => {
            requests.push(structuredClone(updates));
            return {
                versions: accept ? { bullet: requests.length + 1 } : {},
                memberSequence: requests.length,
            };
        },
    };
    const ObjectSync = new Function('SessionClient', 'AuthoritativeObject', 'window',
        `${source}\nreturn ObjectSync;`)(SessionClient, AuthoritativeObject, {});
    ObjectSync.init();
    ObjectSync.configure({ deltaEncoding });
    const { Bullet, syncLocalBullets, updateLocalBullet } = loadInlineGameFunctions(
        ['Bullet', 'syncLocalBullets', 'updateLocalBullet'], {
            CONFIG: { BULLET_LIFETIME: 60, BULLET_RADIUS: 0.0033 },
            OBJECT_TYPES: { BULLET: 'bullet' },
            SessionClient, ObjectSync,
            game: { get bullets() { return [bullet]; } },
            isSessionMode: () => true,
            SendGate: { shouldSend: () => false },
            velocityToNormalizedDeltaX: value => value / 60,
            velocityToNormalizedDeltaY: value => value / 60,
            wrapMarginX: () => 0.0033, wrapMarginY: () => 0.0033,
            wrapNormalized: value => value,
            deleteSyncedBullet: value => deleted.push(value.syncObjectId),
        });
    const bullet = new Bullet(0.2, 0.3, 0.1, 0, 0, 'owner');
    bullet.syncObjectId = 'bullet';
    const deleted = [];
    handlers.onSessionJoined({
        objects: [{
            id: 'bullet', data: bullet.toSyncData(), version: 1,
            ownerMemberId: 'owner', creatorMemberId: 'owner', scope: 'Member',
        }],
    });
    return {
        bullet, ObjectSync, syncLocalBullets, updateLocalBullet, requests, deleted,
        reject: () => { accept = false; },
        accept: () => { accept = true; },
    };
}

for (const deltaEncoding of [true, false]) {
    test(`pending claims stop motion traffic after confirmation (delta=${deltaEncoding})`, async () => {
        const h = bulletHarness({ deltaEncoding });
        h.bullet.pendingHit = true;
        h.bullet.hitTargetId = 'target';
        for (let frame = 0; frame < 60; frame++) {
            h.syncLocalBullets();
            await h.ObjectSync.flushUpdates();
            h.updateLocalBullet(h.bullet, 1, 'owner');
        }
        assert.equal(h.requests.length, 1, 'one accepted claim, not 60 changing poses');
        assert.deepEqual(h.requests[0][0].data, h.bullet.toHitData());
        assert.equal(h.bullet.lifetime, 0);
        assert.deepEqual(h.deleted, ['bullet'], 'local expiration still retires the object');
    });
}

test('unconfirmed pending claims retry and never include later motion', async () => {
    const h = bulletHarness();
    h.bullet.pendingHit = true;
    h.bullet.hitTargetId = 'target';
    h.reject();
    for (let frame = 0; frame < 3; frame++) {
        h.syncLocalBullets();
        await h.ObjectSync.flushUpdates();
        h.updateLocalBullet(h.bullet, 1, 'owner');
    }
    assert.equal(h.requests.length, 3);
    for (const request of h.requests) {
        assert.deepEqual(request[0].data, h.bullet.toHitData());
    }
    h.accept();
    h.syncLocalBullets();
    await h.ObjectSync.flushUpdates();
    h.syncLocalBullets();
    await h.ObjectSync.flushUpdates();
    assert.equal(h.requests.length, 4);
});

test('non-pending bullets still respect their motion gate', async () => {
    const h = bulletHarness();
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
    const ObjectSync = new Function('SessionClient', 'AuthoritativeObject', 'window',
        `${source}\nreturn ObjectSync;`)(SessionClient, AuthoritativeObject, {});
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
