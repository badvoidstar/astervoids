/**
 * Origin-local browser bindings to backend-persisted player identities.
 * Credentials and invitation capabilities never enter game/SignalR payloads.
 */
const PlayerIdentity = (function () {
    const STORAGE_KEY = 'astervoids.browser-binding';
    const CHANGE_KEY = 'astervoids.identity-change';
    const LOCK_NAME = 'astervoids.identity';
    const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
    const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function getTagPattern() {
        const config = typeof AstervoidsConfig !== 'undefined'
            ? AstervoidsConfig : require('./game-config.js');
        return config.IDENTITY_TAG_PATTERN;
    }

    class IdentityError extends Error {
        constructor(code) { super(code); this.code = code; }
    }

    function failure(code) { return new IdentityError(code); }

    function captureInvite(location, history) {
        if (!location.hash.startsWith('#invite')) return null;
        const fields = new URLSearchParams(location.hash.slice(1));
        history.replaceState(null, '', location.pathname + location.search);
        const tokens = fields.getAll('invite');
        return tokens.length === 1 && [...fields.keys()].length === 1 && TOKEN_PATTERN.test(tokens[0])
            ? { token: tokens[0] } : { invalid: true };
    }

    function apiOrigin(location, manifest) {
        if (!manifest || !Array.isArray(manifest.regions)) throw failure('identity_unavailable');
        if (typeof manifest.regionId === 'string' && manifest.regionId) return location.origin;
        const candidate = manifest.regions[0]?.hostname;
        let url;
        try { url = new URL(candidate); } catch { throw failure('identity_unavailable'); }
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
            || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            throw failure('identity_unavailable');
        }
        return url.origin;
    }

    function createClient(environment) {
        const { storage, locks, crypto, fetch, location } = environment;
        let authority = null;
        let binding = null;
        let pending = null;
        const listeners = new Set();

        async function exclusive(action) {
            if (!locks?.request || !storage || !crypto?.getRandomValues) {
                throw failure('storage_unavailable');
            }
            return locks.request(LOCK_NAME, action);
        }

        function credential() {
            try {
                let token = storage.getItem(STORAGE_KEY);
                if (token === null) {
                    const bytes = crypto.getRandomValues(new Uint8Array(32));
                    token = btoa(String.fromCharCode(...bytes))
                        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
                    storage.setItem(STORAGE_KEY, token);
                    if (storage.getItem(STORAGE_KEY) !== token) throw failure('storage_unavailable');
                }
                if (!TOKEN_PATTERN.test(token)) throw failure('invalid_browser_credential');
                return token;
            } catch (error) {
                if (error instanceof IdentityError) throw error;
                throw failure('storage_unavailable');
            }
        }

        async function json(url, options) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15_000);
            try {
                const response = await fetch(url, {
                    ...options, signal: controller.signal, redirect: 'error',
                    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
                });
                let data;
                try { data = await response.json(); } catch { throw failure('identity_unavailable'); }
                if (!response.ok) {
                    const known = new Set([
                        'invalid_request', 'invalid_tag', 'invalid_browser_credential',
                        'invite_not_found', 'identity_required', 'binding_changed',
                        'invite_changed', 'request_reused', 'rate_limited', 'identity_unavailable',
                    ]);
                    const error = failure(known.has(data?.error?.code) ? data.error.code : 'identity_unavailable');
                    const retryAfter = Number(response.headers?.get('Retry-After'));
                    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
                    throw error;
                }
                return data;
            } catch (error) {
                if (error instanceof IdentityError) throw error;
                // Fetch exceptions may contain a private hostname. Do not propagate them.
                throw failure('identity_unavailable');
            } finally {
                clearTimeout(timeout);
            }
        }

        async function request(route, body) {
            if (!authority) {
                const bootstrap = environment.bootstrap;
                const manifest = bootstrap && Array.isArray(bootstrap.regions) && bootstrap.regions.length
                    ? bootstrap : await json(`${location.origin}/api/regions`, { method: 'GET' });
                authority = apiOrigin(location, manifest);
            }
            return json(`${authority}/api/identity${route}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Astervoids-Browser': credential(),
                },
                body: JSON.stringify(body),
            });
        }

        function adopt(next) {
            if (!next || typeof next.etag !== 'string' || !Number.isSafeInteger(next.revision)
                || next.revision < 0 || (next.identity !== null
                    && (!GUID_PATTERN.test(next.identity?.id) || !getTagPattern().test(next.identity?.tag)))) {
                throw failure('identity_unavailable');
            }
            const previous = binding?.identity ?? null;
            binding = {
                etag: next.etag, revision: next.revision,
                identity: next.identity ? Object.freeze({
                    id: next.identity.id.toLowerCase(), tag: next.identity.tag,
                }) : null,
            };
            if (previous?.id !== binding.identity?.id || previous?.tag !== binding.identity?.tag) {
                for (const listener of listeners) listener(binding.identity, previous);
            }
        }

        function expected() {
            if (!binding) throw failure('identity_unavailable');
            return { identityId: binding.identity?.id ?? null, etag: binding.etag };
        }

        async function resolve(inviteToken) {
            return exclusive(async () => {
                const result = await request('/resolve', inviteToken ? { inviteToken } : {});
                if (typeof result.promptOnRoot !== 'boolean'
                    || (inviteToken && (!GUID_PATTERN.test(result.invite?.identityId)
                        || !['pending', 'active'].includes(result.invite?.state)
                        || typeof result.invite?.etag !== 'string'
                        || (result.invite.state === 'active' && !getTagPattern().test(result.invite.tag))))) {
                    throw failure('identity_unavailable');
                }
                adopt(result.binding);
                return result;
            });
        }

        async function mutation(route, body) {
            return exclusive(async () => {
                const serialized = JSON.stringify(body);
                if (pending && (pending.route !== route || pending.serialized !== serialized)) {
                    throw failure('operation_pending');
                }
                pending ??= { route, serialized, body: { ...body, requestId: crypto.randomUUID() } };
                let result;
                try {
                    result = await request(route, pending.body);
                } catch (error) {
                    if (error.code !== 'identity_unavailable') pending = null;
                    throw error;
                }
                if (route === '/invites') {
                    if (!TOKEN_PATTERN.test(result.inviteToken)) throw failure('identity_unavailable');
                } else {
                    adopt(result.binding);
                }
                pending = null;
                if (result.binding) {
                    try { storage.setItem(CHANGE_KEY, crypto.randomUUID()); }
                    catch { throw failure('storage_unavailable'); }
                }
                return result;
            });
        }

        return Object.freeze({
            resolve,
            current: () => binding?.identity ?? null,
            deactivate() {
                const previous = binding?.identity ?? null;
                binding = null;
                if (previous) for (const listener of listeners) listener(null, previous);
            },
            hasPendingOperation: () => pending !== null,
            create: (tag, expectedBinding = expected()) => mutation('/root', { expectedBinding, tag }),
            accept: (inviteToken, invite, tag, expectedBinding = expected()) => mutation('/invites/accept', {
                inviteToken, expectedInviteEtag: invite.etag,
                expectedBinding, ...(invite.state === 'pending' ? { tag } : {}),
            }),
            inviteFriend: () => mutation('/invites', {}),
            async inviteSelf() {
                return exclusive(async () => {
                    const result = await request('/invites/self', { expectedBinding: expected() });
                    if (!TOKEN_PATTERN.test(result.inviteToken)) throw failure('identity_unavailable');
                    return result;
                });
            },
            async retry() {
                if (!pending) throw failure('invalid_request');
                return mutation(pending.route, JSON.parse(pending.serialized));
            },
            link: token => {
                if (!TOKEN_PATTERN.test(token)) throw failure('invite_not_found');
                const url = new URL('/', location.origin);
                url.hash = `invite=${token}`;
                return url.href;
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        });
    }

    if (typeof window === 'undefined') {
        return {
            createClient, captureInvite, apiOrigin, STORAGE_KEY, CHANGE_KEY,
            get TAG_PATTERN() { return getTagPattern(); },
        };
    }
    let storage = null;
    try { storage = window.localStorage; } catch { /* Reported when activation is attempted. */ }
    let incomingInvite = captureInvite(window.location, window.history);
    const client = createClient({
        storage, locks: navigator.locks, crypto: window.crypto,
        fetch: window.fetch.bind(window), location: window.location,
        // Bootstrap loads later; the accessor is resolved at the first request.
        get bootstrap() { return window.ASTERVOIDS_REGION_BOOTSTRAP; },
    });
    return Object.freeze({
        ...client, STORAGE_KEY, CHANGE_KEY,
        get TAG_PATTERN() { return getTagPattern(); },
        takeInvite() {
            const invite = incomingInvite ?? captureInvite(window.location, window.history);
            incomingInvite = null;
            return invite;
        },
    });
})();

if (typeof window !== 'undefined') window.PlayerIdentity = PlayerIdentity;
if (typeof module !== 'undefined' && module.exports) module.exports = PlayerIdentity;
