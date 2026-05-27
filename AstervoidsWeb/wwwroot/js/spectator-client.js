/**
 * Spectator Client Module
 *
 * Multi-region session-list freshness mechanism. While the user is on the
 * start screen / session picker, this module holds one read-only SignalR
 * connection per peer region. Each connection joins the hub's
 * `AllClientsGroup` automatically (server side) and receives
 * `OnSessionsChanged` push events for that region's session list — without
 * ever invoking `CreateSession` or `JoinSession`.
 *
 * The picker uses these push events to drive region-scoped REST refetches
 * (`GET <region>/api/sessions`) so cross-region changes surface within ~1
 * inter-region RTT, matching the freshness budget targeted in
 * plan.md → "Picker freshness — latency budget".
 *
 * ## Lifecycle
 *
 * Spectator connections must NOT outlive the picker. As soon as the user:
 *   - clicks Join, Create, Start, or Solo, OR
 *   - the tab is hidden (`document.hidden === true`)
 * every spectator connection is closed. This is critical for scale-to-zero:
 * an always-on spectator connection per visitor would defeat the
 * `cooldownPeriod: 60s` on every Container App.
 *
 * On `visibilitychange`-back, spectator connections re-open. On Leave (back
 * to picker), they re-open.
 *
 * ## Why a separate module
 *
 * `SessionClient` is a singleton with state for the joined session
 * (currentSession, currentMember, auto-rejoin logic). Trying to graft N
 * additional connections onto that singleton would tangle two concerns.
 * SpectatorClient is intentionally simple: open, receive, close.
 */

const SpectatorClient = (function () {
    const _log = (...a) => window.ASTERVOIDS_DEBUG && console.log(...a);
    const _warn = (...a) => window.ASTERVOIDS_DEBUG && console.warn(...a);

    // Per-region connection state. Keyed by regionId.
    //   { connection, hostname, state: 'connecting'|'open'|'reconnecting'|'closed' }
    const connections = new Map();

    // Event bus
    const listeners = {
        // (regionId) — fires every time the region's hub broadcasts OnSessionsChanged.
        // Listeners should refetch GET <region>/api/sessions and merge.
        sessionsChanged: new Set(),
        // (regionId, state) — connection state transitions for stale-region detection.
        connectionStateChanged: new Set(),
    };

    function emit(event, ...args) {
        const set = listeners[event];
        if (!set) return;
        for (const fn of set) {
            try { fn(...args); } catch (e) { console.error('[SpectatorClient]', event, e); }
        }
    }

    function on(event, fn) {
        if (!listeners[event]) throw new Error(`Unknown SpectatorClient event: ${event}`);
        listeners[event].add(fn);
        return () => listeners[event].delete(fn);
    }

    function setRegionState(regionId, nextState) {
        const entry = connections.get(regionId);
        if (!entry || entry.state === nextState) return;
        entry.state = nextState;
        emit('connectionStateChanged', regionId, nextState);
    }

    /**
     * Open a spectator connection to a single region. Internal — `openAll`
     * is the public entry point. Returns the connection promise so callers
     * can await first-connect completion (used by `openAll`).
     */
    async function openOne(regionId, hostname) {
        const existing = connections.get(regionId);
        if (existing
            && existing.connection
            && existing.connection.state === signalR.HubConnectionState.Connected) {
            return existing.connection;
        }

        // Close any prior connection state for this region before reopening
        // (e.g. visibility cycle dropped us into a reconnecting state).
        await closeOne(regionId);

        const hubUrl = `${hostname.replace(/\/$/, '')}/sessionHub`;
        const connection = new signalR.HubConnectionBuilder()
            .withUrl(hubUrl)
            .withHubProtocol(new signalR.protocols.msgpack.MessagePackHubProtocol())
            .withAutomaticReconnect({
                // Same backoff philosophy as SessionClient — match the server's
                // ClientTimeoutInterval (20s) by giving up after ~10 attempts of
                // 1s each. Picker hygiene will surface a ↻ badge after 10s of
                // reconnecting and rely on the REST 30s repoll until recovery.
                nextRetryDelayInMilliseconds: ctx => ctx.previousRetryCount >= 10 ? null : 1000,
            })
            .configureLogging(signalR.LogLevel.Warning)
            .build();

        // ── Push handler ──────────────────────────────────────────────
        // Server pushes OnSessionsChanged on every Create/Join/Leave/Destroy
        // in the region. We don't read the message body (it's a hint, not a
        // payload — same semantic as today's same-origin push). Listeners do
        // the actual refetch.
        connection.on('OnSessionsChanged', () => emit('sessionsChanged', regionId));

        connection.onreconnecting(() => setRegionState(regionId, 'reconnecting'));
        connection.onreconnected(() => setRegionState(regionId, 'open'));
        connection.onclose(() => setRegionState(regionId, 'closed'));

        const entry = { connection, hostname, state: 'connecting' };
        connections.set(regionId, entry);

        try {
            await connection.start();
            setRegionState(regionId, 'open');
            _log('[SpectatorClient] connected', regionId, hostname);
            return connection;
        } catch (err) {
            _warn('[SpectatorClient] connect failed for', regionId, err && err.message);
            setRegionState(regionId, 'closed');
            // Leave the entry in place with a 'closed' state — picker can show
            // a ⚠ badge for unreachable regions and the REST 30s repoll covers
            // any sessions that exist there.
            return null;
        }
    }

    async function closeOne(regionId) {
        const entry = connections.get(regionId);
        if (!entry) return;
        const c = entry.connection;
        connections.delete(regionId);
        if (c) {
            try {
                await Promise.race([
                    c.stop(),
                    new Promise(r => setTimeout(r, 3000)),
                ]);
            } catch (_) { /* ignore */ }
        }
    }

    /**
     * Open spectator connections to every region in the provided manifest.
     * Skips a region whose `hostname` exactly equals `excludeHostname` —
     * caller passes the active SessionClient's current hub hostname so we
     * don't open a duplicate connection to the region the user is joined to.
     *
     * Returns the array of (possibly-null) connection objects in manifest
     * order so the caller can verify which regions connected.
     */
    async function openAll(regions, excludeHostname = '') {
        const exclude = (excludeHostname || '').replace(/\/$/, '');
        const tasks = regions.map(r => {
            if (r.hostname.replace(/\/$/, '') === exclude) {
                return Promise.resolve(null);
            }
            return openOne(r.id, r.hostname);
        });
        return Promise.all(tasks);
    }

    /** Close every spectator connection. */
    async function closeAll() {
        const ids = Array.from(connections.keys());
        await Promise.all(ids.map(closeOne));
    }

    /**
     * Close every connection EXCEPT the region the caller wants to keep.
     * Used on Join/Create handoff: the picker has been showing all regions,
     * now the user wants one specific region for the joined-session
     * SignalR connection; close the rest to honor scale-to-zero.
     */
    async function closeAllExcept(keepRegionId) {
        const ids = Array.from(connections.keys()).filter(id => id !== keepRegionId);
        await Promise.all(ids.map(closeOne));
    }

    /** Return the per-region connection state, or 'closed' if not tracked. */
    function getState(regionId) {
        const entry = connections.get(regionId);
        return entry ? entry.state : 'closed';
    }

    /** Return the set of regionIds currently tracked (any state). */
    function getOpenRegionIds() {
        return Array.from(connections.keys());
    }

    return {
        openAll,
        closeAll,
        closeAllExcept,
        openOne,
        closeOne,
        on,
        getState,
        getOpenRegionIds,
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpectatorClient;
}
