/**
 * Session Client Module
 * Handles SignalR connection and session management communication.
 */

const SessionClient = (function() {
    // Shared debug helpers — see js/debug-log.js (must load first).
    const { log: _log, warn: _warn, error: _error } = typeof AstervoidsDebugLog !== 'undefined'
        ? AstervoidsDebugLog
        : require('./debug-log.js');

    let connection = null;
    let currentSession = null;
    let currentMember = null;
    let lastSessionId = null; // Track for auto-rejoin after unexpected disconnect
    let reconnectIdentity = null; // { sessionId, memberId, token }, never broadcast
    // sessionId -> participantId. A rejoin, and a plain re-join of the same
    // session, mint a brand new member id server-side, so a member id cannot
    // identify "the same human" across a reconnect. This keeps the id this
    // client first entered each session with, which is what game state uses to
    // count a participant exactly once. Keyed per session so that visiting
    // another session and coming back is still the original participant, and
    // bounded because it is only a cache: a missed entry costs an identity, not
    // correctness of anything already recorded.
    const participantIdentities = new Map();
    const maxParticipantIdentities = 8;
    const maxReconnectAttempts = 10;
    const reconnectDelay = 1000;
    let connectionEpoch = 0;
    let sessionEpoch = 0;
    let pendingSessionTransition = null;
    let sessionTransitionTail = Promise.resolve();
    // Hostname currently bound to `connection` (e.g. https://astervoids-westus2.example.com).
    // Empty string = same-origin single-region behavior. Tracked so reconnect logic
    // can rebuild the connection against the correct region after a transient drop.
    let currentHubHostname = '';

    // Per-tab storage key, so a page reload rejoins as the same participant.
    const participantStorageKey = 'astervoids.participants';

    // Storage is attacker-writable in the sense that anything already running in
    // the page can poison it, and a participant id is published verbatim as a
    // `guid` wire field. Anything that is not a real GUID is dropped here rather
    // than allowed to reach the encoder.
    function loadStoredParticipantIdentities() {
        try {
            const stored = JSON.parse(
                globalThis.sessionStorage?.getItem(participantStorageKey) ?? 'null');
            if (!Array.isArray(stored)) return;
            for (const entry of stored.slice(-maxParticipantIdentities)) {
                if (GuidUtils.isGuid(entry?.sessionId)
                    && GuidUtils.isGuid(entry?.participantId)) {
                    participantIdentities.set(entry.sessionId, entry.participantId);
                }
            }
        } catch {
            // Storage can be unavailable (private mode, disabled cookies) or hold
            // unparsable data. A fresh identity is correct, just less sticky.
        }
    }

    function rememberParticipantIdentity(sessionId, participantId) {
        participantIdentities.delete(sessionId);
        participantIdentities.set(sessionId, participantId);
        while (participantIdentities.size > maxParticipantIdentities) {
            participantIdentities.delete(participantIdentities.keys().next().value);
        }
        try {
            globalThis.sessionStorage?.setItem(participantStorageKey, JSON.stringify(
                [...participantIdentities].map(([id, participant]) =>
                    ({ sessionId: id, participantId: participant }))));
        } catch {
            // Quota or a blocked store only costs reload stickiness.
        }
    }

    loadStoredParticipantIdentities();

    // Event callbacks
    const callbacks = {
        onConnected: null,
        onReconnecting: null,
        onDisconnected: null,
        onSessionCreated: null,
        onSessionJoined: null,
        onSessionLeft: null,
        onSessionTransition: null,
        onMemberJoined: null,
        onMemberLeft: null,
        onRoleChanged: null,
        onObjectCreated: null,
        onObjectsUpdated: null,
        onObjectDeleted: null,
        onObjectReplaced: null,
        onObjectEvent: null,
        onSessionsChanged: null,
        onSessionExpired: null,
        onError: null
    };

    function notifySessionTransition(kind, epoch) {
        if (callbacks.onSessionTransition) {
            callbacks.onSessionTransition(kind, epoch);
        }
    }

    function serializeSessionTransition(operation) {
        const current = sessionTransitionTail
            .catch(() => {})
            .then(operation);
        sessionTransitionTail = current.catch(() => {});
        return current;
    }

    function beginSessionTransition(kind, clearLastSession = false, targetSessionId = null) {
        const epoch = ++sessionEpoch;
        pendingSessionTransition = { kind, epoch, targetSessionId, memberEvents: [] };
        currentSession = null;
        currentMember = null;
        clearObjectHandles();
        if (clearLastSession) {
            lastSessionId = null;
            reconnectIdentity = null;
        }
        notifySessionTransition(kind, epoch);
        return epoch;
    }

    function finishSessionTransition(epoch) {
        if (pendingSessionTransition?.epoch === epoch) {
            pendingSessionTransition = null;
        }
    }

    function invalidateSession(kind, clearLastSession = false) {
        const epoch = ++sessionEpoch;
        pendingSessionTransition = null;
        currentSession = null;
        currentMember = null;
        clearObjectHandles();
        if (clearLastSession) {
            lastSessionId = null;
            reconnectIdentity = null;
        }
        notifySessionTransition(kind, epoch);
        return epoch;
    }

    function captureConnectionContext() {
        return { connection, connectionEpoch };
    }

    function isConnectionContextCurrent(context) {
        return connection === context.connection
            && connectionEpoch === context.connectionEpoch;
    }

    function captureSessionContext() {
        return { connection, connectionEpoch, sessionEpoch };
    }

    function isSessionContextCurrent(context) {
        return isConnectionContextCurrent(context)
            && sessionEpoch === context.sessionEpoch;
    }

    function staleOperationError() {
        const error = new Error('Operation superseded by a newer connection or session transition');
        error.name = 'StaleOperationError';
        return error;
    }

    function acceptsSessionEvents() {
        if (pendingSessionTransition) {
            return pendingSessionTransition.kind === 'create'
                || pendingSessionTransition.kind === 'join';
        }
        return currentSession !== null;
    }

    function applyMemberEvent(event) {
        if (!currentSession || !event) return;

        if (event.kind === 'joined') {
            if (!Array.isArray(currentSession.members)) {
                currentSession.members = [];
            }
            const existing = currentSession.members.find(
                member => member.id === event.memberInfo.id);
            if (existing) {
                Object.assign(existing, event.memberInfo);
            } else {
                currentSession.members.push(event.memberInfo);
            }
            return;
        }

        const info = event.info;
        if (!info) return;
        if (Array.isArray(currentSession.members)) {
            currentSession.members = currentSession.members.filter(
                member => member.id !== info.memberId);
        }
        if (info.promotedMemberId && currentMember
            && info.promotedMemberId === currentMember.id) {
            event.roleChanged = true;
        }
    }

    function dispatchMemberEvent(event) {
        if (event.kind === 'joined') {
            if (callbacks.onMemberJoined) {
                callbacks.onMemberJoined(
                    event.memberInfo, event.senderMemberId, event.memberSequence);
            }
            return;
        }

        if (callbacks.onMemberLeft) {
            callbacks.onMemberLeft(
                event.info, event.senderMemberId, event.memberSequence);
        }
        if (event.roleChanged && currentMember) {
            currentMember.role = event.info.promotedRole;
            const self = currentSession?.members?.find(
                member => member.id === currentMember.id);
            if (self) self.role = event.info.promotedRole;
            if (callbacks.onRoleChanged) {
                callbacks.onRoleChanged(event.info.promotedRole);
            }
        }
    }

    function handleMemberEvent(event) {
        if (!currentSession && pendingSessionTransition?.memberEvents) {
            pendingSessionTransition.memberEvents.push(event);
            return;
        }
        applyMemberEvent(event);
        dispatchMemberEvent(event);
    }

    function applyPendingMemberEvents(epoch) {
        if (pendingSessionTransition?.epoch !== epoch) return [];
        const events = pendingSessionTransition.memberEvents.splice(0);
        for (const event of events) applyMemberEvent(event);
        return events;
    }

    function acceptsExpirationForSession(expiredSessionId) {
        if (currentSession?.id === expiredSessionId) return true;
        return pendingSessionTransition?.kind === 'join'
            && pendingSessionTransition.targetSessionId === expiredSessionId;
    }

    // ── Session-scoped object handles ───────────────────────────────────────
    //
    // Hot-path wire entries (UpdateObjects requests, OnObjectsUpdated broadcasts)
    // address objects by the server-allocated session-scoped integer handle
    // instead of the 18-byte binary GUID. Every ObjectInfo the server sends
    // carries both identities, so the map below is learned from ordinary traffic
    // — create responses, OnObjectCreated, replacement children, and the join /
    // reconciliation snapshots that follow a reconnect.
    //
    // The map is transport state: game code and ObjectSync keep speaking GUIDs.
    // Handles are only meaningful within one session, so a session transition
    // clears them.
    const handlesByObjectId = new Map();
    const objectIdsByHandle = new Map();

    // Batches whose entries address a handle we have not learned yet. This is the
    // create/update reordering window: the server applies an update only to an
    // object that already exists, but the create broadcast and the update
    // broadcast are enqueued by different hub invocations, so a receiver can
    // observe them out of order.
    //
    // Parking is all-or-nothing per batch, and that is load-bearing rather than
    // merely simpler. ObjectSync derives its lost-event detection from the
    // per-member sequence carried by each dispatched batch. Dispatching the
    // resolvable half of a batch would advance that sequence and hide the fact
    // that the rest of the batch never arrived — so a parked batch is never
    // partially delivered, and an un-delivered batch always leaves a sequence
    // gap that forces reconciliation. Every path that discards a parked batch is
    // safe for exactly that reason.
    const parkedBatches = [];
    // Parked batches whose handles are now all known, in arrival order.
    let parkedBatchesReady = [];
    // Bound on parked batches. The window this covers is a single broadcast, so
    // in practice at most one batch is ever parked; the cap exists so a peer that
    // keeps sending handles we never learn cannot grow this without limit.
    const MAX_PARKED_BATCHES = 8;

    function rememberObjectHandle(objectInfo, fromSnapshot = false) {
        const handle = objectInfo?.handle;
        if (!(handle > 0) || typeof objectInfo.id !== 'string') return;
        handlesByObjectId.set(objectInfo.id, handle);
        objectIdsByHandle.set(handle, objectInfo.id);
        resolveParkedBatches(handle, fromSnapshot);
    }

    function forgetObjectHandle(objectId) {
        const handle = handlesByObjectId.get(objectId);
        if (handle === undefined) return;
        handlesByObjectId.delete(objectId);
        objectIdsByHandle.delete(handle);
        // A batch addressing a handle that no longer resolves can never become
        // deliverable, so drop it rather than let it occupy the cap.
        dropParkedBatches(handle);
    }

    function clearObjectHandles() {
        handlesByObjectId.clear();
        objectIdsByHandle.clear();
        parkedBatches.length = 0;
        parkedBatchesReady = [];
    }

    function parkObjectBatch(updates, dispatch) {
        if (parkedBatches.length >= MAX_PARKED_BATCHES) {
            // Drop the oldest: the recent batches are the ones still likely to
            // be resolved by an in-flight create.
            parkedBatches.shift();
        }
        const handles = new Set();
        for (const update of updates) handles.add(update.handle);
        parkedBatches.push({ updates, handles, dispatch });
    }

    /**
     * Re-partitions parked batches after `handle` became known.
     *
     * A batch moves to the ready queue once every handle it addresses resolves.
     * When the handle was taught by a snapshot the batch is discarded instead:
     * the snapshot is authoritative as of its capture point, and its objects are
     * applied by the caller after this returns, so replaying a delta over it here
     * would race that application. Anything the snapshot predates is recovered by
     * the sequence gap the un-delivered batch leaves behind.
     */
    function resolveParkedBatches(handle, fromSnapshot) {
        if (parkedBatches.length === 0) return;
        const remaining = [];
        for (const batch of parkedBatches) {
            if (!batch.handles.has(handle)) {
                remaining.push(batch);
                continue;
            }
            if (fromSnapshot) continue;
            let ready = true;
            for (const parkedHandle of batch.handles) {
                if (!objectIdsByHandle.has(parkedHandle)) {
                    ready = false;
                    break;
                }
            }
            if (ready) parkedBatchesReady.push(batch);
            else remaining.push(batch);
        }
        replaceParkedBatches(remaining);
    }

    function dropParkedBatches(handle) {
        if (parkedBatches.length === 0) return;
        replaceParkedBatches(parkedBatches.filter(batch => !batch.handles.has(handle)));
    }

    function replaceParkedBatches(batches) {
        if (batches.length === parkedBatches.length) return;
        parkedBatches.length = 0;
        for (const batch of batches) parkedBatches.push(batch);
    }

    /**
     * Replays batches parked for handles since learned from a live create. Called
     * after the create itself has been dispatched so every object exists before
     * its delta arrives. A replayed batch keeps the metadata it arrived with
     * (sequences, validAt); it is one broadcast late, which is the same window
     * the reordering opened.
     */
    function deliverParkedUpdates() {
        if (parkedBatchesReady.length === 0) return;
        const ready = parkedBatchesReady;
        parkedBatchesReady = [];
        for (const batch of ready) {
            const resolved = [];
            for (const update of batch.updates) {
                const objectId = objectIdsByHandle.get(update.handle);
                if (objectId === undefined) continue;
                resolved.push(toObjectUpdate(update, objectId));
            }
            if (resolved.length > 0) batch.dispatch(resolved);
        }
    }

    function toObjectUpdate(update, objectId) {
        return { id: objectId, data: update.data, version: update.version };
    }

    function normalizeObjectInfo(value) {
        if (!Array.isArray(value)) return value;
        return {
            id: value[0],
            creatorMemberId: value[1],
            ownerMemberId: value[2],
            scope: value[3],
            data: value[4],
            version: value[5],
            handle: value[6]
        };
    }

    function decodeObjectInfo(value, fromSnapshot = false) {
        const objectInfo = normalizeObjectInfo(value);
        WireEnum.translateObject(objectInfo);
        SyncPayload.unwrapObjectData(objectInfo);
        rememberObjectHandle(objectInfo, fromSnapshot);
        return objectInfo;
    }

    function decodeObjectInfos(objects, fromSnapshot = false) {
        if (!Array.isArray(objects)) return;
        for (let i = 0; i < objects.length; i++) {
            objects[i] = decodeObjectInfo(objects[i], fromSnapshot);
        }
    }

    function normalizeObjectUpdateInfo(value) {
        if (!Array.isArray(value)) return value;
        return {
            handle: value[0],
            data: value[1],
            version: value[2]
        };
    }

    function normalizeObjectReplacedEvent(value) {
        if (!Array.isArray(value)) return value;
        return {
            deletedObjectId: value[0],
            createdObjects: value[1]
        };
    }

    function normalizeObjectEventInfo(value) {
        if (!Array.isArray(value)) return value;
        return {
            objectId: value[0],
            eventKind: value[1],
            payload: value[2]
        };
    }

    function normalizeCreateObjectResponse(value) {
        if (!Array.isArray(value)) return value;
        return {
            objectInfo: value[0],
            memberSequence: value[1],
            validAt: value[2]
        };
    }

    function dispatchObjectReplacement(event, senderMemberId, memberSequence, validAt,
        handler = callbacks.onObjectReplaced) {
        event = normalizeObjectReplacedEvent(event);
        if (event) {
            forgetObjectHandle(event.deletedObjectId);
            decodeObjectInfos(event.createdObjects);
        }
        if (handler) handler(event, senderMemberId, memberSequence, validAt);
        deliverParkedUpdates();
        return event.createdObjects;
    }

    function normalizeUpdateObjectsResponse(value) {
        if (!Array.isArray(value)) return value;
        return {
            versions: value[0],
            memberSequence: value[1],
            serverTimestamp: value[2]
        };
    }

    function normalizeDeleteObjectResponse(value) {
        if (!Array.isArray(value)) return value;
        return {
            success: value[0],
            memberSequence: value[1]
        };
    }

    function replaceSessionSchemas(metadata) {
        if (typeof SyncPayload === 'undefined'
            || typeof SyncPayload.replaceSchemas !== 'function') return;
        const schemas = metadata?.schemas;
        SyncPayload.replaceSchemas(Array.isArray(schemas) ? schemas : []);
    }

    function reconnectIdentityFromResponse(response, sessionId, memberId) {
        if (typeof response?.reconnectToken !== 'string'
            || response.reconnectToken.length === 0) {
            throw new Error('Server response is missing reconnectToken');
        }
        return {
            sessionId,
            memberId,
            token: response.reconnectToken,
            hubHostname: currentHubHostname
        };
    }

    function completeSessionEntry(context, session, member, identity, eventName) {
        currentSession = session;
        currentMember = member;
        reconnectIdentity = identity;
        // Re-entering a session (auto-rejoin after a drop, Leave then Join again,
        // a page reload, or a visit to another session and back) keeps the id this
        // client first entered *that* session with; a session never seen before
        // adopts this member id as its participant id.
        if (!participantIdentities.has(session.id)) {
            rememberParticipantIdentity(session.id, member.id);
        }
        const pendingMemberEvents = applyPendingMemberEvents(context.sessionEpoch);
        lastSessionId = session.id;
        finishSessionTransition(context.sessionEpoch);

        if (callbacks[eventName]) {
            callbacks[eventName](session, member);
        }
        for (const event of pendingMemberEvents) {
            if (!isSessionContextCurrent(context)) break;
            dispatchMemberEvent(event);
        }

        return isSessionContextCurrent(context) ? { session, member } : null;
    }

    /**
     * Initialize the SignalR connection.
     *
     * @param {boolean} [force=false] Force reconnect even if already connected.
     * @param {string} [hubHostname=''] When non-empty, connect to that region's
     *   `/sessionHub` (e.g. `https://astervoids-eastus.example.com`). When empty,
     *   connect to same-origin `/sessionHub` (legacy single-region behavior).
     *   Used by Phase 3 multi-region routing: Create connects to the user's
     *   best-RTT region, Join connects to the session's owning region.
     */
    async function connect(force = false, hubHostname = '') {
        const targetHostname = hubHostname || '';
        // If already connected to the requested region, fast-path return. A
        // hostname mismatch always triggers a rebuild so we don't keep stale
        // connections to a region the caller no longer wants.
        if (!force
            && connection
            && connection.state === signalR.HubConnectionState.Connected
            && currentHubHostname === targetHostname) {
            return true;
        }

        const thisConnectionEpoch = ++connectionEpoch;
        const stale = connection;
        connection = null;
        sessionTransitionTail = Promise.resolve();
        invalidateSession('connect');

        // Stop any existing connection to prevent stale event handlers from
        // firing after we create a new connection. On mobile, the OS kills
        // WebSocket connections when backgrounded. Without this cleanup, the
        // old connection's onclose fires after the new connection is established
        // and trashes the restored session state.
        //
        // The connection = null before stale.stop() is intentional: it ensures
        // any synchronously-fired onclose from stop() sees connection !== thisConnection
        // and skips. The connection epoch makes the async stop window safe: a newer
        // connect/disconnect supersedes this transition before it can install or
        // publish a replacement connection.
        //
        // IMPORTANT: await stop() to ensure the old WebSocket is fully closed before
        // starting a new one. On mobile browsers with limited resources, starting a
        // new WebSocket while the old one is still closing can fail.
        if (stale) {
            let timeoutHandle = null;
            try {
                // Race against a 3s timeout to prevent hanging on dead connections
                await Promise.race([
                    stale.stop(),
                    new Promise(r => {
                        timeoutHandle = setTimeout(r, 3000);
                    })
                ]);
            } catch (e) { /* ignore */ }
            finally {
                if (timeoutHandle != null) clearTimeout(timeoutHandle);
            }
        }

        if (connectionEpoch !== thisConnectionEpoch || connection !== null) {
            return false;
        }

        let nextConnection = null;
        try {
            const hubUrl = targetHostname
                ? `${targetHostname.replace(/\/$/, '')}/sessionHub`
                : '/sessionHub';
            nextConnection = new signalR.HubConnectionBuilder()
                .withUrl(hubUrl)
                .withHubProtocol(new signalR.protocols.msgpack.MessagePackHubProtocol())
                .withAutomaticReconnect({
                    nextRetryDelayInMilliseconds: retryContext => {
                        if (retryContext.previousRetryCount >= maxReconnectAttempts) {
                            return null; // Stop retrying — triggers onclose → auto-rejoin
                        }
                        return reconnectDelay;
                    }
                })
                .configureLogging(signalR.LogLevel.Information)
                .build();
            connection = nextConnection;
            currentHubHostname = targetHostname;

            // Register event handlers
            setupEventHandlers(nextConnection, thisConnectionEpoch);

            // Match server-side timeouts: ClientTimeoutInterval=20s, KeepAliveInterval=10s.
            nextConnection.serverTimeoutInMilliseconds = 20000;
            nextConnection.keepAliveIntervalInMilliseconds = 10000;

            await nextConnection.start();
            if (connectionEpoch !== thisConnectionEpoch || connection !== nextConnection) {
                return false;
            }
            _log('[SessionClient] Connected to session hub');

            if (callbacks.onConnected) {
                callbacks.onConnected();
            }

            return connectionEpoch === thisConnectionEpoch && connection === nextConnection;
        } catch (err) {
            if (connectionEpoch !== thisConnectionEpoch || connection !== nextConnection) {
                return false;
            }
            connection = null;
            _error('[SessionClient] Connection failed:', err);
            if (callbacks.onError) {
                callbacks.onError('Connection failed: ' + err.message);
            }
            return false;
        }
    }

    /**
     * Disconnect from the SignalR hub.
     */
    async function disconnect() {
        const thisConnectionEpoch = ++connectionEpoch;
        const stale = connection;
        connection = null;
        currentHubHostname = '';
        sessionTransitionTail = Promise.resolve();
        invalidateSession('disconnect', true);

        if (!stale) return;

        try {
            await stale.stop();
            if (connectionEpoch === thisConnectionEpoch) {
            }
        } catch (err) {
            if (connectionEpoch === thisConnectionEpoch) {
                _error('[SessionClient] Disconnect error:', err);
            }
        }
    }

    /**
     * Hub event table.
     *
     * Every entry is wrapped by the same `guard` in setupEventHandlers, so the
     * table records only what differs per event: whether the handler is
     * session-scoped and whether the guard may rewrite binary GUIDs in all
     * arguments (opaque byte payloads opt out and transform their known GUID
     * slots themselves).
     *
     * ValidAt is a single batch-level trailing argument on each broadcast
     * (every object in a single broadcast shares the same owner-stamped sample
     * time after server validation). Snapshot DTOs (JoinSessionResponse,
     * SessionStateSnapshot) carry a parallel validAts dictionary keyed by
     * objectId so each pre-existing object keeps its own age.
     */
    const HUB_EVENTS = [
        // ── Session events ──
        {
            name: 'OnMemberJoined',
            sessionScoped: true,
            handler: (memberInfo, senderMemberId, memberSequence, serverTimestamp) => {
                WireEnum.translateMember(memberInfo);
                handleMemberEvent({
                    kind: 'joined',
                    memberInfo,
                    senderMemberId,
                    memberSequence
                });
            }
        },
        {
            name: 'OnMemberLeft',
            sessionScoped: true,
            handler: (info, senderMemberId, memberSequence, serverTimestamp) => {
                if (info) {
                    info.promotedRole = WireEnum.roleFromWire(info.promotedRole);
                    // Member-scoped objects of the departing member are gone;
                    // their handles will never be addressed again.
                    if (Array.isArray(info.deletedObjectIds)) {
                        for (const objectId of info.deletedObjectIds) forgetObjectHandle(objectId);
                    }
                }
                handleMemberEvent({
                    kind: 'left',
                    info,
                    senderMemberId,
                    memberSequence,
                    roleChanged: false
                });
            }
        },
        // ── Object events ──
        {
            name: 'OnObjectCreated',
            sessionScoped: true,
            handler: (objectInfo, senderMemberId, memberSequence, serverTimestamp, validAt) => {
                objectInfo = decodeObjectInfo(objectInfo);
                if (callbacks.onObjectCreated) {
                    callbacks.onObjectCreated(objectInfo, senderMemberId, memberSequence, validAt);
                }
                deliverParkedUpdates();
            }
        },
        {
            name: 'OnObjectsUpdated',
            sessionScoped: true,
            handler: (objects, senderMemberId, senderSequence, memberSequence, serverTimestamp, senderSendIntervalMs, validAt) => {
                // Entries arrive as [handle, payload, version]. Resolve each
                // handle to the object id ObjectSync and the game speak, and
                // park the ones whose create we have not seen yet.
                const dispatch = resolved => {
                    if (callbacks.onObjectsUpdated) {
                        callbacks.onObjectsUpdated(resolved, serverTimestamp, senderMemberId,
                            senderSequence, memberSequence, senderSendIntervalMs, validAt);
                    }
                };
                if (!Array.isArray(objects)) {
                    dispatch(objects);
                    return;
                }
                const decoded = [];
                let anyUnknown = false;
                for (let i = 0; i < objects.length; i++) {
                    const update = normalizeObjectUpdateInfo(objects[i]);
                    SyncPayload.unwrapObjectData(update);
                    if (!update || !(update.handle > 0)) continue;
                    decoded.push(update);
                    if (!objectIdsByHandle.has(update.handle)) anyUnknown = true;
                }
                if (anyUnknown) {
                    // Park the whole batch rather than delivering the half we can
                    // address: a partial delivery would advance the sender's
                    // sequence and mask the loss of the rest.
                    parkObjectBatch(decoded, dispatch);
                    return;
                }
                const resolved = decoded.map(update =>
                    toObjectUpdate(update, objectIdsByHandle.get(update.handle)));
                if (resolved.length > 0) dispatch(resolved);
            }
        },
        {
            name: 'OnObjectDeleted',
            sessionScoped: true,
            handler: (objectId, senderMemberId, memberSequence, serverTimestamp) => {
                forgetObjectHandle(objectId);
                if (callbacks.onObjectDeleted) {
                    callbacks.onObjectDeleted(objectId, senderMemberId, memberSequence);
                }
            }
        },
        {
            name: 'OnObjectReplaced',
            sessionScoped: true,
            handler: (event, senderMemberId, memberSequence, serverTimestamp, validAt) => {
                dispatchObjectReplacement(event, senderMemberId, memberSequence, validAt);
            }
        },
        {
            // Generic per-object event channel (Phase 2.1).
            // Server relays eventInfo.payload as opaque game-encoded bytes.
            // ObjectSync decodes and dispatches by eventKind byte.
            name: 'OnObjectEvent',
            sessionScoped: true,
            transformGuids: false,
            handler: (eventInfo, senderMemberId, memberSequence, serverTimestamp, validAt) => {
                eventInfo = normalizeObjectEventInfo(eventInfo);
                if (eventInfo) {
                    eventInfo.objectId = GuidUtils.transformBinaryGuids(eventInfo.objectId);
                }
                senderMemberId = GuidUtils.transformBinaryGuids(senderMemberId);
                if (callbacks.onObjectEvent) {
                    callbacks.onObjectEvent(eventInfo, senderMemberId, memberSequence, validAt);
                }
            }
        },
        // ── Session lifecycle signals ──
        {
            // Session list changed (signal only - fetch data separately)
            name: 'OnSessionsChanged',
            handler: () => {
                if (callbacks.onSessionsChanged) {
                    callbacks.onSessionsChanged();
                }
            }
        },
        {
            name: 'OnSessionExpired',
            sessionScoped: true,
            handler: (expiredSessionId, reason) => {
                if (!acceptsExpirationForSession(expiredSessionId)) return;

                const expiredSessionEpoch = invalidateSession('sessionExpired', true);
                if (sessionEpoch === expiredSessionEpoch && callbacks.onSessionExpired) {
                    callbacks.onSessionExpired(reason, expiredSessionId);
                }
            }
        }
    ];

    /**
     * Setup SignalR event handlers.
     * Captures a reference to the current connection so that if connect()
     * replaces it later (e.g., after a mobile background disconnect), the
     * old connection's handlers are silently ignored instead of trashing
     * the newly restored session state.
     */
    function setupEventHandlers(thisConnection, thisConnectionEpoch) {

        // Guard wrapper: skips stale handlers and normally transforms binary
        // GUIDs in all arguments. Opaque byte payload handlers opt out and
        // transform only their known GUID slots.
        const guard = (fn, sessionScoped = false, transformGuids = true) => (...args) => {
            if (connection === thisConnection
                && connectionEpoch === thisConnectionEpoch
                && (!sessionScoped || acceptsSessionEvents())) {
                if (transformGuids) {
                    for (let i = 0; i < args.length; i++) {
                        args[i] = GuidUtils.transformBinaryGuids(args[i]);
                    }
                }
                fn(...args);
            }
        };

        // Transport lifecycle — distinct SignalR API, not hub methods.
        thisConnection.onreconnecting(guard(error => {
            if (callbacks.onReconnecting) {
                callbacks.onReconnecting(error);
            }
        }));

        thisConnection.onreconnected(guard(connectionId => {
            // Reconcile state — invoke responses for Create/Delete/Update may have been
            // lost during the reconnection window (OthersInGroup means no broadcast fallback)
            ObjectSync.triggerReconciliation();
            if (callbacks.onConnected) {
                callbacks.onConnected();
            }
        }));

        thisConnection.onclose(guard(error => {
            connection = null;
            sessionTransitionTail = Promise.resolve();
            const closedConnectionEpoch = ++connectionEpoch;
            invalidateSession('connectionClosed');
            // Note: lastSessionId is intentionally NOT cleared here.
            // It is preserved so the game can attempt auto-rejoin after reconnecting.
            if (connectionEpoch === closedConnectionEpoch
                && connection === null
                && callbacks.onDisconnected) {
                callbacks.onDisconnected(error);
            }
        }));

        for (const event of HUB_EVENTS) {
            thisConnection.on(
                event.name,
                guard(event.handler, event.sessionScoped === true, event.transformGuids !== false));
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────

    /**
     * Throws if not connected to the SignalR hub.
     */
    function ensureConnected() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            throw new Error('Not connected to session hub');
        }
    }

    /**
     * Throws if not connected or not in a session.
     */
    function ensureInSession() {
        ensureConnected();
        if (!currentSession) {
            throw new Error('Not in a session');
        }
    }

    /**
     * Invoke a hub method with standard error handling.
     * Ensures the client is in a session, invokes the method, and wraps
     * errors with a descriptive log before re-throwing.
     */
    async function invokeHub(method, ...args) {
        ensureInSession();
        const context = captureSessionContext();
        try {
            const result = await context.connection.invoke(method, ...args);
            if (!isSessionContextCurrent(context)) {
                throw staleOperationError();
            }
            return GuidUtils.transformBinaryGuids(result);
        } catch (err) {
            if (!isSessionContextCurrent(context) || err?.name === 'StaleOperationError') {
                throw staleOperationError();
            }
            _error(`[SessionClient] ${method} failed:`, err);
            throw err;
        }
    }

    /**
     * Create a new session.
     * @param {object} [metadata] - Optional key-value metadata for the session (e.g. { aspectRatio: 1.78 }).
     */
    async function createSessionCore(metadata) {
        ensureConnected();
        if (currentSession && !await leaveSessionCore()) {
            throw new Error('Could not leave the current session before creating another.');
        }
        const thisSessionEpoch = beginSessionTransition('create');
        const context = captureSessionContext();
        if (context.sessionEpoch !== thisSessionEpoch || !isSessionContextCurrent(context)) {
            return null;
        }

        try {
            const rawResponse = await context.connection.invoke('CreateSession', metadata || null);
            if (!isSessionContextCurrent(context)) {
                return null;
            }
            const response = GuidUtils.transformBinaryGuids(rawResponse);
            if (!response) {
                finishSessionTransition(thisSessionEpoch);
                return null;
            }
            replaceSessionSchemas(response.metadata);

            const createdMember = {
                id: response.memberId,
                role: WireEnum.roleFromWire(response.role),
                joinedAt: new Date().toISOString()
            };
            const createdSession = {
                id: response.sessionId,
                name: response.sessionName,
                members: [createdMember],
                objects: [],
                metadata: response.metadata || {}
            };
            const nextReconnectIdentity = reconnectIdentityFromResponse(
                response, createdSession.id, createdMember.id);
            return completeSessionEntry(
                context, createdSession, createdMember, nextReconnectIdentity, 'onSessionCreated');
        } catch (err) {
            if (!isSessionContextCurrent(context)) {
                return null;
            }
            finishSessionTransition(thisSessionEpoch);
            _error('[SessionClient] Create session failed:', err);
            if (callbacks.onError) {
                callbacks.onError('Failed to create session: ' + err.message);
            }
            throw err;
        }
    }

    /**
     * Join an existing session.
     */
    async function joinSessionCore(sessionId) {
        ensureConnected();
        if (currentSession?.id === sessionId) {
            return { session: currentSession, member: currentMember };
        }
        if (currentSession && !await leaveSessionCore()) {
            throw new Error('Could not leave the current session before joining another.');
        }
        const reconnecting = reconnectIdentity?.sessionId === sessionId
            ? reconnectIdentity
            : null;
        const thisSessionEpoch = beginSessionTransition('join', false, sessionId);
        const context = captureSessionContext();
        if (context.sessionEpoch !== thisSessionEpoch || !isSessionContextCurrent(context)) {
            return null;
        }

        try {
            _log('[SessionClient] JoinSession invoking:', sessionId, 'rejoin:', !!reconnecting);
            const rawResponse = reconnecting
                ? await context.connection.invoke(
                    'RejoinSession',
                    GuidUtils.guidToBytes(sessionId),
                    GuidUtils.guidToBytes(reconnecting.memberId),
                    reconnecting.token)
                : await context.connection.invoke(
                    'JoinSession', GuidUtils.guidToBytes(sessionId));
            if (!isSessionContextCurrent(context)) {
                return null;
            }
            const response = GuidUtils.transformBinaryGuids(rawResponse);
            if (!response) {
                _warn('[SessionClient] JoinSession returned null — session not found, full, or rejected');
                finishSessionTransition(thisSessionEpoch);
                return null;
            }

            // Install the session contract before decoding any snapshot object.
            // The local registry is already populated for same-version clients;
            // metadata remains authoritative for this specific session.
            replaceSessionSchemas(response.metadata);

            // Translate compact enums/pairs to the ergonomic game-side shapes.
            if (Array.isArray(response.members)) {
                for (const m of response.members) WireEnum.translateMember(m);
            }
            decodeObjectInfos(response.objects, true);

            const joinedSession = {
                id: response.sessionId,
                name: response.sessionName,
                members: response.members,
                objects: response.objects,
                validAts: WireEnum.pairsToObject(response.validAts),
                metadata: response.metadata || {}
            };
            const joinedMember = {
                id: response.memberId,
                role: WireEnum.roleFromWire(response.role)
            };
            const nextReconnectIdentity = reconnectIdentityFromResponse(
                response, joinedSession.id, joinedMember.id);
            _log('[SessionClient] Joined session:', joinedSession.name, 'as', joinedMember.role);
            return completeSessionEntry(
                context, joinedSession, joinedMember, nextReconnectIdentity, 'onSessionJoined');
        } catch (err) {
            if (!isSessionContextCurrent(context)) {
                return null;
            }
            finishSessionTransition(thisSessionEpoch);
            _error('[SessionClient] Join session failed:', err);
            if (callbacks.onError) {
                callbacks.onError('Failed to join session: ' + err.message);
            }
            throw err;
        }
    }

    /**
     * Leave the current session.
     */
    async function leaveSessionCore() {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            return false;
        }

        const leftSession = currentSession;
        if (!leftSession) return true;

        const thisSessionEpoch = ++sessionEpoch;
        pendingSessionTransition = {
            kind: 'leave',
            epoch: thisSessionEpoch,
            targetSessionId: leftSession.id
        };
        const context = captureSessionContext();
        if (context.sessionEpoch !== thisSessionEpoch || !isSessionContextCurrent(context)) {
            return false;
        }

        try {
            await context.connection.invoke('LeaveSession');
            if (!isSessionContextCurrent(context)) {
                return false;
            }
            invalidateSession('leave', true);


            if (callbacks.onSessionLeft) {
                callbacks.onSessionLeft(leftSession);
            }
            return true;
        } catch (err) {
            if (!isSessionContextCurrent(context)) {
                return false;
            }
            finishSessionTransition(thisSessionEpoch);
            ObjectSync.triggerReconciliation();
            _error('[SessionClient] Leave session failed:', err);
            return false;
        }
    }

    function createSession(metadata) {
        return serializeSessionTransition(() => createSessionCore(metadata));
    }

    function joinSession(sessionId) {
        return serializeSessionTransition(() => joinSessionCore(sessionId));
    }

    function leaveSession() {
        return serializeSessionTransition(leaveSessionCore);
    }

    /**
     * Get list of active sessions.
     */
    async function getActiveSessions() {
        ensureConnected();
        const context = captureConnectionContext();

        try {
            const rawResponse = await context.connection.invoke('GetActiveSessions');
            if (!isConnectionContextCurrent(context)) {
                throw staleOperationError();
            }
            const response = GuidUtils.transformBinaryGuids(rawResponse);
            return {
                sessions: response.sessions || [],
                maxSessions: response.maxSessions,
                canCreateSession: response.canCreateSession
            };
        } catch (err) {
            if (!isConnectionContextCurrent(context) || err?.name === 'StaleOperationError') {
                throw staleOperationError();
            }
            _error('[SessionClient] Get sessions failed:', err);
            throw err;
        }
    }

    /**
     * Create a new object in the current session.
     * @param {Object} data - The data payload (game-side dict).
     * @param {string} [scope='Member'] - 'Session' or 'Member'.
     * @param {string|null} [ownerMemberId=null]
     * @param {number|null} [clientValidAt=null] - Owner's NTP-aligned server-time
     *   estimate of "now" at creation. Server clamps to ±2s of its own UtcNow
     *   before forwarding as the broadcast's validAt. Pass null to fall back to
     *   the server's hub-entry timestamp (slightly upload-biased).
     * @param {number} [schemaId=0] Phase 4: positional schema id (0 = legacy MessagePack dict).
     */
    async function createObject(data, scope = 'Member', ownerMemberId = null, clientValidAt = null, schemaId = 0) {
        const context = captureSessionContext();
        let response = await invokeHub('CreateObject', SyncPayload.wrap(data, schemaId), scope, ownerMemberId, clientValidAt);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        response = normalizeCreateObjectResponse(response);
        // Phase 3 envelope: response.objectInfo.data arrives as a SyncPayload
        // [schemaId, Uint8Array]; unwrap so the owner-side path in object-sync.js
        // sees the same plain dict shape as remote receivers.
        if (response && response.objectInfo) {
            response.objectInfo = decodeObjectInfo(response.objectInfo);
            deliverParkedUpdates();
        }
        return response;
    }

    /**
     * Update multiple objects atomically.
     * @param {Array} updates Each entry: { objectId, data, schemaId? }. schemaId
     *   defaults to 0 (legacy dict).
     * @param {number|null} [senderSequence=null]
     * @param {number|null} [senderSendIntervalMs=null]
     * @param {number|null} [clientValidAt=null] - Owner's NTP-aligned server-time
     *   estimate of the simulation tick that produced this batch. Server clamps
     *   to ±2s before forwarding as the broadcast's validAt. Null falls back to
     *   the server's hub-entry timestamp.
     */
    async function updateObjects(updates, senderSequence = null, senderSendIntervalMs = null, clientValidAt = null) {
        const context = captureSessionContext();
        // Phase 3 envelope: wrap each update.data into the SyncPayload wire shape
        // before invoking. Avoid mutating the caller's request objects so callers
        // can keep using their `update.data` references for local bookkeeping.
        // Phase 4: each update may carry an explicit schemaId; default 0.
        // Each entry addresses its object by session-scoped handle rather than
        // by GUID, so `sent` records which request each wire slot came from —
        // the positional acknowledgement is indexed against the wire array.
        let wrapped = updates;
        let sent = updates;
        if (Array.isArray(updates)) {
            wrapped = [];
            sent = [];
            for (let i = 0; i < updates.length; i++) {
                const u = updates[i];
                if (u && u.data !== undefined) {
                    const handle = handlesByObjectId.get(u.objectId);
                    if (handle === undefined) {
                        // No handle means the server never told us about this
                        // object (or it has been deleted). Nothing addressable
                        // to send; leaving it out of the acknowledgement keeps
                        // "absent" meaning "not confirmed, re-send".
                        _warn('[SessionClient] Skipping update for object with no session handle:', u.objectId);
                        continue;
                    }
                    const id = (u.schemaId === undefined || u.schemaId === null) ? 0 : u.schemaId;
                    wrapped.push([handle, SyncPayload.wrap(u.data, id)]);
                } else {
                    wrapped.push(u);
                }
                sent.push(u);
            }
        }
        let response = await invokeHub('UpdateObjects', wrapped, senderSequence, senderSendIntervalMs, clientValidAt);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        response = normalizeUpdateObjectsResponse(response);
        // response.versions is positional on the wire: entry i is the version
        // assigned to the request we sent at index i, or 0 when the server did
        // not apply it. The object identity is omitted precisely because we
        // already know it at each index. Game code expects a string-keyed object
        // so it can do `versions[id]` and `Object.entries(versions)`, so fold it
        // back here — the transport layer owns the wire shape, ObjectSync keeps
        // seeing the logical one.
        if (response) {
            response.versions = versionsByObjectId(response.versions, sent);
        }
        return response;
    }

    /**
     * Folds the positional UpdateObjects acknowledgement back into a
     * {objectId: version} object. Entries with version 0 (not applied) are
     * omitted so callers keep treating "absent" as "not confirmed" and re-send.
     * @param {number[]} versions - Positional versions aligned to `sent`.
     * @param {Array} sent - The requests actually placed on the wire, in wire
     *   order. Requests skipped for want of a session handle are not in it, so
     *   the index alignment with `versions` holds.
     */
    function versionsByObjectId(versions, sent) {
        const byId = {};
        if (!Array.isArray(versions) || !Array.isArray(sent)) return byId;
        const count = Math.min(versions.length, sent.length);
        for (let i = 0; i < count; i++) {
            const version = versions[i];
            if (!(version > 0)) continue;
            const objectId = sent[i]?.objectId;
            if (objectId === undefined || objectId === null) continue;
            // A batch may legitimately carry an id more than once; the last
            // occurrence holds the newest version, matching server apply order.
            if (byId[objectId] === undefined || version > byId[objectId]) {
                byId[objectId] = version;
            }
        }
        return byId;
    }

    /**
     * Atomically delete an object and create replacements in a single broadcast.
     * @param {string} deleteObjectId
     * @param {Array} replacements
     * @param {string} [scope='Session']
     * @param {string|null} [ownerMemberId=null]
     * @param {number|null} [clientValidAt=null] - Owner's NTP-aligned server-time
     *   estimate of "server time at this moment" (e.g. collision detection).
     *   Server clamps to ±2000ms of its own UtcNow before forwarding as the
     *   broadcast's validAt. Pass null to fall back to server's hub-entry
     *   timestamp (less accurate).
     * @param {function} [onReplaced] - Authoritative result handler, invoked before
     *   resolving the created-object array. Defaults to onObjectReplaced; ObjectSync
     *   overrides it to reject results from a cleared replication epoch.
     */
    async function replaceObject(deleteObjectId, replacements, scope = 'Session', ownerMemberId = null, clientValidAt = null, schemaIds = null, onReplaced = callbacks.onObjectReplaced) {
        const context = captureSessionContext();
        // Phase 3 envelope: each replacement is a raw game data dict; wrap before invoke.
        // Phase 4: schemaIds may be a parallel array of schemaId per replacement;
        // omitted/null entries fall back to 0 (legacy MessagePack dict).
        const wrapped = Array.isArray(replacements)
            ? replacements.map((r, i) => SyncPayload.wrap(r, (schemaIds && schemaIds[i]) || 0))
            : replacements;
        const response = await invokeHub('ReplaceObject', GuidUtils.guidToBytes(deleteObjectId), wrapped, scope, ownerMemberId, clientValidAt);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        if (!response) return null;
        const [createdObjects, memberSequence, validAt] = Array.isArray(response)
            ? response
            : [response.createdObjects, response.memberSequence, response.validAt];
        // Preserve the public array return while delivering authoritative metadata
        // before resolving. ObjectSync supplies a handler scoped to its own epoch.
        return dispatchObjectReplacement(
            { deletedObjectId: deleteObjectId, createdObjects },
            currentMember.id, memberSequence, validAt, onReplaced);
    }

    /**
     * Delete an object from the session.
     */
    async function deleteObject(objectId) {
        const context = captureSessionContext();
        let response = await invokeHub('DeleteObject', GuidUtils.guidToBytes(objectId));
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        // The handle is dead either way: on success the server dropped the
        // object, and on failure this client has already removed it locally
        // (delete is local-first). A later snapshot re-teaches the mapping if
        // the object turns out to still exist.
        forgetObjectHandle(objectId);
        return normalizeDeleteObjectResponse(response);
    }

    /**
     * Broadcast a per-object event to all other members of the session.
     * Server is a relay — payload is opaque game-encoded bytes. Caller
     * must own objectId; the server enforces this and returns false on
     * mismatch. Use for low-frequency state transitions that don't
     * belong on the per-frame update path.
     */
    async function broadcastObjectEvent(objectId, eventKind, payload, clientValidAt = null) {
        const context = captureSessionContext();
        const response = await invokeHub('BroadcastObjectEvent', GuidUtils.guidToBytes(objectId), eventKind, payload, clientValidAt);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        return response;
    }

    async function getSessionState() {
        const context = captureSessionContext();
        const snapshot = await invokeHub('GetSessionState');
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        if (snapshot) {
            // Phase 1 wire-shape: SessionStateSnapshot now carries members with byte
            // role, objects with byte scope, and validAts/memberSequences as
            // GuidLongPair[] (deserialized as [guidString, long] arrays after
            // GuidUtils.transformBinaryGuids). Translate to legacy shapes here so
            // game/object-sync code keeps using string roles/scopes and string-keyed
            // dicts for validAts/memberSequences.
            if (Array.isArray(snapshot.members)) {
                for (const m of snapshot.members) WireEnum.translateMember(m);
            }
            decodeObjectInfos(snapshot.objects, true);
            snapshot.validAts = WireEnum.pairsToObject(snapshot.validAts);
            snapshot.memberSequences = WireEnum.pairsToObject(snapshot.memberSequences);
        }
        return snapshot;
    }

    /**
     * Returns the server's current UTC time in unix milliseconds. Used by
     * the client's NTP-style clock-offset estimator (RemoteObjects.clock).
     * Captured on the server's return statement for minimum processing bias.
     * Does NOT require session membership.
     */
    async function ping() {
        if (!isConnected()) {
            throw new Error('Not connected');
        }
        const context = captureConnectionContext();
        const result = await context.connection.invoke('Ping');
        if (!isConnectionContextCurrent(context)) {
            throw staleOperationError();
        }
        return result;
    }

    /**
     * Register event callbacks.
     */
    function on(event, callback) {
        if (callbacks.hasOwnProperty(event)) {
            callbacks[event] = callback;
        } else {
            _warn('[SessionClient] Unknown event:', event);
        }
    }

    /**
     * Get current session info.
     */
    function getCurrentSession() {
        return currentSession;
    }

    /**
     * Get current member info.
     */
    function getCurrentMember() {
        return currentMember;
    }

    /**
     * Check if connected.
     */
    function isConnected() {
        return connection && connection.state === signalR.HubConnectionState.Connected;
    }

    /**
     * Check if in a session.
     */
    function isInSession() {
        return currentSession !== null;
    }

    /**
     * Get the last session ID (preserved after unexpected disconnect for auto-rejoin).
     */
    function getLastSessionId() {
        return lastSessionId;
    }

    function getReconnectHubHostname() {
        return reconnectIdentity?.hubHostname ?? currentHubHostname;
    }

    /**
     * Stable identity for this client within the current session. Unlike the
     * member id, it survives the evict-and-re-register a reconnect performs, so
     * game state can count each participant once no matter how often they drop.
     */
    function getParticipantId() {
        return currentSession
            ? participantIdentities.get(currentSession.id) ?? null
            : null;
    }

    /**
     * Clear stale session/member state without disconnecting.
     * Used when reconciliation fails after auto-reconnect: the transport is alive
     * but the server no longer recognizes this connection as a session member.
     */
    function clearSessionState() {
        invalidateSession('clearSessionState');
    }

    /**
     * Returns the hostname the current SignalR connection is bound to (e.g.
     * `https://astervoids-westus2.example.com`), or `''` for same-origin /
     * legacy single-region connections. Used by the picker to display which
     * region the user is currently talking to and to verify Phase 3 routing.
     */
    function getCurrentHubHostname() {
        return currentHubHostname;
    }

    function getSessionEpoch() {
        return sessionEpoch;
    }

    function getConnectionEpoch() {
        return connectionEpoch;
    }

    // Public API
    return {
        connect,
        disconnect,
        createSession,
        joinSession,
        leaveSession,
        getActiveSessions,
        createObject,
        updateObjects,
        replaceObject,
        deleteObject,
        broadcastObjectEvent,
        getSessionState,
        ping,
        on,
        getCurrentSession,
        getCurrentMember,
        isConnected,
        isInSession,
        getLastSessionId,
        getReconnectHubHostname,
        getParticipantId,
        clearSessionState,
        getCurrentHubHostname,
        getSessionEpoch,
        getConnectionEpoch
    };
})();

// Attach to window for cross-script discovery in classic <script> context.
// Top-level `const X = (function(){})()` in classic scripts is NOT auto-attached
// to window (only reachable by bare name from sibling scripts via script-level
// lexical scope). Code that uses `if (window.SessionClient)` as a feature
// detection idiom would silently fail without this.
if (typeof window !== 'undefined') {
    window.SessionClient = SessionClient;
}

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionClient;
}
