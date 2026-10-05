import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const { createClient, captureInvite, apiOrigin, STORAGE_KEY, CHANGE_KEY } =
    require('./wwwroot/js/player-identity.js');
const Wire = require('./wwwroot/js/astervoids-wire-codec.js');
const first = { id: '00112233-4455-6677-8899-aabbccddeeff', tag: 'Pilot_1' };
const second = { id: '11223344-5566-7788-99aa-bbccddeeff00', tag: 'Nova-2' };
const token = Buffer.alloc(32, 7).toString('base64url');
const location = { origin: 'https://example.com', pathname: '/', search: '' };
const empty = { identity: null, etag: 'b0', revision: 0 };
const binding = { identity: first, etag: 'b1', revision: 1 };
const active = { identityId: first.id, tag: first.tag, state: 'active', etag: 'i1' };
const pending = { ...active, tag: null, state: 'pending', etag: 'i0' };
const resolved = (value = empty, invite = null, promptOnRoot = true) =>
    ({ binding: value, invite, promptOnRoot });

function subject(options = {}) {
    const values = options.values ?? new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    let tail = Promise.resolve();
    const locks = options.locks ?? {
        request(name, work) {
            assert.equal(name, 'astervoids.identity');
            const running = tail.then(work);
            tail = running.catch(() => {});
            return running;
        },
    };
    const requests = [];
    const replies = [];
    const fetch = async (url, init) => {
        requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        assert.ok(replies.length, 'Each request needs an explicit fixture response');
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        const data = typeof reply === 'function' ? await reply() : reply;
        return new Response(JSON.stringify(data?.body ?? data), {
            status: data?.status ?? 200, headers: { 'Content-Type': 'application/json' },
        });
    };
    const client = createClient({
        storage, locks, crypto: webcrypto, fetch, location,
        bootstrap: { regionId: 'local', regions: [{ hostname: location.origin }] }, ...options,
    });
    return { client, requests, replies, values, storage, locks };
}

test('invites are captured once and scrubbed before any request, including malformed links', () => {
    for (const hash of [`#invite=${token}`, '#invite=bad', `#invite=${token}&invite=${token}`]) {
        const calls = [];
        const result = captureInvite({ ...location, pathname: '/game', search: '?mode=1', hash }, {
            replaceState: (...args) => calls.push(args),
        });
        assert.deepEqual(calls, [[null, '', '/game?mode=1']]);
        assert.deepEqual(result, hash === `#invite=${token}` ? { token } : { invalid: true });
    }
    assert.equal(captureInvite({ ...location, hash: '#help' }, {
        replaceState: () => assert.fail('unrelated anchors are not modified'),
    }), null);
});

test('runtime discovery uses own regional origin or the static deployment manifest, never a URL parameter', () => {
    assert.equal(apiOrigin(location, { regionId: 'region-1', regions: [] }), location.origin);
    assert.equal(apiOrigin(location, {
        regionId: null, regions: [{ hostname: 'https://region.example.com' }],
    }), 'https://region.example.com');
    for (const hostname of [
        'https://example.com/redirect', 'https://user:pass@example.com',
        'https://example.com/?next=1', 'https://example.com/#x', 'http://example.com',
        'javascript:alert(1)', undefined,
    ]) {
        assert.throws(() => apiOrigin(location, { regions: [{ hostname }] }),
            { message: 'identity_unavailable' });
    }
});

test('simultaneous browser clients initialize exactly one persistent random credential under Web Locks', async () => {
    const a = subject();
    const b = subject({ storage: a.storage, locks: a.locks });
    a.replies.push(resolved());
    b.replies.push(resolved());
    await Promise.all([a.client.resolve(), b.client.resolve()]);
    const saved = a.values.get(STORAGE_KEY);
    assert.equal(Buffer.from(saved, 'base64url').length, 32);
    for (const h of [a, b]) {
        const request = h.requests[0];
        assert.equal(request.init.headers['X-Astervoids-Browser'], saved);
        assert.equal(request.init.redirect, 'error');
        assert.equal(request.init.credentials, 'omit');
        assert.equal(request.init.cache, 'no-store');
        assert.equal(request.init.referrerPolicy, 'no-referrer');
        assert.equal(request.url, `${location.origin}/api/identity/resolve`);
    }
});

test('storage and locking failures are explicit and never use a temporary per-tab identity', async () => {
    for (const options of [
        { locks: {} },
        { storage: { getItem() { throw new Error('storage denied'); } } },
        { storage: { getItem: () => 'invalid-credential' } },
    ]) {
        const h = subject(options);
        h.replies.push(resolved());
        await assert.rejects(h.client.resolve(), error =>
            ['storage_unavailable', 'invalid_browser_credential'].includes(error.code));
        assert.equal(h.client.current(), null);
    }
});

test('the shipped empty bootstrap falls through to the regional manifest without sending a credential', async () => {
    const h = subject({ bootstrap: { regionId: null, displayName: null, regions: [] } });
    h.replies.push({ regionId: 'local', regions: [] }, resolved());
    await h.client.resolve();
    assert.equal(h.requests[0].url, `${location.origin}/api/regions`);
    assert.equal(h.requests[0].init.headers, undefined);
    assert.equal(h.requests[1].url, `${location.origin}/api/identity/resolve`);
});

test('silent root activation clears the loading state and enables both invitation buttons', () => {
    const elements = Object.fromEntries(['identity-status', 'btn-invite-self', 'btn-invite-friend']
        .map(id => [id, { disabled: true }]));
    const game = { identityChanging: true };
    const accept = { disabled: true };
    const input = { readOnly: true };
    const { activateIdentityMenu } = loadInlineGameFunctions(['activateIdentityMenu', 'setIdentityBusy'], {
        game, identityBusy: true, identityStarted: true, identityRefreshRequested: false,
        identityDialog: { close() {} },
        identityAccept: accept, identityIgnore: {}, identityTagInput: input,
        PlayerIdentity: { current: () => first, hasPendingOperation: () => false },
        document: { getElementById: id => elements[id] },
    });
    activateIdentityMenu();
    assert.equal(game.identityChanging, false);
    assert.equal(accept.disabled, false);
    assert.equal(input.readOnly, false);
    assert.equal(elements['btn-invite-self'].disabled, false);
    assert.equal(elements['btn-invite-friend'].disabled, false);
    assert.equal(elements['identity-status'].textContent, `Playing as ${first.tag}`);
});

test('root switch false leaves the browser anonymous while allowing an explicit naming operation', async () => {
    const h = subject();
    h.replies.push(resolved(empty, null, false), { binding });
    assert.equal((await h.client.resolve()).promptOnRoot, false);
    assert.equal(h.client.current(), null);
    assert.equal(h.requests.length, 1);
    await h.client.create(first.tag);
    assert.deepEqual(h.client.current(), first);
    assert.deepEqual(h.requests[1].body.expectedBinding, { identityId: null, etag: 'b0' });
    assert.ok(h.values.has(CHANGE_KEY));
});

test('active recovery confirmation never renames and captures the binding shown to the user', async () => {
    const h = subject();
    h.replies.push(resolved(empty, active), resolved({ identity: second, etag: 'b2', revision: 2 }),
        { status: 409, body: { error: { code: 'binding_changed' } } });
    const view = await h.client.resolve(token);
    await h.client.resolve();
    await assert.rejects(h.client.accept(token, active, 'Ignored', {
        identityId: view.binding.identity?.id ?? null, etag: view.binding.etag,
    }), { message: 'binding_changed' });
    const body = h.requests[2].body;
    assert.equal(Object.hasOwn(body, 'tag'), false);
    assert.deepEqual(body.expectedBinding, { identityId: null, etag: 'b0' });
    assert.deepEqual(h.client.current(), second);
    assert.equal(h.client.hasPendingOperation(), false);
    assert.equal(h.requests.length, 3, 'conflicts never trigger automatic replacement');
});

test('uncertain claims retain the exact request and retry rather than issuing another identity', async () => {
    const h = subject();
    h.replies.push(resolved(empty, pending), new Error('private network detail'), { binding });
    await h.client.resolve(token);
    await assert.rejects(h.client.accept(token, pending, first.tag), { message: 'identity_unavailable' });
    assert.equal(h.client.hasPendingOperation(), true);
    await assert.rejects(h.client.create('Other'), { message: 'operation_pending' });
    await h.client.retry();
    assert.equal(h.requests[1].init.body, h.requests[2].init.body);
    assert.deepEqual(h.client.current(), first);
    assert.equal(h.client.hasPendingOperation(), false);
});

test('an incomplete success response remains retryable and never claims a binding was activated', async () => {
    for (const response of [{}, { binding: null }, { binding: { identity: first } }]) {
        const h = subject();
        h.replies.push(resolved(), response, { binding });
        await h.client.resolve();
        await assert.rejects(h.client.create(first.tag), { message: 'identity_unavailable' });
        assert.equal(h.client.hasPendingOperation(), true);
        assert.equal(h.client.current(), null);
        await h.client.retry();
        assert.equal(h.requests[1].init.body, h.requests[2].init.body);
        assert.deepEqual(h.client.current(), first);
    }
});

test('identity invalidation cancels picker joins before a session snapshot exists', async () => {
    const events = [];
    const game = { state: 'start', playerIdentity: first };
    let finishDisconnect;
    const disconnected = new Promise(resolve => { finishDisconnect = resolve; });
    const { leaveIdentityGame } = loadInlineGameFunctions(['leaveIdentityGame'], {
        game, identityStarted: true, identityLeave: null, startGameOperation: null,
        pendingRejoinSessionId: 'old-session',
        cancelPickerOperations: () => events.push('cancel-picker'),
        beginVoluntarySessionLeave: () => events.push('prevent-rejoin'),
        releaseIdentityInput: () => events.push('release-input'),
        SessionClient: {
            isInSession: () => false,
            disconnect: () => { events.push('disconnect'); return disconnected; },
        },
        returnToStartScreen: async () => { events.push('menu'); },
    });
    const leaving = leaveIdentityGame();
    const again = leaveIdentityGame();
    assert.equal(game.identityChanging, true);
    assert.deepEqual(events, ['cancel-picker', 'prevent-rejoin', 'release-input', 'disconnect']);
    finishDisconnect();
    await Promise.all([leaving, again]);
    assert.equal(events.filter(event => event === 'disconnect').length, 1);
    assert.equal(events.at(-1), 'menu');
    assert.equal(game.playerIdentity, null);
});

test('a browser binding change invalidates pending membership even while the game is on the menu', async () => {
    let leaves = 0;
    const status = {};
    const { handlePlayerIdentityChange } = loadInlineGameFunctions(['handlePlayerIdentityChange'], {
        identityStarted: true, game: { state: 'start' },
        document: { getElementById: () => status },
        shareDialog: { close() {} },
        leaveIdentityGame: async () => { leaves++; },
        identityNotice() {}, identityMessage() {},
    });
    handlePlayerIdentityChange(second, first);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(leaves, 1);
    assert.equal(status.textContent, `Playing as ${second.tag}`);
    handlePlayerIdentityChange(second, second);
    assert.equal(leaves, 1);
});

test('binding refreshes coalesce but are never lost during another request or invitation action', async () => {
    const game = {};
    const requests = [];
    const { refreshBrowserIdentity, setIdentityBusy } = loadInlineGameFunctions([
        'refreshBrowserIdentity', 'setIdentityBusy',
    ], {
        game, identityStarted: true, identityBusy: true, identityRefresh: null,
        identityRefreshRequested: false, identityLeave: null,
        PlayerIdentity: {
            hasPendingOperation: () => false,
            resolve: () => new Promise(resolve => { requests.push(resolve); }),
        },
        SessionClient: { getLastSessionId: () => null },
        identityAccept: {}, identityIgnore: {}, identityTagInput: {},
        document: { getElementById: () => ({}) },
    });
    refreshBrowserIdentity();
    assert.equal(game.identityChanging, true);
    assert.equal(requests.length, 0);
    setIdentityBusy(false);
    assert.equal(requests.length, 1);
    refreshBrowserIdentity();
    refreshBrowserIdentity();
    assert.equal(requests.length, 1);
    requests[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(game.identityChanging, true);
    requests[1]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(game.identityChanging, false);
});

test('self links reuse backend tokens and friend creation does not replace the current binding', async () => {
    const h = subject();
    h.replies.push(resolved(binding), { inviteToken: token }, { inviteToken: token });
    await h.client.resolve();
    assert.equal((await h.client.inviteSelf()).inviteToken, token);
    assert.equal((await h.client.inviteFriend()).inviteToken, token);
    assert.equal(h.client.link(token), `https://example.com/#invite=${token}`);
    assert.deepEqual(h.client.current(), first);
    assert.equal(h.requests[1].body.expectedBinding.identityId, first.id);
});

test('public identity notifications and errors contain no browser credential or invitation capability', async () => {
    const h = subject();
    const changes = [];
    h.client.subscribe((next, previous) => changes.push([next, previous]));
    h.replies.push(resolved(binding), resolved(binding),
        resolved({ identity: second, etag: 'b2', revision: 2 }),
        new TypeError('failed fetch to private deployment'));
    await h.client.resolve();
    await h.client.resolve();
    await h.client.resolve();
    assert.deepEqual(changes, [[first, null], [second, first]]);
    await assert.rejects(h.client.resolve(), { message: 'identity_unavailable' });
    assert.equal(Object.isFrozen(h.client.current()), true);
    assert.equal(JSON.stringify(changes).includes(h.values.get(STORAGE_KEY)), false);
});

test('tag maps are GUID sorted, bounded ASCII, strict, and retain zero-score historical names', () => {
    const tags = { [second.id.toUpperCase()]: second.tag, [first.id]: first.tag };
    const packed = Wire.packTagMap(tags);
    assert.deepEqual(Wire.unpackTagMap(packed), { [first.id]: first.tag, [second.id]: second.tag });
    assert.equal(packed.length, 17 * 2 + first.tag.length + second.tag.length);
    assert.deepEqual(Wire.packTagMap({ [first.id]: first.tag, [second.id]: second.tag }), packed);
    for (const value of [
        { bad: 'Valid' }, { [first.id]: '' }, { [first.id]: '123456789' },
        { [first.id]: '<img>' }, { [first.id]: 'a b' }, { [first.id]: '\u00e9' },
        { [first.id]: first.tag, [first.id.toUpperCase()]: 'Other' },
    ]) assert.throws(() => Wire.packTagMap(value));
    assert.throws(() => Wire.unpackTagMap(packed.subarray(0, packed.length - 1)));
    const doubled = new Uint8Array(packed.length * 2);
    doubled.set(packed); doubled.set(packed, packed.length);
    assert.throws(() => Wire.unpackTagMap(doubled));
});
