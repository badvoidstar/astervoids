/**
 * Object Sync Module
 * Handles local object registry and synchronization with the session.
 *
 * ## Game-Agnostic Boundary
 *
 * This module (and its server counterpart `SessionHub` / `ObjectService`)
 * never inspects the contents of an object's `data` field. Asteroids,
 * ships, and bullets are not first-class concepts here — they live only
 * in the game adapter (`index.html`) which provides:
 *
 *   - `toSyncData()` / `toUpdateData()` per local game-object type
 *     (full snapshot vs per-frame deltas)
 *   - `fromSyncData(obj)` to apply incoming dicts to the right local
 *     game-object class
 *   - `WIREOPT_SCHEMAS` + a `setSchemaIdSelector(fn)` callback for
 *     positional/quantized wire encoding (Phases 4-5)
 *
 * To add a new game on top of this stack, you would:
 *   1. Define your game-object classes with `toSyncData/toUpdateData/
 *      fromSyncData` methods.
 *   2. Register positional schemas via `SchemaCodec.register(id, fields)`
 *      and pass them into `SessionClient.createSession({schemas: …})`.
 *   3. Implement a `selector(data, kind, ctx)` returning the schemaId
 *      for each (type, kind) pair (return 0 to keep the legacy MsgPack
 *      dict path).
 *   4. Register `ReplicationRuntime` type adapters for replica
 *      classification and create/apply/adopt/remove behavior.
 *   5. Wire it up: `ObjectSync.setSchemaIdSelector(selector)` after
 *      `ObjectSync.init()` and `SchemaCodec.replaceAll(schemas)`.
 *
 * The sync layer also exposes a generic event channel
 * (`registerEventKind / emitEvent / on('objectEvent:<name>', handler)`)
 * so games can move rare-change fields off the per-frame update path
 * without coupling them to the schema (Phase 2.1).
 *
 * ## Per-Member Event Sequencing
 *
 * Every broadcast from the backend carries (senderMemberId, memberSequence).
 * Each member has its own monotonic counter on the backend (Interlocked.Increment),
 * starting at 0 and incrementing for each event triggered by that member:
 * OnMemberJoined, OnObjectCreated, OnObjectsUpdated, OnObjectDeleted, OnObjectReplaced.
 *
 * OnMemberLeft is special: it uses the departing member's ID with hardcoded seq 0,
 * since the member is being removed and will never send again. Receivers already
 * track that member at seq >= 1, so 0 > lastSeq is false — no false gap.
 *
 * Each frontend tracks a memberSequences Map (memberId -> lastSeqReceived).
 * On each incoming event, trackMemberSequence() checks:
 *   - First event from a member (no baseline): initializes the entry, no gap possible.
 *   - Sequential (seq === lastSeq + 1): normal, updates the map.
 *   - Gap (seq > lastSeq + 1): event(s) lost, triggers reconciliation.
 *   - Old/duplicate (seq <= lastSeq): silently ignored.
 *
 * Gap detection is only performed for OTHER members' streams. The local member's
 * own sequence is tracked (to keep the map current) but gaps are not flagged,
 * because the sender can't miss their own events and the mixed delivery channels
 * (invoke response for updates vs broadcast for create/delete/replace) can race
 * at await microtask boundaries.
 *
 * This works because SignalR guarantees in-order delivery per connection, and all
 * events for a given member flow through that member's single connection. So the
 * backend's Interlocked.Increment producing 5, 6, 7 guarantees arrival in that
 * order at every receiver. The old global sequence had a race where concurrent
 * broadcasts from different members could arrive out of order — per-member
 * sequencing eliminates this entirely since each member's stream is independent.
 *
 * ## Self-Echo Elimination
 *
 * Three event types use OthersInGroup (sender does NOT receive broadcast echo):
 *   - UpdateObjects: sender gets versions, memberSequence, serverTimestamp from response
 *   - CreateObject: sender registers object from invoke response (response-first)
 *   - DeleteObject: sender removes object before invoking (local-first)
 * For all three, the sender's own memberSequence is tracked from the invoke response.
 *
 * OnObjectReplaced still uses Group (sender DOES receive echo) because replaceObject
 * is NOT local-first — the sender relies on the broadcast to mutate its object map
 * (delete parent + add children, which may have different owners).
 *
 * Because the sender's own events arrive through invoke responses (not broadcasts),
 * gap detection is skipped for the sender's own member stream. This avoids false
 * reconciliations from: (a) mixed delivery channels racing at await boundaries,
 * and (b) lost invoke responses leaving stale sequence values. A lost response is
 * self-correcting — the next successful response or reconciliation snapshot will
 * restore the correct sequence value.
 *
 * ## Reconciliation (Gap Recovery)
 *
 * When a gap is detected, triggerReconciliation() calls GetSessionState() which
 * returns a full object snapshot plus the current server-side memberSequences for
 * every member. The local memberSequences map is advanced monotonically from
 * this snapshot, fast-forwarding past the gap without undoing newer events.
 * Objects are synced:
 * missing objects added, stale objects updated, ghost objects removed. A
 * reconciling flag prevents concurrent reconciliations.
 */

const ObjectSync = (function() {
    const objectApplication = typeof AuthoritativeObject !== 'undefined'
        ? AuthoritativeObject
        : (typeof require === 'function'
            ? require('./authoritative-object.js')
            : null);
    if (!objectApplication) {
        throw new Error('authoritative-object.js must load before object-sync.js');
    }
    const _log = (...a) => window.ASTERVOIDS_DEBUG && console.log(...a);
    const _warn = (...a) => window.ASTERVOIDS_DEBUG && console.warn(...a);
    const _error = (...a) => window.ASTERVOIDS_DEBUG && console.error(...a);

    // ── Field name compression for network traffic ─────────────────────────
    // Maps readable field names to short wire names. Applied at the sync
    // boundary (compress before send, expand after receive) so all game
    // logic uses the full readable names internally.
    //
    // The map is empty by default (no compression). Games supply their own
    // field map via configure({ fieldMap: { ... } }) at startup. Unmapped
    // keys pass through unchanged, so compression is purely opt-in.
    let fieldMap = {};
    let reverseMap = {};

    function compressData(data) {
        if (!data) return data;
        const out = {};
        for (const key in data) {
            out[fieldMap[key] || key] = data[key];
        }
        return out;
    }

    function expandData(data) {
        if (!data) return data;
        const out = {};
        for (const key in data) {
            out[reverseMap[key] || key] = data[key];
        }
        return out;
    }

    // ── Phase 4 wireopt: positional schema selection ───────────────────────
    // The game registers a selector via setSchemaIdSelector(fn). It is called
    // for every outbound create/update/replace with (data, kind, ctx) where
    // kind is 'create' | 'update' | 'replace' and ctx is { objectId, object }
    // (object may be undefined if the local registry hasn't seen it yet).
    // Returning 0 (or null/undefined) keeps the legacy MessagePack dict path;
    // returning >=1 sends positionally via the locally-registered SchemaCodec
    // entry of that id.
    let schemaIdSelector = null;
    function setSchemaIdSelector(fn) {
        if (fn !== null && typeof fn !== 'function') {
            throw new Error('setSchemaIdSelector requires a function or null');
        }
        schemaIdSelector = fn;
    }
    function pickSchemaId(data, kind, ctx) {
        if (!schemaIdSelector) return 0;
        try {
            const id = schemaIdSelector(data, kind, ctx);
            return (typeof id === 'number' && id >= 1 && id <= 255) ? id : 0;
        } catch (err) {
            _warn('[ObjectSync] schemaIdSelector threw; falling back to schemaId=0', err);
            return 0;
        }
    }

    function prepareWirePayload(data, kind, ctx) {
        const schemaId = pickSchemaId(data, kind, ctx);
        return {
            data: schemaId === 0 ? compressData(data) : data,
            schemaId
        };
    }

    // Local object registry
    const objects = new Map();
    
    // Type index for faster lookups - maps type string to Set of object IDs
    const typeIndex = new Map();
    
    // Pending updates to be batched.
    // Map<objectId, data> so repeated updateObject() calls for the same object
    // coalesce in O(1) instead of scanning an array.
    const pendingUpdates = new Map();
    
    // Sender sequence counter (incremented per flush)
    let senderSequence = 0;
    
    // Per-member event sequence tracking for gap detection
    const memberSequences = new Map(); // memberId -> lastSeq
    let reconciling = null;
    let reconciliationCount = 0;
    let stateEpoch = 0;
    let stateRevision = 0;
    const objectRevisions = new Map();
    // External callers (e.g. attemptAutoRejoin) can suspend reconciliation during
    // windows where currentMember/currentSession are mid-transition. While suspended,
    // triggerReconciliation() is a silent no-op. Counter (not bool) so nested
    // suspend/resume calls compose correctly.
    let reconciliationSuspendCount = 0;

    // Tracks objects locally deleted but not yet acknowledged by the server.
    // Reconciliation skips these IDs in the "add missing object" pass — the server's
    // snapshot may still contain them (delete in flight), and re-adding them would
    // resurrect a ghost the user already destroyed. Cleared when DeleteObject's
    // invoke resolves. On success the server snapshot omits it; on failure,
    // removing this guard allows a later reconciliation to restore server truth.
    const pendingDeletes = new Set();
    
    // Track last server-confirmed data per object (from an update response or
    // authoritative snapshot) so rejected or re-queued states can be diffed
    // from an accepted baseline and one-shot producers can detect persistence.
    const lastSentData = new Map();
    let deltaEncodingEnabled = false;
    // Optional clock source for owner-operation validAt times. Provided via
    // configure({ clockSource: { nowMs(), initialized() } }). When set,
    // create/replace/event calls stamp their invocation time, while update
    // batches stamp flush time. A coalesced update's underlying simulation pose
    // can therefore predate validAt by its queue wait. The server clamps client
    // stamps and applies its per-object monotonic rules.
    let clockSource = null;
    
    // Delta-enabled flush opportunities between periodic forced-full payloads
    // for objects already pending in that batch. This counts flushes with
    // producer data, not render/simulation frames or all live objects.
    const FULL_SYNC_INTERVAL = 6000;
    
    // Approximate wall-clock flush settings, driven by one tick per render frame.
    let nominalFrameTime = 1 / 30;  // target send interval in seconds
    // Retained configured value; adaptive updates currently do not auto-reset to it.
    let baseNominalFrameTime = 1 / 30;
    let minFrameTime = 1 / 480;     // clamp to prevent extreme thresholds
    let frameCounter = 0;
    let sendThreshold = 2;          // recalculated each frame from actual frame time
    let adaptiveSendRate = false;    // dynamically adjust send rate based on RTT
    const ADAPTIVE_SEND_MIN = 1 / 20; // fastest send interval (20Hz) in seconds
    const ADAPTIVE_SEND_MAX = 1 / 1;  // slowest send interval (1Hz) in seconds

    // Callbacks
    const callbacks = {
        onObjectCreated: null,
        onObjectUpdated: null,
        onObjectDeleted: null,
        onObjectReplaced: null,
        onBatchReceived: null,
        onSyncError: null,
        onReconciliationFailed: null,
        onReconciliationComplete: null
    };
    
    /**
     * Configure sync timing and field compression parameters.
     * @param {object} config - { nominalFrameTime, minFrameTime, deltaEncoding, adaptiveSendRate, fieldMap }
     */
    function configure(config) {
        if (config.nominalFrameTime !== undefined) {
            nominalFrameTime = config.nominalFrameTime;
            baseNominalFrameTime = config.nominalFrameTime;
        }
        if (config.minFrameTime !== undefined) {
            minFrameTime = config.minFrameTime;
        }
        if (config.deltaEncoding !== undefined) {
            deltaEncodingEnabled = config.deltaEncoding;
        }
        if (config.adaptiveSendRate !== undefined) {
            adaptiveSendRate = config.adaptiveSendRate;
        }
        if (config.fieldMap !== undefined) {
            fieldMap = config.fieldMap;
            reverseMap = Object.fromEntries(
                Object.entries(fieldMap).map(([k, v]) => [v, k])
            );
        }
        if (config.clockSource !== undefined) {
            clockSource = config.clockSource;
        }
    }
    
    /**
     * Adapt send rate based on measured RTT.
     * Uses one RTT as the target interval, clamped to 50-1000ms (20-1Hz).
     * This controls flush opportunities, not whether game-layer gates have
     * queued data or whether an in-flight invoke permits a new batch.
     * @param {number} rttMs - Current round-trip time in milliseconds
     */
    function updateSendRate(rttMs) {
        if (!adaptiveSendRate) return;
        const rttSec = rttMs / 1000;
        nominalFrameTime = Math.max(ADAPTIVE_SEND_MIN, Math.min(ADAPTIVE_SEND_MAX, rttSec));
    }

    /**
     * Get the current effective send rate in Hz.
     */
    function getSendRate() {
        return Math.round(1 / nominalFrameTime);
    }

    /**
     * Server-time estimate of "right now" in the same axis as validAt.
     * Returns null when the NTP clock isn't bootstrapped — callers must
     * guard so adaptive-delay metrics aren't fed pre-init guesses.
     *
     * Captured INSIDE network event handlers so lag = arrival - validAt excludes
     * later game-loop polling. For update batches validAt is sampled at flush,
     * so lag covers post-flush transport/queueing and residual clock error, not
     * the age of state while it waited in pendingUpdates.
     */
    function getArrivalServerTimeMs() {
        return getClientValidAt();
    }

    function getClientValidAt() {
        if (!clockSource
            || typeof clockSource.initialized !== 'function'
            || !clockSource.initialized()
            || typeof clockSource.nowMs !== 'function') {
            return null;
        }
        const nowMs = clockSource.nowMs();
        return Number.isFinite(nowMs) ? Math.round(nowMs) : null;
    }
    
    /**
     * Add object to type index
     */
    function addToTypeIndex(obj) {
        const type = obj.data?.type;
        if (!type) return;
        
        if (!typeIndex.has(type)) {
            typeIndex.set(type, new Set());
        }
        typeIndex.get(type).add(obj.id);
    }
    
    /**
     * Remove object from type index
     */
    function removeFromTypeIndex(obj) {
        const type = obj.data?.type;
        if (!type) return;
        
        const typeSet = typeIndex.get(type);
        if (typeSet) {
            typeSet.delete(obj.id);
            if (typeSet.size === 0) {
                typeIndex.delete(type);
            }
        }
    }
    
    /**
     * Update type index when object data changes
     */
    function updateTypeIndex(obj, oldType, newType) {
        if (oldType === newType) return;
        
        // Remove from old type
        if (oldType) {
            const oldSet = typeIndex.get(oldType);
            if (oldSet) {
                oldSet.delete(obj.id);
                if (oldSet.size === 0) {
                    typeIndex.delete(oldType);
                }
            }
        }
        
        // Add to new type
        if (newType) {
            if (!typeIndex.has(newType)) {
                typeIndex.set(newType, new Set());
            }
            typeIndex.get(newType).add(obj.id);
        }
    }

    /**
     * Initialize the object sync module.
     */
    function init() {
        // Register for session client events
        SessionClient.on('onObjectCreated', handleRemoteObjectCreated);
        SessionClient.on('onObjectsUpdated', handleRemoteObjectsUpdated);
        SessionClient.on('onObjectDeleted', handleRemoteObjectDeleted);
        SessionClient.on('onObjectReplaced', handleRemoteObjectReplaced);
        SessionClient.on('onObjectEvent', dispatchRemoteObjectEvent);
        SessionClient.on('onSessionTransition', handleSessionTransition);
        SessionClient.on('onSessionJoined', handleSessionJoined);
        SessionClient.on('onSessionLeft', handleSessionLeft);

        // console.log('[ObjectSync] Initialized');
    }

    // ── Internal helpers ────────────────────────────────────────────────

    /**
     * Reset all sync state to initial values.
     */
    function resetState() {
        stateEpoch++;
        objects.clear();
        typeIndex.clear();
        lastSentData.clear();
        pendingUpdates.clear();
        objectRevisions.clear();
        stateRevision = 0;
        frameCounter = 0;
        fullSyncCounter = 0;
        senderSequence = 0;
        memberSequences.clear();
        pendingDeletes.clear();
        reconciling = null;
        reconciliationCount = 0;
        flushInProgress = null;
    }

    function captureAsyncContext() {
        return {
            stateEpoch,
            sessionEpoch: typeof SessionClient.getSessionEpoch === 'function'
                ? SessionClient.getSessionEpoch()
                : null
        };
    }

    function isAsyncContextCurrent(context) {
        if (stateEpoch !== context.stateEpoch) return false;
        return context.sessionEpoch === null
            || typeof SessionClient.getSessionEpoch !== 'function'
            || SessionClient.getSessionEpoch() === context.sessionEpoch;
    }

    function markObjectMutation(objectId) {
        objectRevisions.set(objectId, ++stateRevision);
    }

    /**
     * Suspend reconciliation. Calls compose (counter, not bool). While suspended,
     * triggerReconciliation() is a silent no-op. Used by attemptAutoRejoin to
     * prevent reconciliation from racing with a full rejoin in progress.
     */
    function suspendReconciliation() {
        reconciliationSuspendCount++;
    }

    function resumeReconciliation() {
        if (reconciliationSuspendCount > 0) reconciliationSuspendCount--;
    }

    /**
     * Build a local object representation from server ObjectInfo.
     */
    function toLocalObject(objectInfo) {
        return {
            id: objectInfo.id,
            creatorMemberId: objectInfo.creatorMemberId,
            ownerMemberId: objectInfo.ownerMemberId,
            scope: objectInfo.scope,
            data: objectInfo.data || {},
            version: objectInfo.version
        };
    }

    /**
     * Register an object from server ObjectInfo into the local object map and type index.
     */
    function registerObject(objectInfo) {
        const obj = toLocalObject(objectInfo);
        objects.set(obj.id, obj);
        addToTypeIndex(obj);
        markObjectMutation(obj.id);
        return obj;
    }

    /**
     * Remove an object from the local object map, type index, and delta tracking.
     * Returns the removed object, or null if not found.
     */
    function removeObjectLocal(objectId) {
        const obj = objects.get(objectId);
        if (obj) {
            removeFromTypeIndex(obj);
            objects.delete(objectId);
        }
        lastSentData.delete(objectId);
        markObjectMutation(objectId);
        return obj || null;
    }

    /**
     * Track the local member's own sequence from an invoke response.
     * Used by createObject, deleteObject, and flushUpdates which all
     * use OthersInGroup (no broadcast echo for own events).
     */
    function trackOwnMemberSequence(memberSequence) {
        if (!memberSequence || memberSequence <= 0) return;
        const myId = SessionClient.getCurrentMember()?.id;
        if (myId) {
            trackMemberSequence(myId, memberSequence);
        }
    }

    /**
     * Reset immediately when SessionClient starts a new session lifecycle epoch.
     * Live group events may arrive before JoinSession returns; resetting here lets
     * those events become the monotonic baseline for the eventual snapshot.
     */
    function handleSessionTransition() {
        resetState();
    }

    /**
     * Handle session joined - load existing objects.
     *
     * Version-aware: if an object already exists locally with a higher (or equal)
     * version than the snapshot, the snapshot value is ignored. This prevents the
     * snapshot from clobbering a live OnObjectsUpdated broadcast that arrived
     * between the hub's AddToGroupAsync and the snapshot delivery in the JoinSession
     * response. (See SessionHub.JoinSession ordering.)
     *
     * Per-object validAt timing is carried in the parallel `session.validAts`
     * dictionary (objectId → validAt ms) so each pre-existing object keeps its
     * own age — the live broadcast wire shape is per-batch, but a snapshot
     * legitimately mixes objects of different ages.
     */
    function handleSessionJoined(session, member) {
        // SessionClient installs these before snapshot decoding. Reapply here
        // defensively for direct integrations that inject joined sessions.
        try {
            const schemas = session && session.metadata && session.metadata.schemas;
            if (schemas && typeof window !== 'undefined' && window.SchemaCodec) {
                window.SchemaCodec.replaceAll(schemas);
                _log('[ObjectSync] Loaded', schemas.length, 'positional schemas from session metadata');
            }
        } catch (err) {
            _warn('[ObjectSync] Failed to apply session schemas:', err);
        }

        if (session.objects) {
            const validAts = session.validAts || {};
            for (const obj of session.objects) {
                obj.data = expandData(obj.data);
                const existing = objects.get(obj.id);
                if (existing && existing.version >= obj.version) {
                    // A live broadcast already populated this object at >= this
                    // version. Backfill only metadata/static fields that the live
                    // delta could not carry.
                    const va = validAts[obj.id];
                    const applied = objectApplication.backfill(existing, obj, {
                        includeData: true,
                        validAt: va
                    });
                    updateTypeIndex(existing, applied.oldType, applied.newType);
                    if (applied.changed) markObjectMutation(existing.id);
                    lastSentData.set(existing.id, { ...existing.data });
                    continue;
                }

                if (existing) {
                    const applied = objectApplication.applyFull(existing, obj, {
                        validAt: validAts[obj.id]
                    });
                    updateTypeIndex(existing, applied.oldType, applied.newType);
                    markObjectMutation(existing.id);
                    lastSentData.set(existing.id, { ...existing.data });
                    continue;
                }

                // A delete/migration event for an object that was absent locally
                // arrived after group membership but before JoinSession returned.
                if (objectRevisions.has(obj.id)) continue;

                const registered = registerObject(obj);
                const va = validAts[obj.id];
                if (registered && va !== undefined && va !== null) {
                    registered.validAt = va;
                }
                if (registered) {
                    lastSentData.set(registered.id, { ...registered.data });
                }
            }
        }

        // console.log('[ObjectSync] Loaded', objects.size, 'objects from session');
    }

    /**
     * Handle session left - clear objects.
     */
    function handleSessionLeft() {
        resetState();
        // console.log('[ObjectSync] Cleared all objects');
    }

    /**
     * Handle remote object created.
     *
     * @param {object} objectInfo - The object metadata (no validAt field; carried
     *   as the trailing argument).
     * @param {string} senderMemberId
     * @param {number} memberSequence
     * @param {number} validAt - Server-validated owner-operation server-time ms
     *   (NTP-aligned), clamped within ±2 s of hub-entry receive time and
     *   monotonically capped against the object's previous ValidAt. THE unified
     *   interpolation axis: snap[0] is keyed at validAt. Stored on `obj.validAt`;
     *   consumed by RemoteObjects.updateState.
     */
    function handleRemoteObjectCreated(objectInfo, senderMemberId, memberSequence, validAt) {
        trackMemberSequence(senderMemberId, memberSequence);
        objectInfo.data = expandData(objectInfo.data);

        // Capture wire-arrival metadata in the performance.now() domain.
        // Current game presentation keys legacy samples by validAt and normal
        // deterministic ingest at game-loop observation time; arrivalTime is
        // retained on the object for diagnostics/future explicit baselines.
        const arrivalTime = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        // Server-time twin used by legacy lag-based delay sizing. Capturing at
        // dispatch excludes later game-loop polling from that measurement.
        const arrivalServerTime = getArrivalServerTimeMs();

        // Strip any legacy spawnTimestamp field from the wire data. The
        // current model uses validAt as the single operation timestamp;
        // spawnTimestamp lingered on the field-compression map (`sp` → ...)
        // but is never set or consumed by current code paths. Defensive
        // delete in case an older client still sends it.
        if (objectInfo.data && objectInfo.data.spawnTimestamp !== undefined) {
            delete objectInfo.data.spawnTimestamp;
        }

        const existing = objects.get(objectInfo.id);
        if (existing) {
            // Keep existing data/version if already ahead from updates
            if (objectInfo.version > existing.version) {
                const applied = objectApplication.applyFull(existing, objectInfo, {
                    arrivalTime,
                    arrivalServerTime,
                    validAt
                });
                updateTypeIndex(existing, applied.oldType, applied.newType);
            } else {
                // Even when the existing object's version is ahead (because an
                // update arrived first via the fallback path), we still need to
                // backfill any STATIC fields that updates don't carry — most
                // importantly velocityX/Y, rotationSpeed, radius, seed, type.
                // Without this, remote-object extrapolation runs with velocity=0
                // and the asteroid appears frozen between snapshots, then jumps
                // each time a new update arrives. Only fill missing keys; never
                // overwrite a value the (newer) update already provided.
                const backfillSource = objectInfo.data ? objectInfo : {};
                const applied = objectApplication.backfill(existing, backfillSource, {
                    includeData: Boolean(objectInfo.data),
                    validAt
                });
                updateTypeIndex(existing, applied.oldType, applied.newType);
            }
            markObjectMutation(existing.id);
            return;
        }

        const obj = registerObject(objectInfo);
        // Retain wire-arrival metadata separately from the validAt timeline.
        obj.arrivalTime = arrivalTime;
        obj.arrivalServerTime = arrivalServerTime;
        // Stamp the unified server-time axis anchor. RemoteObjects.updateState
        // converts validAt → perf.now-domain via validAtToPerfNow so bracket
        // search remains monotonic while the snapshot key encodes the estimated
        // common server-time axis instead of packet arrival jitter.
        if (validAt !== undefined && validAt !== null) {
            obj.validAt = validAt;
        }

        if (callbacks.onObjectCreated) {
            callbacks.onObjectCreated(obj);
        }
    }

    /**
     * Handle a remote update batch (self echo is eliminated).
     * `validAt` is one server-validated owner FLUSH timestamp fanned out to all
     * updated objects. It gives legacy interpolation a common monotonic axis,
     * but does not recover when each coalesced pose was originally simulated.
     *
     * @param {number} serverTimestamp - Hub-entry ms (used for batch metrics)
     * @param {string} senderMemberId
     * @param {number} senderSeq
     * @param {number} memberSequence
     * @param {number} senderSendIntervalMs
     */
    function handleRemoteObjectsUpdated(updatedObjects, serverTimestamp, senderMemberId, senderSeq, memberSequence, senderSendIntervalMs, validAt) {
        trackMemberSequence(senderMemberId, memberSequence);

        // Capture wire-arrival metadata once per packet. Legacy presentation
        // uses validAt as its sample key; deterministic normal ingest currently
        // anchors when the game loop observes the version. arrivalTime remains
        // available as explicit metadata rather than being conflated with either.
        const arrivalTime = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        // Server-time twin of arrivalTime (see handleRemoteObjectCreated for rationale).
        const arrivalServerTime = getArrivalServerTimeMs();

        // Signal packet arrival (for adaptive delay and latency tracking)
        if (callbacks.onBatchReceived) {
            callbacks.onBatchReceived(serverTimestamp, null, senderSendIntervalMs, senderMemberId);
        }
        // Updates contain id, data, version (validAt is batch-level, applied below).
        for (const update of updatedObjects) {
            update.data = expandData(update.data);
            const existing = objects.get(update.id);
            if (existing) {
                // Only apply if version is newer
                if (update.version > existing.version) {
                    const applied = objectApplication.applyPatch(existing, update, {
                        arrivalTime,
                        arrivalServerTime,
                        validAt
                    });
                    updateTypeIndex(existing, applied.oldType, applied.newType);

                    markObjectMutation(existing.id);
                    if (callbacks.onObjectUpdated) {
                        callbacks.onObjectUpdated(existing);
                    }
                }
            } else {
                // Object not yet known — create with available data
                // (full metadata arrives via OnObjectCreated; this is a fallback)
                const obj = {
                    id: update.id,
                    creatorMemberId: null,
                    ownerMemberId: null,
                    scope: null,
                    data: update.data || {},
                    version: update.version,
                    arrivalTime: arrivalTime,
                    arrivalServerTime: arrivalServerTime,
                    validAt: (validAt !== undefined && validAt !== null) ? validAt : undefined
                };
                objects.set(obj.id, obj);
                addToTypeIndex(obj);
                markObjectMutation(obj.id);

                if (callbacks.onObjectCreated) {
                    callbacks.onObjectCreated(obj);
                }
            }
        }
    }

    /**
     * Handle remote object deleted.
     */
    function handleRemoteObjectDeleted(objectId, senderMemberId, memberSequence) {
        trackMemberSequence(senderMemberId, memberSequence);
        const obj = removeObjectLocal(objectId);
        if (obj && callbacks.onObjectDeleted) {
            callbacks.onObjectDeleted(obj);
        }
    }

    /**
     * Handle remote object replaced (atomic delete + create).
     *
     * `validAt` is one batch-level replacement-operation time (normally the
     * collision invocation) shared by every child. It is fanned out
     * via handleRemoteObjectCreated so each child's `obj.validAt` is set
     * consistently for the spawn-bridge / bracket-interpolation paths.
     *
     * @param {object} event - { deletedObjectId, createdObjects }
     * @param {string} senderMemberId
     * @param {number} memberSequence
     * @param {number} validAt - Server-validated replacement-operation time.
     */
    function handleRemoteObjectReplaced(event, senderMemberId, memberSequence, validAt) {
        trackMemberSequence(senderMemberId, memberSequence);
        // Delete the original object (no sequence tracking — already tracked above)
        handleRemoteObjectDeleted(event.deletedObjectId);

        // Create all replacement objects (no sequence tracking — already tracked above).
        // All children share the same server-validated replacement validAt.
        for (const objectInfo of event.createdObjects) {
            handleRemoteObjectCreated(objectInfo, undefined, undefined, validAt);
        }

        if (callbacks.onObjectReplaced) {
            callbacks.onObjectReplaced(event.deletedObjectId, event.createdObjects, validAt);
        }
    }

    /**
     * Track per-member event sequence and trigger reconciliation on gaps.
     *
     * Gap detection is only performed for OTHER members' streams. The local member's
     * own sequence is tracked (to keep the map current for reconciliation snapshots)
     * but gaps are NOT flagged, for two reasons:
     *
     * 1. Self-echo elimination: UpdateObjects, CreateObject, and DeleteObject all use
     *    OthersInGroup — the sender never receives broadcast echoes for these events.
     *    The sender's own memberSequence is instead tracked from invoke responses
     *    (flushUpdates, createObject, deleteObject). OnObjectReplaced still echoes.
     *
     * 2. Mixed delivery channels: even for OnObjectReplaced (which still uses Group),
     *    the broadcast callback (synchronous) can race with invoke response processing
     *    (await microtask), causing out-of-order sequence values for the sender's own
     *    stream. This would trigger false reconciliations.
     *
     * If a sender's invoke response is lost, their own sequence map entry will be stale.
     * This is harmless because: (a) gap detection is skipped, and (b) the next successful
     * response or reconciliation snapshot will correct it.
     *
     * @param {string} memberId - The member who triggered the event
     * @param {number} memberSequence - The member's monotonic sequence number
     */
    function trackMemberSequence(memberId, memberSequence) {
        if (memberId == null || memberSequence == null) return;
        
        const lastSeq = memberSequences.get(memberId);
        // Only detect gaps for other members' streams
        const myId = SessionClient.getCurrentMember()?.id;
        if (myId !== memberId && lastSeq !== undefined && memberSequence > lastSeq + 1) {
            _warn('[ObjectSync] Per-member sequence gap:', memberId, 'expected', lastSeq + 1, 'got', memberSequence);
            triggerReconciliation();
        }
        if (lastSeq === undefined || memberSequence > lastSeq) {
            memberSequences.set(memberId, memberSequence);
        }
    }

    // Public alias for external callers (member events tracked from index.html)
    function trackEventSequence(senderMemberId, memberSequence) {
        trackMemberSequence(senderMemberId, memberSequence);
    }

    /**
     * Trigger state reconciliation via GetSessionState.
     */
    async function triggerReconciliation() {
        if (reconciling !== null) return;
        if (reconciliationSuspendCount > 0) return;
        const context = captureAsyncContext();
        const revisionsAtStart = new Map(objectRevisions);
        const operation = { context };
        reconciling = operation;
        
        try {
            // console.log('[ObjectSync] Reconciling state...');
            const snapshot = await SessionClient.getSessionState();
            if (!isAsyncContextCurrent(context)) return;
            if (!snapshot) {
                // Server doesn't recognize this connection as a session member.
                // This happens when auto-reconnect restores the transport but the
                // server already processed the disconnect (member removed).
                // Signal the game to trigger a full rejoin.
                if (callbacks.onReconciliationFailed) {
                    callbacks.onReconciliationFailed();
                }
                return;
            }
            
            // A live event may have advanced a member after the server captured
            // this snapshot. Never move that baseline backward.
            if (snapshot.memberSequences) {
                for (const [memberId, seq] of Object.entries(snapshot.memberSequences)) {
                    const current = memberSequences.get(memberId);
                    if (current === undefined || seq > current) {
                        memberSequences.set(memberId, seq);
                    }
                }
            }
            
            // Build set of server-known object IDs
            const serverObjectIds = new Set();
            const validAts = snapshot.validAts || {};
            for (const obj of (snapshot.objects || [])) {
                serverObjectIds.add(obj.id);
                obj.data = expandData(obj.data);
                const snapValidAt = validAts[obj.id];
                
                const existing = objects.get(obj.id);
                if (existing) {
                    // Ownership and state share the object version. Applying either
                    // from an older snapshot could undo a live update/migration.
                    if (obj.version > existing.version) {
                        const applied = objectApplication.applyFull(existing, obj, {
                            validAt: snapValidAt
                        });
                        updateTypeIndex(existing, applied.oldType, applied.newType);
                        lastSentData.set(existing.id, { ...existing.data });
                        markObjectMutation(existing.id);
                        // Reconciliation snapshots now carry the same validated
                        // server-time validAt as live broadcasts (monotonically
                        // capped, ±2 s clamped). The interpolator pushes them
                        // onto the unified bracket-search axis at that anchor,
                        // so they no longer need a skip-one-cycle hack: they
                        // either ARE the latest known state (correct to render
                        // from) or are dominated by newer live snapshots in
                        // the ring buffer (no visual effect).
                    } else if (obj.version === existing.version) {
                        // Update-first fallback objects can lack static metadata.
                        // Filling nulls is monotonic and does not overwrite live data.
                        const applied = objectApplication.backfill(existing, obj, {
                            includeData: false,
                            validAt: snapValidAt
                        });
                        if (applied.changed) markObjectMutation(existing.id);
                    }
                } else if (pendingDeletes.has(obj.id)) {
                    // Locally deleted but server hasn't processed yet — do NOT
                    // resurrect. The server will broadcast OnObjectDeleted shortly.
                    continue;
                } else if (objectRevisions.get(obj.id) !== revisionsAtStart.get(obj.id)) {
                    // A live delete/replacement arrived after this snapshot request.
                    continue;
                } else {
                    // Add missing object
                    const localObj = registerObject(obj);
                    if (snapValidAt !== undefined && snapValidAt !== null) {
                        localObj.validAt = snapValidAt;
                    }
                    lastSentData.set(localObj.id, { ...localObj.data });
                    if (callbacks.onObjectCreated) {
                        callbacks.onObjectCreated(localObj);
                    }
                    if (!isAsyncContextCurrent(context)) return;
                }
            }
            
            // Remove ghost objects (locally present but not on server).
            // Skip pendingDeletes — they're already gone locally and are about
            // to be confirmed by the server.
            for (const [id, obj] of objects) {
                if (!serverObjectIds.has(id)
                    && !pendingDeletes.has(id)
                    && objectRevisions.get(id) === revisionsAtStart.get(id)) {
                    removeObjectLocal(id);
                    if (callbacks.onObjectDeleted) {
                        callbacks.onObjectDeleted(obj);
                    }
                    if (!isAsyncContextCurrent(context)) return;
                }
            }
            
            // console.log('[ObjectSync] Reconciliation complete, objects:', objects.size);
            reconciliationCount++;
            if (callbacks.onReconciliationComplete) {
                callbacks.onReconciliationComplete();
            }
        } catch (err) {
            if (!isAsyncContextCurrent(context)) return;
            _error('[ObjectSync] Reconciliation failed:', err);
            // Treat invoke errors the same as a null snapshot: the connection
            // is broken (e.g. stale WebSocket after mobile background) and the
            // server no longer recognizes us. Fire the failure callback so the
            // game can trigger a full rejoin instead of silently stalling.
            if (callbacks.onReconciliationFailed) {
                callbacks.onReconciliationFailed();
            }
        } finally {
            if (reconciling === operation) {
                reconciling = null;
            }
        }
    }

    /**
     * Create a new synchronized object.
     * Response-first: registers the object in the local map from the invoke response.
     * Unlike deleteObject (which is local-first, removing before invoking), createObject
     * cannot pre-register because it needs the server-assigned ID and version.
     * The backend broadcasts OnObjectCreated to OthersInGroup only — the sender does
     * NOT receive its own creation echo. This means the sender's memberSequence for
     * this event is tracked from the response, not the broadcast. If the response is
     * lost, the sender's sequence map will have a gap for their own member ID, but
     * gap detection is skipped for own streams (see trackMemberSequence), so this
     * won't trigger false reconciliation. The stale sequence value will be corrected
     * on the next successful response or reconciliation snapshot.
     * @param {object} data - Object data
     * @param {string} scope - 'Member' or 'Session' (default: 'Member')
     * @param {string} ownerMemberId - Optional owner override
     * @param {function} isStillNeeded - Optional callback checked after async creation;
     *   if it returns false, the server object is auto-deleted (handles race where
     *   the caller destroys the local representation during the server round-trip)
     */
    async function createObject(data = {}, scope = 'Member', ownerMemberId = null, isStillNeeded = null) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }
        const context = captureAsyncContext();

        try {
            // Stamp owner's NTP-aligned server-time estimate of NOW. Server
            // clamps to ±2s of its own UtcNow before forwarding as the
            // unified-axis validAt. Math.round is required (see replaceObject
            // for the float64-vs-int64 MessagePack contract details).
            const clientValidAt = getClientValidAt();
            const wire = prepareWirePayload(data, 'create');
            const response = await SessionClient.createObject(
                wire.data, scope, ownerMemberId, clientValidAt, wire.schemaId);
            if (!isAsyncContextCurrent(context)) return null;
            if (!response || !response.objectInfo) return null;

            const objectInfo = response.objectInfo;
            objectInfo.data = expandData(objectInfo.data);

            // Auto-cleanup: if caller's object was destroyed during async creation
            if (isStillNeeded && !isStillNeeded()) {
                if (!isAsyncContextCurrent(context)) return null;
                deleteObject(objectInfo.id); // fire-and-forget server cleanup
                return null;
            }

            // Response-first: register the object from the invoke response (no broadcast echo)
            const existing = objects.get(objectInfo.id);
            if (!existing) {
                const obj = registerObject(objectInfo);
                // Stamp the server-validated batch-level validAt from the response
                // so any path that consults obj.validAt (e.g. ownership migration
                // back to this client) sees the same anchor remote receivers see.
                if (response.validAt !== undefined && response.validAt !== null) {
                    obj.validAt = response.validAt;
                }

                if (callbacks.onObjectCreated) {
                    callbacks.onObjectCreated(obj);
                }
            }

            if (!isAsyncContextCurrent(context)) return null;
            // Track own member sequence from response (no broadcast echo to track it from)
            trackOwnMemberSequence(response.memberSequence);

            return objectInfo;
        } catch (err) {
            if (!isAsyncContextCurrent(context)) return null;
            _error('[ObjectSync] Create object failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('create', err);
            }
            throw err;
        }
    }

    /**
     * Atomically replace an object with new objects in a single broadcast.
     */
    async function replaceObject(deleteObjectId, replacements, scope = 'Session', ownerMemberId = null) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }
        const context = captureAsyncContext();

        try {
            const wireReplacements = replacements.map(replacement =>
                prepareWirePayload(replacement, 'replace'));
            const replacementData = wireReplacements.map(replacement => replacement.data);
            const replacementSchemaIds = wireReplacements.map(replacement => replacement.schemaId);
            // Stamp the owner's best server-time estimate at replacement invoke
            // (normally the collision path, after replacement data is built).
            // Server clamps to ±2s of its own UtcNow before forwarding as the
            // unified-axis validAt. If the clock isn't initialized yet, send
            // null and the server falls back to its hub-entry timestamp (less
            // accurate but still bounded by upload_time).
            //
            // Math.round is required: clockSource.nowMs() returns
            // Date.now() + offsetMs where offsetMs is a fractional EMA value
            // (e.g., 237.9). MessagePack-JS encodes a fractional Number as
            // float64; the server's long? deserializer rejects it with
            // "Type mismatch", causing the entire ReplaceObject invocation to
            // throw — leaving the asteroid undeletable. Rounding to an integer
            // forces MessagePack to encode as int64.
            const clientValidAt = getClientValidAt();
            const createdInfos = await SessionClient.replaceObject(
                deleteObjectId, replacementData, scope, ownerMemberId, clientValidAt, replacementSchemaIds);
            if (!isAsyncContextCurrent(context)) return null;
            // Objects will be added/removed via the onObjectReplaced event
            return createdInfos;
        } catch (err) {
            if (!isAsyncContextCurrent(context)) return null;
            _error('[ObjectSync] Replace object failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('replace', err);
            }
            throw err;
        }
    }

    /**
     * Update an object's data locally and queue for sync.
     */
    function updateObject(objectId, data, immediate = false) {
        const obj = objects.get(objectId);
        if (!obj) {
            _warn('[ObjectSync] Object not found:', objectId);
            return false;
        }

        // Track type changes for index update
        const oldType = obj.data?.type;
        
        // Update local data immediately
        Object.assign(obj.data, data);
        markObjectMutation(objectId);
        
        // Update type index if type changed
        if (data.type !== undefined) {
            updateTypeIndex(obj, oldType, data.type);
        }

        // Queue for batch sync: O(1) coalesce by objectId. Repeated producer
        // writes before a flush merge field-wise into one latest-state payload.
        const existingData = pendingUpdates.get(objectId);
        if (existingData) {
            Object.assign(existingData, data);
        } else {
            pendingUpdates.set(objectId, { ...data });
        }

        if (immediate) {
            // Best-effort immediate: flushUpdates will not overlap an in-flight
            // invoke. The merged pending state remains queued for a later tick.
            flushUpdates();
        }
        // Otherwise, tick() will flush when frame counter reaches threshold

        return true;
    }

    let fullSyncCounter = 0;
    let flushInProgress = null;

    /**
     * Called once per rendered frame to approximate nominal wall-clock cadence.
     * Recalculates a frame threshold from current frame time and attempts a
     * flush at that interval. Pending data may represent many simulation frames,
     * and an empty interval sends nothing.
     *
     * Backpressure: when flushInProgress the counter caps at sendThreshold
     * instead of resetting. This way the very next tick after the in-flight
     * invoke completes will trigger a flush, preventing the effective send
     * rate from gaining another full nominal wait when RTT is near or above the
     * target interval. SignalR invokes remain serialized by this layer.
     * @param {number} frameTimeSec - Elapsed time for this frame in seconds
     */
    function tick(frameTimeSec) {
        const clampedFrameTime = Math.max(frameTimeSec, minFrameTime);
        sendThreshold = Math.max(1, Math.round(nominalFrameTime / clampedFrameTime));
        if (frameCounter < sendThreshold) {
            frameCounter++;
        }
        if (frameCounter >= sendThreshold && flushInProgress === null) {
            frameCounter = 0;
            flushUpdates();
        }
    }

    /**
     * Compute delta between current data and last-sent data for an object.
     * Returns only the fields that changed, or null if nothing changed.
     * Note: 'type' is NOT included in deltas — it never changes after creation and
     * the backend preserves it in the stored object state. The broadcast to other
     * members forwards the client's delta data as-is, so receivers always
     * have 'type' from the original OnObjectCreated event.
     *
     * IMPORTANT: lastSentData is NOT updated here. It is only updated after the
     * server confirms the batch, so that rejected or failed deltas are re-included
     * in the next flush. See confirmSentData().
     */
    function computeDelta(objectId, data, forceFullSync) {
        const prev = lastSentData.get(objectId);
        if (!prev || forceFullSync) {
            return { ...data };
        }

        const delta = {};
        let hasChanges = false;
        for (const key in data) {
            if (!dataValueEquals(data[key], prev[key])) {
                delta[key] = data[key];
                hasChanges = true;
            }
        }

        if (!hasChanges) return null;

        return delta;
    }

    function dataValueEquals(left, right) {
        if (Object.is(left, right)) return true;
        if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)
            || left.length !== right.length) {
            return false;
        }
        for (let i = 0; i < left.length; i++) {
            if (left[i] !== right[i]) return false;
        }
        return true;
    }

    function snapshotDataValues(data) {
        const snapshot = { ...data };
        for (const key in snapshot) {
            if (snapshot[key] instanceof Uint8Array) {
                snapshot[key] = new Uint8Array(snapshot[key]);
            }
        }
        return snapshot;
    }

    /**
     * Confirm that outbound data was accepted by the server for the given object IDs.
     * Updates lastSentData only for confirmed objects so that rejected fields
     * are re-sent on the next flush.
     * @param {Map<string, object>} sentData - Map of objectId to data that was sent
     * @param {object} confirmedVersions - Server response versions map (objectId → version)
     */
    function confirmSentData(sentData, confirmedVersions) {
        for (const [objectId, delta] of sentData) {
            if (confirmedVersions[objectId] === undefined) continue;
            const prev = lastSentData.get(objectId);
            if (prev) {
                Object.assign(prev, delta);
            } else {
                lastSentData.set(objectId, { ...delta });
            }
        }
    }

    /**
     * Return whether every supplied field matches the most recently observed
     * server-confirmed value for the object. Byte arrays compare by content;
     * other values retain the normal shallow comparison semantics.
     */
    function isDataConfirmed(objectId, data) {
        const confirmed = lastSentData.get(objectId);
        if (!confirmed || !data || typeof data !== 'object') return false;
        return Object.entries(data).every(
            ([key, value]) => dataValueEquals(confirmed[key], value));
    }

    /**
     * Flush all pending updates to the server.
     * Guarded to prevent overlapping flushes.
     *
     * Confirmation tracking defers lastSentData updates until the server confirms the batch.
     * On partial success, only confirmed objects update their delta baseline.
     * On complete failure, no baselines are updated. Sent entries are not
     * automatically reinserted into pendingUpdates here; when a producer queues
     * the object again, its delta is recomputed from the older confirmed
     * baseline and therefore includes the unconfirmed fields.
     */
    async function flushUpdates() {
        if (pendingUpdates.size === 0) return;
        if (!SessionClient.isInSession()) return;
        if (flushInProgress !== null) return;
        const context = captureAsyncContext();

        let updates;
        // Track deltas sent per object for deferred confirmation
        const sentData = new Map();
        if (deltaEncodingEnabled) {
            const forceFullSync = (++fullSyncCounter >= FULL_SYNC_INTERVAL);
            if (forceFullSync) fullSyncCounter = 0;

            updates = [];
            for (const [objectId, data] of pendingUpdates) {
                const delta = computeDelta(objectId, data, forceFullSync);
                if (delta) {
                    updates.push({
                        objectId: objectId,
                        data: delta
                    });
                    sentData.set(objectId, snapshotDataValues(delta));
                }
            }
        } else {
            updates = [];
            for (const [objectId, data] of pendingUpdates) {
                updates.push({ objectId: objectId, data: data });
                sentData.set(objectId, snapshotDataValues(data));
            }
        }
        pendingUpdates.clear();

        if (updates.length === 0) return;

        const operation = { context };
        flushInProgress = operation;
        const currentSenderSequence = ++senderSequence;
        const clientTimestamp = Date.now();
        // Stamp the owner's NTP-aligned estimate at FLUSH time. Every object in
        // this batch shares the resulting validAt. Because pending updates are
        // coalesced without per-write timestamps, this is an ordering/presentation
        // anchor rather than an exact timestamp for each simulation pose.
        // Server clamps to ±2s and applies per-object monotonicity.
        // Math.round is required (see replaceObject for MessagePack int64 contract).
        const clientValidAt = getClientValidAt();
        // Compress field names for the wire — game logic stays readable.
        // Phase 4: each update carries its own schemaId so heterogeneous
        // batches (mix of asteroid update + ship full-sync, for example)
        // can use distinct positional schemas without splitting batches. The
        // selector receives ctx.objectId + ctx.object so it can route by type
        // even when the update payload itself omits `type`.
        //
        // Positional schemas (schemaId>=1) read field names directly from
        // the dict and have no name bytes on the wire — compression is
        // pointless AND silently zeroes fields whose name was remapped (e.g.
        // fieldMap angle→'a' would make schema lookup of dict.angle return
        // undefined, clearing its bitmask bit). Apply compression only on
        // the legacy SchemaId=0 MessagePack-dict path.
        const wireUpdates = updates.map(u => {
            const ctx = { objectId: u.objectId, object: objects.get(u.objectId) };
            const wire = prepareWirePayload(u.data, 'update', ctx);
            return {
                objectId: u.objectId,
                data: wire.data,
                schemaId: wire.schemaId
            };
        });
        if (!isAsyncContextCurrent(context)) {
            if (flushInProgress === operation) flushInProgress = null;
            return;
        }
        try {
            const response = await SessionClient.updateObjects(wireUpdates, currentSenderSequence, Math.round(nominalFrameTime * 1000), clientValidAt);
            if (!isAsyncContextCurrent(context)) return;
            // Capture response timestamp immediately — before processing
            // versions or sequences — so RTT reflects only the network
            // round-trip and not client-side processing overhead.
            const responseTimestamp = Date.now();
            if (response) {
                // Apply server-assigned versions to local objects
                if (response.versions) {
                    for (const [id, version] of Object.entries(response.versions)) {
                        const obj = objects.get(id);
                        if (obj && version > obj.version) {
                            obj.version = version;
                            markObjectMutation(id);
                        }
                    }
                    // Confirm delta baselines only for objects the server accepted
                    confirmSentData(sentData, response.versions);
                }
                // Track own member sequence from response
                trackOwnMemberSequence(response.memberSequence);
                // RTT from request/response round-trip (uses responseTimestamp
                // captured above to exclude local processing from the sample)
                if (response.serverTimestamp && callbacks.onBatchReceived) {
                    callbacks.onBatchReceived(response.serverTimestamp, clientTimestamp, undefined, undefined, responseTimestamp);
                }
            }
            // If response is null/undefined (server returned null), sent data is
            // NOT confirmed — all fields will be re-sent on next flush.
        } catch (err) {
            if (!isAsyncContextCurrent(context)) return;
            _error('[ObjectSync] Batch update failed:', err);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('update', err);
            }
        } finally {
            if (flushInProgress === operation) {
                flushInProgress = null;
            }
        }
    }

    /**
     * Delete an object.
     * Local-first: removes from local state immediately before sending to server.
     * The backend broadcasts OnObjectDeleted to OthersInGroup only — the sender does
     * NOT receive its own deletion echo. Same trade-off as createObject: sender's
     * memberSequence is tracked from the response. See createObject comment for
     * detailed rationale on lost-response recovery.
     *
     * Ownership safety: local-first deletion is safe because ownership only changes
     * via HandleMemberDeparture (member leaving). A member actively deleting objects
     * is not departing, so no concurrent ownership migration can occur. The hub
     * rejects the delete if ownership has changed, but the local Map would already
     * be stale until reconciliation. If voluntary ownership transfer is ever added,
     * this would need a local ownership check before removing, or deferred removal.
     */
    async function deleteObject(objectId) {
        if (!SessionClient.isInSession()) {
            throw new Error('Not in a session');
        }
        const context = captureAsyncContext();

        // Local-first: remove immediately so getObjectsByType() won't return it
        removeObjectLocal(objectId);
        // Track as pending so an interleaving reconciliation snapshot does not
        // resurrect this object before the server processes the delete.
        pendingDeletes.add(objectId);

        // Also remove from pending updates
        pendingUpdates.delete(objectId);

        try {
            const response = await SessionClient.deleteObject(objectId);
            if (!isAsyncContextCurrent(context)) return false;

            // Track own member sequence from response (no broadcast echo to track it from)
            if (response) {
                trackOwnMemberSequence(response.memberSequence);
            }

            return response?.success ?? false;
        } catch (err) {
            if (!isAsyncContextCurrent(context)) return false;
            _warn('[ObjectSync] Server delete failed (local deletion already applied):', objectId, err.message);
            if (callbacks.onSyncError) {
                callbacks.onSyncError('delete', err);
            }
            return false;
        } finally {
            // Whether the server accepted, rejected, or threw, the request has
            // resolved. Any subsequent snapshot reflects the post-resolution state,
            // so we no longer need to suppress this id from reconciliation.
            if (isAsyncContextCurrent(context)) {
                pendingDeletes.delete(objectId);
            }
        }
    }

    /**
     * Get an object by ID.
     */
    function getObject(objectId) {
        return objects.get(objectId);
    }

    /**
     * Get all objects.
     */
    function getAllObjects() {
        return Array.from(objects.values());
    }

    /**
     * Get objects by owner member ID.
     */
    function getObjectsByOwner(memberId) {
        return getAllObjects().filter(obj => obj.ownerMemberId === memberId);
    }

    /**
     * Get objects by type (from data.type field).
     * Uses type index for O(n) lookup where n = objects of that type, instead of all objects.
     * @param {string} type - The object type to filter by
     * @returns {array} Array of objects with matching type
     */
    function getObjectsByType(type) {
        const typeSet = typeIndex.get(type);
        if (!typeSet || typeSet.size === 0) return [];
        
        const result = [];
        for (const id of typeSet) {
            const obj = objects.get(id);
            if (obj) result.push(obj);
        }
        return result;
    }

    /**
     * Get a single object by type (for singletons like GameState).
     * Uses type index for efficient lookup.
     * @param {string} type - The object type to find
     * @returns {object|null} The first object with matching type, or null
     */
    function getObjectByType(type) {
        const typeSet = typeIndex.get(type);
        if (!typeSet || typeSet.size === 0) return null;
        
        // Get first ID from the set
        const firstId = typeSet.values().next().value;
        return objects.get(firstId) || null;
    }

    /**
     * Register a callback.
     */
    function on(event, callback) {
        if (event && event.indexOf('objectEvent:') === 0) {
            const kindName = event.substring('objectEvent:'.length);
            if (callback === null || callback === undefined) {
                eventHandlers.delete(kindName);
            } else {
                eventHandlers.set(kindName, callback);
            }
            return;
        }
        if (callbacks.hasOwnProperty(event)) {
            callbacks[event] = callback;
        } else {
            _warn('[ObjectSync] Unknown event:', event);
        }
    }

    // ── Per-object event channel (Phase 2.1) ─────────────────────────────
    // Game registers a byte ↔ name mapping for each event kind, plus a
    // handler per kind name. Owner-side emitEvent() invokes the handler locally
    // and synchronously before asking the server to broadcast. That gives
    // immediate local feedback, but a rejected/failed send can remain local-only;
    // callers needing durable gameplay state must use object mutations instead.
    // Remote events are transient, connection-ordered dispatches and are not
    // replayed to late joiners.
    const eventKindToName = new Map(); // byte -> kindName
    const eventNameToKind = new Map(); // kindName -> byte
    const eventHandlers = new Map();   // kindName -> handler(objectId, payload, ctx)

    /**
     * Register a byte ↔ name mapping for a per-object event kind. Both peers
     * must register the same mapping. Throws if kindByte or kindName is
     * already registered with a different counterpart.
     * @param {string} kindName - Game-defined name (e.g. 'ship-state-changed')
     * @param {number} kindByte - 0–255
     */
    function registerEventKind(kindName, kindByte) {
        if (typeof kindName !== 'string' || !kindName) {
            throw new Error('registerEventKind: kindName must be a non-empty string');
        }
        if (!Number.isInteger(kindByte) || kindByte < 0 || kindByte > 255) {
            throw new Error('registerEventKind: kindByte must be an integer in [0, 255]');
        }
        const existingName = eventKindToName.get(kindByte);
        const existingByte = eventNameToKind.get(kindName);
        if (existingName !== undefined && existingName !== kindName) {
            throw new Error(`registerEventKind: byte ${kindByte} already mapped to ${existingName}`);
        }
        if (existingByte !== undefined && existingByte !== kindByte) {
            throw new Error(`registerEventKind: name ${kindName} already mapped to byte ${existingByte}`);
        }
        eventKindToName.set(kindByte, kindName);
        eventNameToKind.set(kindName, kindByte);
    }

    /**
     * Ask the server to broadcast a transient per-object event, after running
     * the local handler synchronously. Returns true on send success. The server
     * enforces object ownership; local dispatch happens before that validation.
     * @param {string} objectId
     * @param {string} kindName - Must have been registered via registerEventKind
     * @param {object} payload - Game-defined dict
     */
    function emitEvent(objectId, kindName, payload) {
        const kindByte = eventNameToKind.get(kindName);
        if (kindByte === undefined) {
            _warn('[ObjectSync] emitEvent: unknown kind', kindName);
            return Promise.resolve(false);
        }

        // Run local handler synchronously for zero-wait owner feedback. Do not
        // treat this as proof that server validation/broadcast will succeed.
        const handler = eventHandlers.get(kindName);
        if (handler) {
            try {
                handler(objectId, payload, { local: true });
            } catch (e) {
                _warn('[ObjectSync] emitEvent local handler threw:', e);
            }
        }

        const validAt = getClientValidAt();
        const wirePayload = MsgpackCodec.encode(compressData(payload || {}));
        return SessionClient.broadcastObjectEvent(
            objectId, kindByte, wirePayload, validAt);
    }

    /**
     * Dispatch a received OnObjectEvent to its registered handler.
     * Wired into SessionClient by init().
     */
    function dispatchRemoteObjectEvent(eventInfo, senderMemberId, memberSequence, validAt) {
        if (!eventInfo) return;
        const kindName = eventKindToName.get(eventInfo.eventKind);
        if (!kindName) {
            _warn('[ObjectSync] OnObjectEvent: unknown kind byte', eventInfo.eventKind);
            return;
        }
        const handler = eventHandlers.get(kindName);
        if (!handler) return; // silently ignore — game may not subscribe to all kinds
        try {
            let payload = eventInfo.payload;
            if (payload instanceof Uint8Array) {
                payload = expandData(MsgpackCodec.decode(payload));
            } else {
                // Keep direct test/game injections ergonomic.
                payload = expandData(payload || {});
            }
            handler(eventInfo.objectId, payload, {
                local: false,
                senderMemberId,
                memberSequence,
                validAt
            });
        } catch (e) {
            _warn('[ObjectSync] OnObjectEvent payload/handler failed:', e);
        }
    }

    /**
     * Handle ownership migration for objects (called when a member leaves and objects are migrated).
     * Uses server-authoritative version to prevent drift from blind local increments.
     * Migration changes metadata/version only; presentation layers retain their
     * current motion state until a data-bearing update from the new owner.
     * @param {Array<{objectId: string, newOwnerId: string, newVersion: number}>} migratedObjects - Objects with their new owners and versions
     */
    function handleOwnershipMigration(migratedObjects) {
        for (const migration of migratedObjects) {
            const obj = objects.get(migration.objectId);
            if (!obj) {
                // We cannot materialize an object without its data, but recording
                // the event prevents an older in-flight snapshot from doing so.
                markObjectMutation(migration.objectId);
                continue;
            }
            if (migration.newVersion <= obj.version) continue;
            obj.ownerMemberId = migration.newOwnerId;
            obj.version = migration.newVersion;
            // Ownership migration advances the object version without changing
            // its data. Presentation layers must not re-anchor stale kinematics
            // as though this were a motion snapshot; the pending flag remains
            // set until the new owner's first real state update is ingested.
            obj.ownershipMigrationVersion = migration.newVersion;
            obj.ownershipMigrationPending = true;
            markObjectMutation(obj.id);
        }
    }

    /**
     * Handle member departure - remove deleted objects from local state.
     * @param {string[]} deletedObjectIds - IDs of objects that were deleted
     */
    function handleMemberDeparture(deletedObjectIds) {
        for (const objectId of deletedObjectIds) {
            const obj = removeObjectLocal(objectId);
            if (obj && callbacks.onObjectDeleted) {
                callbacks.onObjectDeleted(obj);
            }
        }
    }

    /**
     * Get object count.
     */
    function getObjectCount() {
        return objects.size;
    }

    /**
     * Get the reconciliation count for this session.
     */
    function getReconciliationCount() {
        return reconciliationCount;
    }

    /**
     * Clear all local objects (for testing).
     */
    function clear() {
        resetState();
    }

    // Public API
    return {
        init,
        createObject,
        replaceObject,
        updateObject,
        isDataConfirmed,
        deleteObject,
        flushUpdates,
        tick,
        getObject,
        getAllObjects,
        getObjectsByOwner,
        getObjectsByType,
        getObjectByType,
        getObjectCount,
        getReconciliationCount,
        configure,
        getSendRate,
        updateSendRate,
        triggerReconciliation,
        suspendReconciliation,
        resumeReconciliation,
        handleOwnershipMigration,
        handleMemberDeparture,
        trackEventSequence,
        isReconciling: () => reconciling !== null,
        on,
        registerEventKind,
        emitEvent,
        setSchemaIdSelector,
        clear
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ObjectSync;
}
