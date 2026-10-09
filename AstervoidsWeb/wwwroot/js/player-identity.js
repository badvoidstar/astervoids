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
    const REQUEST_TIMEOUT_MS = 15_000;
    const INITIAL_RESOLVE_POLICY = Object.freeze({
        maxAttempts: 10, budgetMs: 60_000, retryDelayMs: 1_000,
    });
    const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

    function getTagPattern() {
        const config = typeof AstervoidsConfig !== 'undefined'
            ? AstervoidsConfig : require('./game-config.js');
        return config.IDENTITY_TAG_PATTERN;
    }

    class IdentityError extends Error {
        constructor(code) { super(code); this.code = code; }
    }

    function failure(code, transient = false) {
        const error = new IdentityError(code);
        error.transient = transient;
        return error;
    }

    function captureInvite(location, history) {
        if (!location.hash.startsWith('#invite')) return null;
        const fields = new URLSearchParams(location.hash.slice(1));
        history.replaceState(null, '', location.pathname + location.search);
        const tokens = fields.getAll('invite');
        return tokens.length === 1 && [...fields.keys()].length === 1 && TOKEN_PATTERN.test(tokens[0])
            ? { token: tokens[0] } : { invalid: true };
    }

    function configuredOrigin(candidate) {
        let url;
        try { url = new URL(candidate); } catch { throw failure('identity_unavailable'); }
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
            || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            throw failure('identity_unavailable');
        }
        return url.origin;
    }

    function apiOrigin(location, manifest) {
        if (!manifest || !Array.isArray(manifest.regions)) throw failure('identity_unavailable');
        if (typeof manifest.regionId === 'string' && manifest.regionId) return location.origin;
        return configuredOrigin(manifest.regions[0]?.hostname);
    }

    function createClient(environment) {
        const { storage, locks, crypto, fetch, location } = environment;
        const schedule = environment.setTimeout ?? setTimeout;
        const unschedule = environment.clearTimeout ?? clearTimeout;
        const now = environment.now ?? (() => performance.now());
        let authority = null;
        let preparation = null;
        let preparationController = null;
        let initialResolution = null;
        let binding = null;
        let pending = null;
        const listeners = new Set();

        function checkAborted(signal) {
            if (signal?.aborted) throw failure('identity_cancelled');
        }

        async function abortable(action, signal) {
            checkAborted(signal);
            if (!signal) return action();
            let abort;
            const cancelled = new Promise((_, reject) => {
                abort = () => reject(failure('identity_cancelled'));
                signal.addEventListener('abort', abort, { once: true });
            });
            try { return await Promise.race([action(), cancelled]); }
            finally { signal.removeEventListener('abort', abort); }
        }

        async function exclusive(action, signal) {
            if (!locks?.request || !storage || !crypto?.getRandomValues) {
                throw failure('storage_unavailable');
            }
            return abortable(() => signal
                ? locks.request(LOCK_NAME, { signal }, () => {
                    checkAborted(signal);
                    return action();
                })
                : locks.request(LOCK_NAME, action), signal);
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

        async function json(url, options, unavailable = 'identity_unavailable', signal) {
            checkAborted(signal);
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            let timedOut = false;
            let transientTimeout = true;
            let retryAfter = 0;
            const timeout = schedule(() => {
                timedOut = true;
                controller.abort();
            }, REQUEST_TIMEOUT_MS);
            try {
                return await abortable(async () => {
                    const response = await fetch(url, {
                        ...options, signal: controller.signal, redirect: 'error',
                        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
                    });
                    transientTimeout = response.ok || TRANSIENT_HTTP_STATUSES.has(response.status);
                    retryAfter = Number(response.headers?.get('Retry-After'));
                    let data;
                    let invalidJson = false;
                    try { data = await response.json(); } catch { invalidJson = true; }
                    checkAborted(controller.signal);
                    if (!response.ok) {
                        const known = new Set([
                            'invalid_request', 'invalid_tag', 'invalid_browser_credential',
                            'invite_not_found', 'identity_required', 'binding_changed',
                            'invite_changed', 'request_reused', 'rate_limited', 'identity_unavailable',
                            'leaderboard_unavailable', 'leaderboard_ineligible',
                        ]);
                        const code = data?.error?.code;
                        // Gateway HTML/empty cold responses are transient; a malformed
                        // success or an unknown JSON protocol is not.
                        const transient = TRANSIENT_HTTP_STATUSES.has(response.status)
                            && (invalidJson || code === 'identity_unavailable' || code === 'rate_limited');
                        const error = failure(known.has(code) ? code : unavailable, transient);
                        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
                        throw error;
                    }
                    if (invalidJson) throw failure(unavailable);
                    return data;
                }, controller.signal);
            } catch (error) {
                checkAborted(signal);
                if (timedOut) {
                    const error = failure(unavailable, transientTimeout);
                    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
                    throw error;
                }
                if (error instanceof IdentityError) throw error;
                // Fetch exceptions may contain a private hostname. Do not propagate them.
                throw failure(unavailable, true);
            } finally {
                unschedule(timeout);
                signal?.removeEventListener('abort', abort);
            }
        }

        async function resolveAuthority(signal) {
            checkAborted(signal);
            if (!authority) {
                const bootstrap = environment.bootstrap;
                const manifest = bootstrap && Array.isArray(bootstrap.regions) && bootstrap.regions.length
                    ? bootstrap : await json(`${location.origin}/api/regions`, { method: 'GET' },
                        'identity_unavailable', signal);
                checkAborted(signal);
                authority = apiOrigin(location, manifest);
            }
            return authority;
        }

        async function request(route, body, signal, readCredential = credential) {
            await resolveAuthority(signal);
            checkAborted(signal);
            return json(`${authority}/api/identity${route}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Astervoids-Browser': readCredential(),
                },
                body: JSON.stringify(body),
            }, 'identity_unavailable', signal);
        }

        async function leaderboardRequest(route, body, token) {
            const origin = await resolveAuthority();
            return json(`${origin}/api/leaderboard${route}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'X-Astervoids-Browser': token } : {}),
                },
                body: JSON.stringify(body),
                ...(token ? { keepalive: true } : {}),
            }, 'leaderboard_unavailable');
        }

        async function prepareRegions() {
            const bootstrap = environment.bootstrap;
            if (environment.document?.hidden || !bootstrap
                || (typeof bootstrap.regionId === 'string' && bootstrap.regionId)
                || (Array.isArray(bootstrap.regions) && bootstrap.regions.length === 0)) {
                return false;
            }
            if (!preparation) {
                if (!Array.isArray(bootstrap.regions)) throw failure('identity_unavailable');
                const origins = [...new Set(bootstrap.regions.map(region => configuredOrigin(region?.hostname)))];
                const controller = preparationController = new AbortController();
                const stop = () => controller.abort();
                const hide = () => { if (environment.document?.hidden) stop(); };
                environment.document?.addEventListener('visibilitychange', hide);
                environment.lifecycle?.addEventListener('pagehide', stop);
                preparation = Promise.allSettled(origins.map(origin =>
                    json(`${origin}/api/ping`, { method: 'GET' }, 'identity_unavailable', controller.signal)))
                    .then(results => {
                        if (controller.signal.aborted) return false;
                        if (results.some(result => result.status === 'rejected')) throw failure('identity_unavailable');
                        return true;
                    }).finally(() => {
                        environment.document?.removeEventListener('visibilitychange', hide);
                        environment.lifecycle?.removeEventListener('pagehide', stop);
                        preparationController = null;
                    });
            }
            return preparation;
        }

        function cancelPreparation() {
            preparationController?.abort();
        }

        function adopt(next) {
            if (!next || typeof next.etag !== 'string' || !Number.isSafeInteger(next.revision)
                || next.revision < 0 || (next.identity !== null
                    && (!GUID_PATTERN.test(next.identity?.id) || !getTagPattern().test(next.identity?.tag)
                        || (next.identity.excludeFromLeaderboards !== undefined
                            && typeof next.identity.excludeFromLeaderboards !== 'boolean')))) {
                throw failure('identity_unavailable');
            }
            const previous = binding?.identity ?? null;
            binding = {
                etag: next.etag, revision: next.revision,
                identity: next.identity ? Object.freeze({
                    id: next.identity.id.toLowerCase(), tag: next.identity.tag,
                    ...(next.identity.excludeFromLeaderboards === true ? { excludeFromLeaderboards: true } : {}),
                }) : null,
            };
            if (previous?.id !== binding.identity?.id || previous?.tag !== binding.identity?.tag
                || previous?.excludeFromLeaderboards !== binding.identity?.excludeFromLeaderboards) {
                for (const listener of listeners) listener(binding.identity, previous);
            }
        }

        function expected() {
            if (!binding) throw failure('identity_unavailable');
            return { identityId: binding.identity?.id ?? null, etag: binding.etag };
        }

        async function resolveOnce(inviteToken, signal,
            checkCurrent = () => checkAborted(signal), readCredential = credential) {
            return exclusive(async () => {
                checkCurrent();
                const result = await request('/resolve', inviteToken ? { inviteToken } : {}, signal, readCredential);
                checkCurrent();
                if (!result || typeof result.promptOnRoot !== 'boolean'
                    || (inviteToken && (!GUID_PATTERN.test(result.invite?.identityId)
                        || !['pending', 'active'].includes(result.invite?.state)
                        || typeof result.invite?.etag !== 'string'
                        || (result.invite.state === 'active' && !getTagPattern().test(result.invite.tag))))) {
                    throw failure('identity_unavailable');
                }
                adopt(result.binding);
                return result;
            }, signal);
        }

        function cancelInitialResolution() {
            initialResolution?.abort();
            initialResolution = null;
        }

        function resolve(inviteToken, { signal } = {}) {
            cancelInitialResolution();
            return resolveOnce(inviteToken, signal);
        }

        async function resolveInitial(inviteToken, { signal } = {}) {
            cancelInitialResolution();
            checkAborted(signal);
            const controller = initialResolution = new AbortController();
            const abort = () => controller.abort();
            const hide = () => { if (environment.document?.hidden) abort(); };
            signal?.addEventListener('abort', abort, { once: true });
            environment.document?.addEventListener('visibilitychange', hide);
            const deadline = now() + INITIAL_RESOLVE_POLICY.budgetMs;
            let expired = false;
            const expire = () => { expired = true; controller.abort(); };
            const budget = schedule(expire, INITIAL_RESOLVE_POLICY.budgetMs);
            let browserCredential = null;
            const stableCredential = () => {
                const token = credential();
                if (browserCredential && token !== browserCredential) throw failure('binding_changed');
                return browserCredential = token;
            };
            const checkCurrent = () => {
                hide();
                if (now() >= deadline) expire();
                checkAborted(controller.signal);
            };
            try {
                for (let attempt = 1; attempt <= INITIAL_RESOLVE_POLICY.maxAttempts; attempt++) {
                    checkCurrent();
                    try {
                        return await resolveOnce(inviteToken, controller.signal, checkCurrent, stableCredential);
                    } catch (error) {
                        checkCurrent();
                        if (!error.transient || attempt === INITIAL_RESOLVE_POLICY.maxAttempts) throw error;
                        const delay = Math.max(INITIAL_RESOLVE_POLICY.retryDelayMs * attempt,
                            (error.retryAfter ?? 0) * 1000);
                        let timer;
                        try {
                            // No Web Lock is held during backoff or another tab's work.
                            await abortable(() => new Promise(done => {
                                timer = schedule(done, Math.min(delay, Math.max(0, deadline - now())));
                            }), controller.signal);
                        } finally { unschedule(timer); }
                    }
                }
            } catch (error) {
                if (expired) throw failure('identity_unavailable');
                checkAborted(controller.signal);
                throw error;
            } finally {
                unschedule(budget);
                signal?.removeEventListener('abort', abort);
                environment.document?.removeEventListener('visibilitychange', hide);
                if (initialResolution === controller) initialResolution = null;
            }
        }

        async function mutation(route, body) {
            cancelInitialResolution();
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
            prepareRegions, cancelPreparation,
            resolve, resolveInitial,
            current: () => binding?.identity ?? null,
            queryLeaderboard: (filters = {}) => leaderboardRequest('/query', filters),
            async saveLeaderboardScore(snapshot) {
                // Only credential lookup holds the identity lock. An unavailable
                // score service must not stall onboarding or binding changes.
                const token = await exclusive(() => {
                    if (!binding?.identity) throw failure('identity_required');
                    if (binding.identity.id !== snapshot.playerId?.toLowerCase()) {
                        throw failure('binding_changed');
                    }
                    if (binding.identity.excludeFromLeaderboards) throw failure('leaderboard_ineligible');
                    return credential();
                });
                const result = await leaderboardRequest('/scores', snapshot, token);
                if (result?.recorded !== true) throw failure('leaderboard_unavailable');
                return result;
            },
            deactivate() {
                cancelInitialResolution();
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
                cancelInitialResolution();
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
            REQUEST_TIMEOUT_MS, INITIAL_RESOLVE_POLICY,
            get TAG_PATTERN() { return getTagPattern(); },
        };
    }
    let storage = null;
    try { storage = window.localStorage; } catch { /* Reported when activation is attempted. */ }
    let incomingInvite = captureInvite(window.location, window.history);
    const client = createClient({
        storage, locks: navigator.locks, crypto: window.crypto,
        fetch: window.fetch.bind(window), location: window.location,
        document: window.document, lifecycle: window,
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
