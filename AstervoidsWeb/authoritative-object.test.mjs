import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AuthoritativeObject = require('./wwwroot/js/authoritative-object.js');

test('ObjectSync CommonJS entrypoint loads its authoritative dependency', () => {
    const ObjectSync = require('./wwwroot/js/object-sync.js');
    assert.equal(typeof ObjectSync.init, 'function');
});

function fallbackObject() {
    return {
        id: 'object',
        creatorMemberId: null,
        ownerMemberId: null,
        scope: null,
        data: { x: 3 },
        version: 3
    };
}

const snapshot = {
    id: 'object',
    creatorMemberId: 'creator',
    ownerMemberId: 'owner',
    scope: 'Session',
    data: { type: 'asteroid', x: 1, radius: 0.08 },
    version: 2
};

test('full application replaces data, metadata, version, and timing', () => {
    const target = fallbackObject();
    const applied = AuthoritativeObject.applyFull(target, { ...snapshot, version: 4 }, {
        arrivalTime: 10,
        arrivalServerTime: 20,
        validAt: 30
    });

    assert.deepEqual(target.data, snapshot.data);
    assert.equal(target.ownerMemberId, 'owner');
    assert.equal(target.version, 4);
    assert.equal(target.arrivalTime, 10);
    assert.equal(target.arrivalServerTime, 20);
    assert.equal(target.validAt, 30);
    assert.deepEqual(applied, {
        changed: true,
        oldType: undefined,
        newType: 'asteroid'
    });
});

test('patch application merges data without discarding static fields', () => {
    const target = {
        ...fallbackObject(),
        data: { type: 'asteroid', radius: 0.08, x: 1 }
    };

    AuthoritativeObject.applyPatch(target, {
        data: { x: 2 },
        version: 4
    });

    assert.deepEqual(target.data, { type: 'asteroid', radius: 0.08, x: 2 });
    assert.equal(target.version, 4);
});

test('join-style backfill fills missing data but never overwrites newer values', () => {
    const target = fallbackObject();

    const applied = AuthoritativeObject.backfill(target, snapshot, {
        includeData: true,
        validAt: 50
    });

    assert.deepEqual(target.data, { x: 3, type: 'asteroid', radius: 0.08 });
    assert.equal(target.ownerMemberId, 'owner');
    assert.equal(target.validAt, 50);
    assert.equal(target.version, 3);
    assert.equal(applied.changed, true);
});

test('reconciliation-style backfill fills metadata but not equal-version data', () => {
    const target = fallbackObject();

    AuthoritativeObject.backfill(target, snapshot, {
        includeData: false,
        validAt: 50
    });

    assert.deepEqual(target.data, { x: 3 });
    assert.equal(target.ownerMemberId, 'owner');
    assert.equal(target.validAt, 50);
    assert.equal(target.version, 3);
});
