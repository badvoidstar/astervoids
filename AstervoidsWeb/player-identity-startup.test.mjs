import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const { createClient, STORAGE_KEY, REQUEST_TIMEOUT_MS, INITIAL_RESOLVE_POLICY: policy } =
    createRequire(import.meta.url)('./wwwroot/js/player-identity.js');
const origin = 'https://example.com';
const regions = ['first', 'second', 'third'].map(id => ({
    id, displayName: id, hostname: `https://${id}.example.com`,
}));
const identity = { id: '00112233-4455-6677-8899-aabbccddeeff', tag: 'Pilot' };
const binding = { identity, etag: 'b1', revision: 1 };
const resolved = { binding, promptOnRoot: true, invite: null };
const response = (body = resolved, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers });
const cold = (status = 503, headers = {}) => new Response('<html>Starting</html>', { status, headers });
const drain = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function harness(options = {}) {
    let time = 0;
    let nextTimer = 0;
    let held = 0;
    let tail = Promise.resolve();
    const timers = new Map();
    const requests = [];
    const replies = [];
    const signals = new Set();
    const values = new Map();
    const document = new EventTarget();
    document.hidden = options.hidden ?? false;
    const lifecycle = new EventTarget();
    const locks = {
        request(name, options, action) {
            assert.equal(name, 'astervoids.identity');
            if (typeof options === 'function') action = options;
            // Deliberately let a cancelled waiter reach its callback too. The
            // production signal guard must prevent credential use/adoption.
            const running = tail.then(async () => {
                held++;
                try { return await action(); } finally { held--; }
            });
            tail = running.catch(() => {});
            return running;
        },
    };
    const client = createClient({
        crypto: webcrypto,
        location: { origin },
        bootstrap: { regionId: null, regions },
        storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        locks, document, lifecycle,
        now: () => time,
        setTimeout: (action, delay) => {
            timers.set(++nextTimer, { action, at: time + delay });
            return nextTimer;
        },
        clearTimeout: id => timers.delete(id),
        fetch: async (url, init) => {
            requests.push({ url, init, time });
            signals.add(init.signal);
            assert.ok(replies.length, 'Requests must have explicit fixtures');
            const reply = replies.shift();
            if (reply instanceof Error) throw reply;
            return typeof reply === 'function' ? reply(init) : reply;
        },
        ...options,
    });
    async function advance(ms) {
        await drain();
        const target = time + ms;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            time = next[1].at;
            timers.delete(next[0]);
            next[1].action();
            await drain();
        }
        time = target;
        await drain();
    }
    function clean() {
        assert.equal(timers.size, 0, 'No deadline, request or retry timers remain');
        assert.equal(held, 0, 'No Web Lock remains held');
        for (const signal of signals) assert.equal(getEventListeners(signal, 'abort').length, 0);
        assert.equal(getEventListeners(document, 'visibilitychange').length, 0);
    }
    return {
        client, requests, replies, values, timers, locks, document, lifecycle, advance, clean,
        held: () => held,
        hide: () => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
    };
}

test('initial success has no artificial delay and uses only the fixed first-region authority', async () => {
    const h = harness();
    h.replies.push(response());
    assert.deepEqual(await h.client.resolveInitial(), resolved);
    assert.deepEqual(h.requests.map(request => [request.url, request.time]),
        [[`${regions[0].hostname}/api/identity/resolve`, 0]]);
    assert.deepEqual(h.client.current(), identity);
    h.clean();
});

test('fast cold gateway responses remain automatic while the service takes 20 seconds to wake', async () => {
    const h = harness();
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
        h.replies.push(() => h.requests.at(-1).time < 20_000 ? cold() : response());
    }
    await Promise.all([
        assert.doesNotReject(h.client.resolveInitial()),
        h.advance(policy.budgetMs),
    ]);
    assert.deepEqual(h.client.current(), identity);
    assert.ok(h.requests.at(-1).time >= 20_000);
    assert.ok(h.requests.at(-1).time < policy.budgetMs);
    h.clean();
});

for (const firstReply of [
    () => new Error('private network details must not escape'),
    () => cold(502),
    () => cold(503),
    () => cold(504),
    () => response({ error: { code: 'identity_unavailable' } }, 503),
    () => response({ error: { code: 'rate_limited' } }, 429),
]) {
    test(`initial resolution recovers automatically from ${firstReply().status ?? 'network failure'}`, async () => {
        const h = harness();
        h.replies.push(firstReply(), response());
        const starting = h.client.resolveInitial();
        await h.advance(policy.retryDelayMs - 1);
        assert.equal(h.requests.length, 1);
        assert.equal(h.held(), 0, 'Backoff releases the Web Lock');
        assert.equal(h.client.current(), null);
        await h.advance(1);
        await starting;
        assert.equal(h.requests.length, 2);
        const tokens = h.requests.map(request => request.init.headers['X-Astervoids-Browser']);
        assert.equal(tokens[0], tokens[1], 'Retries retain the durable browser credential');
        assert.equal(tokens[0], h.values.get(STORAGE_KEY));
        assert.equal(h.requests[0].init.body, h.requests[1].init.body);
        assert.equal(h.client.hasPendingOperation(), false);
        h.clean();
    });
}

test('a timed-out request frees its Web Lock and late success cannot overwrite the retry binding', async () => {
    const h = harness();
    const stale = deferred();
    h.replies.push(() => stale.promise, response());
    const starting = h.client.resolveInitial();
    await h.advance(REQUEST_TIMEOUT_MS);
    assert.equal(h.requests[0].init.signal.aborted, true);
    assert.equal(h.held(), 0);
    await h.advance(policy.retryDelayMs);
    await starting;
    stale.resolve(response({ ...resolved, binding: { ...binding, identity: null } }));
    await drain();
    assert.deepEqual(h.client.current(), identity);
    h.clean();
});

test('numeric Retry-After on non-JSON cold responses is honored without holding a lock', async () => {
    const h = harness();
    h.replies.push(cold(503, { 'Retry-After': '4' }), response());
    const starting = h.client.resolveInitial();
    await h.advance(3_999);
    assert.equal(h.requests.length, 1);
    await h.locks.request('astervoids.identity', () => assert.equal(h.held(), 1));
    await h.advance(1);
    await starting;
    assert.equal(h.requests[1].time, 4_000);
    h.clean();
});

test('a response-body timeout cannot turn a permanent HTTP rejection into an automatic retry', async () => {
    const h = harness();
    h.replies.push(() => ({ ok: false, status: 403, json: () => new Promise(() => {}) }));
    const failed = assert.rejects(h.client.resolveInitial(), { code: 'identity_unavailable' });
    await h.advance(REQUEST_TIMEOUT_MS);
    await failed;
    assert.equal(h.requests.length, 1);
    h.clean();
});

test('Retry-After is retained when a transient response body itself times out', async () => {
    const h = harness();
    h.replies.push(() => ({
        ok: false, status: 429, headers: new Headers({ 'Retry-After': '4' }),
        json: () => new Promise(() => {}),
    }), response());
    const starting = h.client.resolveInitial();
    await h.advance(REQUEST_TIMEOUT_MS + 3_999);
    assert.equal(h.requests.length, 1);
    await h.advance(1);
    await starting;
    h.clean();
});

test('Retry-After cannot extend the total budget or cause an early retry', async () => {
    const h = harness();
    h.replies.push(cold(503, { 'Retry-After': String(policy.budgetMs / 1000 + 1) }));
    const failed = assert.rejects(h.client.resolveInitial(), { code: 'identity_unavailable' });
    await h.advance(policy.budgetMs);
    await failed;
    assert.equal(h.requests.length, 1);
    await h.advance(policy.budgetMs);
    assert.equal(h.requests.length, 1, 'Exhaustion does not leave a background retry');
    h.clean();
});

test('repeated request timeouts are clipped by the total budget before exhausting the attempt limit', async () => {
    const h = harness();
    for (let i = 0; i < policy.maxAttempts; i++) h.replies.push(() => new Promise(() => {}));
    const failed = assert.rejects(h.client.resolveInitial(), { code: 'identity_unavailable' });
    await h.advance(policy.budgetMs);
    await failed;
    assert.ok(h.requests.length < policy.maxAttempts);
    assert.ok(h.requests.every(request => request.init.signal.aborted));
    assert.deepEqual(h.requests.map(request => request.time), [
        0, REQUEST_TIMEOUT_MS + policy.retryDelayMs,
        REQUEST_TIMEOUT_MS * 2 + policy.retryDelayMs * 3,
        REQUEST_TIMEOUT_MS * 3 + policy.retryDelayMs * 6,
    ]);
    h.clean();
});

test('persistent fast gateway failures reach the attempt limit without leaving background retries', async () => {
    const h = harness();
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) h.replies.push(cold());
    const failed = assert.rejects(h.client.resolveInitial(), { code: 'identity_unavailable' });
    await h.advance(policy.budgetMs);
    await failed;
    assert.equal(h.requests.length, policy.maxAttempts);
    assert.ok(h.requests.at(-1).time < policy.budgetMs);
    h.clean();
    await h.advance(policy.budgetMs);
    assert.equal(h.requests.length, policy.maxAttempts);
});

test('initial budget also includes waiting for the identity Web Lock', async () => {
    const h = harness();
    const held = deferred();
    const lock = h.locks.request('astervoids.identity', () => held.promise);
    const failed = assert.rejects(h.client.resolveInitial(), { code: 'identity_unavailable' });
    await h.advance(policy.budgetMs);
    await failed;
    assert.equal(h.requests.length, 0);
    held.resolve();
    await lock;
    await drain();
    assert.equal(h.values.size, 0, 'A cancelled queued callback must not create a credential');
    h.clean();
});

test('initial manifest network failure retries discovery, not a guessed credential authority', async () => {
    const h = harness({ bootstrap: null });
    h.replies.push(cold(503), response({ regionId: 'local', regions: [] }), response());
    const starting = h.client.resolveInitial();
    await h.advance(policy.retryDelayMs);
    await starting;
    assert.deepEqual(h.requests.map(request => request.url),
        [`${origin}/api/regions`, `${origin}/api/regions`, `${origin}/api/identity/resolve`]);
    assert.equal(h.requests[0].init.headers, undefined);
    h.clean();
});

for (const [name, reply, code = 'identity_unavailable'] of [
    ['malformed success JSON', () => new Response('<html>Not JSON</html>')],
    ['null success', () => response(null)],
    ['incomplete success', () => response({})],
    ['invalid binding', () => response({ ...resolved, binding: {} })],
    ['unknown JSON protocol', () => response({ error: { code: 'unknown_protocol' } }, 503)],
    ['permanent HTTP', () => cold(403)],
    ['invalid credential even with a transient status',
        () => response({ error: { code: 'invalid_browser_credential' } }, 503), 'invalid_browser_credential'],
    ['expired invite', () => response({ error: { code: 'invite_not_found' } }, 404), 'invite_not_found'],
    ['conflicting binding', () => response({ error: { code: 'binding_changed' } }, 409), 'binding_changed'],
]) {
    test(`initial ${name} remains explicit without automatic retry or guest adoption`, async () => {
        const h = harness();
        h.replies.push(reply());
        await assert.rejects(h.client.resolveInitial(), { code });
        await h.advance(policy.budgetMs);
        assert.equal(h.requests.length, 1);
        assert.equal(h.client.current(), null);
        h.clean();
    });
}

test('initial local storage and unsupported Web Locks failures do not start retry timers', async () => {
    for (const options of [
        { storage: { getItem() { throw new Error('denied'); } } },
        { storage: { getItem: () => 'invalid' } },
        { locks: {} },
    ]) {
        const h = harness(options);
        await assert.rejects(h.client.resolveInitial(), error =>
            ['storage_unavailable', 'invalid_browser_credential'].includes(error.code));
        assert.equal(h.requests.length, 0);
        h.clean();
    }
});

test('initial malformed invitation response is not a transient failure', async () => {
    const h = harness();
    h.replies.push(response());
    await assert.rejects(h.client.resolveInitial(Buffer.alloc(32, 5).toString('base64url')),
        { code: 'identity_unavailable' });
    assert.equal(h.requests.length, 1);
    assert.equal(h.client.current(), null);
    h.clean();
});

for (const phase of ['fetch', 'body', 'backoff']) {
    test(`cancelling initial ${phase} releases locks, timers and listeners without adopting stale data`, async () => {
        const h = harness();
        const stopped = new AbortController();
        const late = deferred();
        h.replies.push(phase === 'backoff' ? cold() : phase === 'body'
            ? () => ({ ok: true, json: () => late.promise }) : () => late.promise);
        const cancelled = assert.rejects(h.client.resolveInitial(undefined, { signal: stopped.signal }),
            { code: 'identity_cancelled' });
        await drain();
        stopped.abort();
        await cancelled;
        await drain();
        late.resolve(phase === 'body' ? resolved : response());
        await h.advance(policy.budgetMs);
        assert.equal(h.requests.length, 1);
        assert.equal(h.client.current(), null);
        assert.equal(getEventListeners(stopped.signal, 'abort').length, 0);
        h.clean();
    });
}

for (const replacement of ['initial', 'refresh', 'deactivate']) {
    test(`${replacement} supersedes initial resolution before internal binding adoption`, async () => {
        const h = harness();
        const stale = deferred();
        h.replies.push(() => stale.promise, response());
        const old = assert.rejects(h.client.resolveInitial(), { code: 'identity_cancelled' });
        await drain();
        if (replacement === 'deactivate') h.client.deactivate();
        else if (replacement === 'refresh') await h.client.resolve();
        else await h.client.resolveInitial();
        await old;
        stale.resolve(response({ ...resolved, binding: { ...binding, identity: null } }));
        await drain();
        assert.deepEqual(h.client.current(), replacement === 'deactivate' ? null : identity);
        h.clean();
    });
}

test('a changed durable credential between attempts stops rather than retrying as another browser', async () => {
    const h = harness();
    h.replies.push(cold());
    const failed = assert.rejects(h.client.resolveInitial(), { code: 'binding_changed' });
    await drain();
    h.values.set(STORAGE_KEY, Buffer.alloc(32, 9).toString('base64url'));
    await h.advance(policy.retryDelayMs);
    await failed;
    assert.equal(h.requests.length, 1);
    h.clean();
});

test('a hidden document cancels the retry even before the visibility event is dispatched', async () => {
    const h = harness();
    h.replies.push(cold());
    const cancelled = assert.rejects(h.client.resolveInitial(), { code: 'identity_cancelled' });
    await drain();
    h.document.hidden = true;
    await h.advance(policy.retryDelayMs);
    await cancelled;
    assert.equal(h.requests.length, 1);
    h.clean();
});

test('normal refresh remains single-attempt and mutations are never replayed by the initial retry policy', async () => {
    const h = harness();
    h.replies.push(response(), cold(), cold(), response({ binding }));
    await h.client.resolveInitial();
    await assert.rejects(h.client.resolve(), { code: 'identity_unavailable' });
    await assert.rejects(h.client.create(identity.tag), { code: 'identity_unavailable' });
    assert.equal(h.client.hasPendingOperation(), true);
    await h.advance(policy.budgetMs);
    assert.equal(h.requests.length, 3);
    await h.client.retry();
    assert.equal(h.requests[2].init.body, h.requests[3].init.body, 'Explicit retry retains mutation idempotency');
    h.clean();
});

test('preparation starts all distinct regions concurrently even when the first is stalled', async () => {
    const h = harness({ bootstrap: { regionId: null, regions: [...regions, regions[0]] } });
    const first = deferred();
    h.replies.push(() => first.promise, response({}), response({}), response());
    const preparing = h.client.prepareRegions();
    await drain();
    assert.deepEqual(h.requests.map(request => request.url), regions.map(region => `${region.hostname}/api/ping`));
    assert.equal(h.values.size, 0);
    await h.client.resolveInitial();
    assert.equal(h.requests.at(-1).url, `${regions[0].hostname}/api/identity/resolve`);
    first.resolve(response({}));
    assert.equal(await preparing, true);
    h.clean();
});

for (const stop of ['hide', 'teardown', 'pagehide']) {
    test(`${stop} cancels early preparation, including body reads, without replay on visibility resume`, async () => {
        const h = harness();
        for (const _ of regions) h.replies.push(() => ({ ok: true, json: () => new Promise(() => {}) }));
        const preparing = h.client.prepareRegions();
        await drain();
        if (stop === 'hide') h.hide();
        else if (stop === 'pagehide') h.lifecycle.dispatchEvent(new Event('pagehide'));
        else h.client.cancelPreparation();
        assert.equal(await preparing, false);
        h.document.hidden = false;
        h.document.dispatchEvent(new Event('visibilitychange'));
        assert.equal(await h.client.prepareRegions(), false);
        assert.equal(h.requests.length, regions.length);
        assert.equal(getEventListeners(h.document, 'visibilitychange').length, 0);
        assert.equal(getEventListeners(h.lifecycle, 'pagehide').length, 0);
        h.clean();
    });
}

test('hidden startup and a malformed later region cannot issue early preparation requests', async () => {
    const hidden = harness({ hidden: true });
    assert.equal(await hidden.client.prepareRegions(), false);
    assert.equal(hidden.requests.length, 0);
    hidden.clean();
    const invalid = harness({ bootstrap: { regions: [...regions, { hostname: `${origin}/path` }] } });
    await assert.rejects(invalid.client.prepareRegions(), { code: 'identity_unavailable' });
    assert.equal(invalid.requests.length, 0, 'Validate the whole configured list before sending');
    invalid.clean();
});

test('script entry starts regional discovery before the identity flow, not on menu activation', () => {
    const source = readFileSync(new URL('wwwroot/index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    assert.match(source,
        /void initRegionService\(\);\s+void beginIdentityFlow\(\);\s+requestAnimationFrame\(gameLoop\);/,
        'The actual script entry, not an invitation callback, must start both services before the frame driver');
    const identityScript = source.indexOf('src="/js/player-identity.js"');
    assert.ok(identityScript >= 0 && identityScript < source.indexOf('PlayerIdentity.prepareRegions()'),
        'Invite capture still precedes every preparation request');
});

test('permanent initial identity failures show Retry, never an unverified root guest action', async () => {
    const dialogs = [];
    const { beginIdentityFlow } = loadInlineGameFunctions(['beginIdentityFlow'], {
        identityStarted: false, identityFlowEpoch: 0, identityFlowController: null, identityInvite: null,
        identityStartupPaused: false, identityStartupForceNaming: false,
        isSessionPickerActive: () => true,
        PlayerIdentity: {
            resolveInitial: async () => { throw Object.assign(new Error(), { code: 'invalid_browser_credential' }); },
            deactivate() {},
        },
        activateIdentityMenu: () => assert.fail('Unverified guest activation is forbidden'),
        showIdentityDialog: (...args) => dialogs.push(args),
        identityMessage: error => error.code, leaveIdentityGame: async () => {}, setIdentityBusy() {},
    });
    await beginIdentityFlow();
    assert.equal(dialogs[1][0], 'Player identity unavailable');
    assert.equal(dialogs[1][1], 'invalid_browser_credential');
    assert.equal(dialogs[1][3], 'Retry');
    assert.equal(typeof dialogs[1][4], 'function');
    assert.equal(dialogs[1][5], null);
});

test('static multiregion menu activation cannot connect the nonexistent apex hub or reinitialize discovery', () => {
    let connects = 0;
    const { activateIdentityMenu } = loadInlineGameFunctions(['activateIdentityMenu'], {
        identityStarted: false, game: {}, identityDialog: { close() {} }, setIdentityBusy() {},
        PlayerIdentity: { current: () => identity },
        leaderboardOutbox: { refresh() {}, flush() {} },
        document: { getElementById: () => ({}) },
        window: { ASTERVOIDS_REGION_BOOTSTRAP: { regionId: null, regions } },
        connectToSessionHub: () => { connects++; },
        initRegionService: () => assert.fail('Discovery must already be in progress'),
    });
    activateIdentityMenu();
    activateIdentityMenu();
    assert.equal(connects, 0);
});
