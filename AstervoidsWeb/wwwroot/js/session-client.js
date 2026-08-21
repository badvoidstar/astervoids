/**
 * Session Client Module
 * Handles SignalR connection and session management communication.
 */

const SessionClient = (function() {
    const _log = (...a) => window.ASTERVOIDS_DEBUG && console.log(...a);
    const _warn = (...a) => window.ASTERVOIDS_DEBUG && console.warn(...a);
    const _error = (...a) => window.ASTERVOIDS_DEBUG && console.error(...a);

    let connection = null;
    let currentSession = null;
    let currentMember = null;
    let lastSessionId = null; // Track for auto-rejoin after unexpected disconnect
    let reconnectIdentity = null; // { sessionId, memberId, token }, never broadcast
    let reconnectAttempts = 0;
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

    function normalizeObjectInfo(value) {
        if (!Array.isArray(value)) return value;
        return {
            id: value[0],
            creatorMemberId: value[1],
            ownerMemberId: value[2],
            scope: value[3],
            data: value[4],
            version: value[5]
        };
    }

    function normalizeObjectUpdateInfo(value) {
        if (!Array.isArray(value)) return value;
        return {
            id: value[0],
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
            reconnectAttempts = 0;

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
                // console.log('[SessionClient] Disconnected');
            }
        } catch (err) {
            if (connectionEpoch === thisConnectionEpoch) {
                _error('[SessionClient] Disconnect error:', err);
            }
        }
    }

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

        thisConnection.onreconnecting(guard(error => {
            // console.log('[SessionClient] Reconnecting...', error);
            if (callbacks.onReconnecting) {
                callbacks.onReconnecting(error);
            }
        }));

        thisConnection.onreconnected(guard(connectionId => {
            // console.log('[SessionClient] Reconnected:', connectionId);
            reconnectAttempts = 0;
            // Reconcile state — invoke responses for Create/Delete/Update may have been
            // lost during the reconnection window (OthersInGroup means no broadcast fallback)
            ObjectSync.triggerReconciliation();
            if (callbacks.onConnected) {
                callbacks.onConnected();
            }
        }));

        thisConnection.onclose(guard(error => {
            // console.log('[SessionClient] Connection closed:', error);
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

        // Session events
        thisConnection.on('OnMemberJoined', guard((memberInfo, senderMemberId, memberSequence, serverTimestamp) => {
            // console.log('[SessionClient] Member joined:', memberInfo);
            WireEnum.translateMember(memberInfo);
            handleMemberEvent({
                kind: 'joined',
                memberInfo,
                senderMemberId,
                memberSequence
            });
        }, true));

        thisConnection.on('OnMemberLeft', guard((info, senderMemberId, memberSequence, serverTimestamp) => {
            // console.log('[SessionClient] Member left:', info);
            if (info) info.promotedRole = WireEnum.roleFromWire(info.promotedRole);
            handleMemberEvent({
                kind: 'left',
                info,
                senderMemberId,
                memberSequence,
                roleChanged: false
            });
        }, true));

        // Object events
        // ValidAt is now a single batch-level trailing argument on each broadcast
        // (every object in a single broadcast shares the same owner-stamped sample
        // time after server validation). Snapshot DTOs (JoinSessionResponse,
        // SessionStateSnapshot) carry a parallel validAts dictionary keyed by
        // objectId so each pre-existing object keeps its own age.
        thisConnection.on('OnObjectCreated', guard((objectInfo, senderMemberId, memberSequence, serverTimestamp, validAt) => {
            objectInfo = normalizeObjectInfo(objectInfo);
            WireEnum.translateObject(objectInfo);
            SyncPayload.unwrapObjectData(objectInfo);
            if (callbacks.onObjectCreated) {
                callbacks.onObjectCreated(objectInfo, senderMemberId, memberSequence, validAt);
            }
        }, true));

        thisConnection.on('OnObjectsUpdated', guard((objects, senderMemberId, senderSequence, memberSequence, serverTimestamp, senderSendIntervalMs, validAt) => {
            if (Array.isArray(objects)) {
                for (let i = 0; i < objects.length; i++) {
                    objects[i] = normalizeObjectUpdateInfo(objects[i]);
                    SyncPayload.unwrapObjectData(objects[i]);
                }
            }
            if (callbacks.onObjectsUpdated) {
                callbacks.onObjectsUpdated(objects, serverTimestamp, senderMemberId, senderSequence, memberSequence, senderSendIntervalMs, validAt);
            }
        }, true));

        thisConnection.on('OnObjectDeleted', guard((objectId, senderMemberId, memberSequence, serverTimestamp) => {
            if (callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(objectId, senderMemberId, memberSequence);
            }
        }, true));

        thisConnection.on('OnObjectReplaced', guard((event, senderMemberId, memberSequence, serverTimestamp, validAt) => {
            event = normalizeObjectReplacedEvent(event);
            if (event && Array.isArray(event.createdObjects)) {
                for (let i = 0; i < event.createdObjects.length; i++) {
                    const objectInfo = normalizeObjectInfo(event.createdObjects[i]);
                    event.createdObjects[i] = objectInfo;
                    WireEnum.translateObject(objectInfo);
                    SyncPayload.unwrapObjectData(objectInfo);
                }
            }
            if (callbacks.onObjectReplaced) {
                callbacks.onObjectReplaced(event, senderMemberId, memberSequence, validAt);
            }
        }, true));

        // Generic per-object event channel (Phase 2.1).
        // Server relays eventInfo.payload as opaque game-encoded bytes.
        // ObjectSync decodes and dispatches by eventKind byte.
        thisConnection.on('OnObjectEvent', guard((eventInfo, senderMemberId, memberSequence, serverTimestamp, validAt) => {
            eventInfo = normalizeObjectEventInfo(eventInfo);
            if (eventInfo) {
                eventInfo.objectId = GuidUtils.transformBinaryGuids(eventInfo.objectId);
            }
            senderMemberId = GuidUtils.transformBinaryGuids(senderMemberId);
            if (callbacks.onObjectEvent) {
                callbacks.onObjectEvent(eventInfo, senderMemberId, memberSequence, validAt);
            }
        }, true, false));

        // Session list changed (signal only - fetch data separately)
        thisConnection.on('OnSessionsChanged', guard(() => {
            // console.log('[SessionClient] Sessions changed signal received');
            if (callbacks.onSessionsChanged) {
                callbacks.onSessionsChanged();
            }
        }));

        thisConnection.on('OnSessionExpired', guard((expiredSessionId, reason) => {
            if (!acceptsExpirationForSession(expiredSessionId)) return;

            const expiredSessionEpoch = invalidateSession('sessionExpired', true);
            if (sessionEpoch === expiredSessionEpoch && callbacks.onSessionExpired) {
                callbacks.onSessionExpired(reason, expiredSessionId);
            }
        }, true));
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
                // console.log('[SessionClient] CreateSession failed - server at capacity');
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
            currentMember = createdMember;
            currentSession = createdSession;
            reconnectIdentity = nextReconnectIdentity;
            const pendingMemberEvents = applyPendingMemberEvents(thisSessionEpoch);

            // console.log('[SessionClient] Session created:', currentSession.name);
            lastSessionId = currentSession.id;
            finishSessionTransition(thisSessionEpoch);

            if (callbacks.onSessionCreated) {
                callbacks.onSessionCreated(currentSession, currentMember);
            }
            for (const event of pendingMemberEvents) {
                if (!isSessionContextCurrent(context)) break;
                dispatchMemberEvent(event);
            }

            if (!isSessionContextCurrent(context)) {
                return null;
            }
            return { session: createdSession, member: createdMember };
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
                    sessionId,
                    reconnecting.memberId,
                    reconnecting.token)
                : await context.connection.invoke(
                    'JoinSession', sessionId);
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
            if (Array.isArray(response.objects)) {
                for (let i = 0; i < response.objects.length; i++) {
                    const objectInfo = normalizeObjectInfo(response.objects[i]);
                    response.objects[i] = objectInfo;
                    WireEnum.translateObject(objectInfo);
                    SyncPayload.unwrapObjectData(objectInfo);
                }
            }

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
            currentSession = joinedSession;
            currentMember = joinedMember;
            reconnectIdentity = nextReconnectIdentity;
            const pendingMemberEvents = applyPendingMemberEvents(thisSessionEpoch);

            _log('[SessionClient] Joined session:', currentSession.name, 'as', currentMember.role);
            lastSessionId = currentSession.id;
            finishSessionTransition(thisSessionEpoch);

            if (callbacks.onSessionJoined) {
                callbacks.onSessionJoined(currentSession, currentMember);
            }
            for (const event of pendingMemberEvents) {
                if (!isSessionContextCurrent(context)) break;
                dispatchMemberEvent(event);
            }

            if (!isSessionContextCurrent(context)) {
                return null;
            }
            return { session: joinedSession, member: joinedMember };
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

            // console.log('[SessionClient] Left session');

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
            response.objectInfo = normalizeObjectInfo(response.objectInfo);
            WireEnum.translateObject(response.objectInfo);
            SyncPayload.unwrapObjectData(response.objectInfo);
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
        let wrapped = updates;
        if (Array.isArray(updates)) {
            wrapped = new Array(updates.length);
            for (let i = 0; i < updates.length; i++) {
                const u = updates[i];
                if (u && u.data !== undefined) {
                    const id = (u.schemaId === undefined || u.schemaId === null) ? 0 : u.schemaId;
                    wrapped[i] = [u.objectId, SyncPayload.wrap(u.data, id)];
                } else {
                    wrapped[i] = u;
                }
            }
        }
        let response = await invokeHub('UpdateObjects', wrapped, senderSequence, senderSendIntervalMs, clientValidAt);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        response = normalizeUpdateObjectsResponse(response);
        // Phase 1 wire-shape: response.versions is GuidLongPair[] on the wire (each
        // entry deserialized as [guidString, long]). Game code expects a string-keyed
        // object so it can do `versions[id]` and `Object.entries(versions)`.
        if (response) {
            response.versions = WireEnum.pairsToObject(response.versions);
        }
        return response;
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
     */
    async function replaceObject(deleteObjectId, replacements, scope = 'Session', ownerMemberId = null, clientValidAt = null, schemaIds = null) {
        const context = captureSessionContext();
        // Phase 3 envelope: each replacement is a raw game data dict; wrap before invoke.
        // Phase 4: schemaIds may be a parallel array of schemaId per replacement;
        // omitted/null entries fall back to 0 (legacy MessagePack dict).
        const wrapped = Array.isArray(replacements)
            ? replacements.map((r, i) => SyncPayload.wrap(r, (schemaIds && schemaIds[i]) || 0))
            : replacements;
        const created = await invokeHub('ReplaceObject', deleteObjectId, wrapped, scope, ownerMemberId, clientValidAt);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
        // Server returns List<ObjectInfo> for the owner; unwrap each so any
        // downstream consumer sees the canonical dict shape.
        if (Array.isArray(created)) {
            for (let i = 0; i < created.length; i++) {
                created[i] = normalizeObjectInfo(created[i]);
                WireEnum.translateObject(created[i]);
                SyncPayload.unwrapObjectData(created[i]);
            }
        }
        return created;
    }

    /**
     * Delete an object from the session.
     */
    async function deleteObject(objectId) {
        const context = captureSessionContext();
        let response = await invokeHub('DeleteObject', objectId);
        if (!isSessionContextCurrent(context)) {
            throw staleOperationError();
        }
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
        const response = await invokeHub('BroadcastObjectEvent', objectId, eventKind, payload, clientValidAt);
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
            if (Array.isArray(snapshot.objects)) {
                for (let i = 0; i < snapshot.objects.length; i++) {
                    const objectInfo = normalizeObjectInfo(snapshot.objects[i]);
                    snapshot.objects[i] = objectInfo;
                    WireEnum.translateObject(objectInfo);
                    SyncPayload.unwrapObjectData(objectInfo);
                }
            }
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
