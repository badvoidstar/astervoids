/**
 * Pull-driven coordination for canonical records, game instances, and
 * optional presentation adapters.
 */
const ReplicationRuntime = (function () {
    const ROLES = new Set(['owned', 'replica', 'ignore']);
    const REMOVAL_REASONS = Object.freeze({
        DELETED: 'deleted',
        OWNERSHIP_GAINED: 'ownership-gained',
        ROLE_IGNORED: 'role-ignored',
        TYPE_MISSING: 'type-missing',
        SESSION_RESET: 'session-reset'
    });

    function requireFunction(value, name) {
        if (typeof value !== 'function') {
            throw new TypeError(`${name} must be a function`);
        }
        return value;
    }

    function normalizeDescriptor(descriptor) {
        if (!descriptor || typeof descriptor !== 'object') {
            throw new TypeError('descriptor must be an object');
        }
        if (typeof descriptor.type !== 'string' || descriptor.type.length === 0) {
            throw new TypeError('descriptor.type must be a non-empty string');
        }

        const classify = descriptor.classify || descriptor.getRole || descriptor.role;
        const normalized = {
            ...descriptor,
            classify: requireFunction(classify, `${descriptor.type}.classify`),
            getInstance: requireFunction(
                descriptor.getInstance, `${descriptor.type}.getInstance`),
            getInstances: requireFunction(
                descriptor.getInstances, `${descriptor.type}.getInstances`),
            createReplica: requireFunction(
                descriptor.createReplica, `${descriptor.type}.createReplica`),
            apply: requireFunction(descriptor.apply, `${descriptor.type}.apply`),
            remove: requireFunction(descriptor.remove, `${descriptor.type}.remove`)
        };

        for (const hook of [
            'adoptOwned',
            'onRoleChanged',
            'afterReconcile',
            'onSessionBegin',
            'onSessionReset'
        ]) {
            if (normalized[hook] !== undefined) {
                requireFunction(normalized[hook], `${descriptor.type}.${hook}`);
            }
        }
        if (normalized.presentation !== undefined) {
            const presentation = normalized.presentation;
            if (!presentation || typeof presentation !== 'object') {
                throw new TypeError(`${descriptor.type}.presentation must be an object`);
            }
            for (const operation of ['has', 'ingest', 'sample', 'remove', 'reset']) {
                requireFunction(
                    presentation[operation],
                    `${descriptor.type}.presentation.${operation}`);
            }
        }
        return normalized;
    }

    function createRuntime(options) {
        if (!options || typeof options !== 'object') {
            throw new TypeError('runtime options are required');
        }
        const store = options.store || options.objectStore;
        if (!store || typeof store !== 'object') {
            throw new TypeError('store is required');
        }
        const getObjectsByType = requireFunction(
            store.getObjectsByType, 'store.getObjectsByType').bind(store);
        const getObject = requireFunction(store.getObject, 'store.getObject').bind(store);
        if (store.getAllObjects !== undefined) {
            requireFunction(store.getAllObjects, 'store.getAllObjects');
        }
        const getCurrentMemberId = requireFunction(
            options.getCurrentMemberId, 'getCurrentMemberId');
        if (options.getActiveMemberIds !== undefined) {
            requireFunction(options.getActiveMemberIds, 'getActiveMemberIds');
        }
        const getActiveMemberIds = options.getActiveMemberIds || (() => []);

        const descriptors = new Map();
        const bindings = new Map();
        const consumedVersions = new Map();
        const joinSnapshotObjectIds = new Set();
        const ownershipTransitions = new Map();
        const retiredEpochs = new Set();
        let sessionEpoch;

        function registerType(descriptor) {
            const normalized = normalizeDescriptor(descriptor);
            if (descriptors.has(normalized.type)) {
                throw new Error(`replication type already registered: ${normalized.type}`);
            }
            descriptors.set(normalized.type, normalized);
            return api;
        }

        function epochFrom(value) {
            if (value && typeof value === 'object' && 'epoch' in value) {
                return value.epoch;
            }
            return undefined;
        }

        function isCurrentEpoch(value) {
            const epoch = epochFrom(value);
            return epoch === undefined || Object.is(epoch, sessionEpoch);
        }

        function activeMembers() {
            const value = getActiveMemberIds();
            return Object.freeze(Array.from(value || []));
        }

        function makeFacts(record, type, extra) {
            const activeMemberIds = activeMembers();
            const ownerMemberId = record?.ownerMemberId ?? null;
            return Object.freeze({
                epoch: sessionEpoch,
                sessionEpoch,
                objectId: record?.id ?? extra?.objectId,
                type,
                version: record?.version,
                ownerMemberId,
                currentMemberId: getCurrentMemberId() ?? null,
                activeMemberIds,
                ownerIsActive: ownerMemberId != null
                    && activeMemberIds.includes(ownerMemberId),
                joinSnapshot: extra?.joinSnapshot === true,
                preserveDirection: extra?.preserveDirection === true,
                ownershipMigrationPending:
                    extra?.ownershipMigrationPending === true
            });
        }

        function enumerateInstances(descriptor, context) {
            const collection = descriptor.getInstances(context);
            if (collection == null || typeof collection[Symbol.iterator] !== 'function') {
                throw new TypeError(
                    `${descriptor.type}.getInstances must return an iterable`);
            }
            const result = [];
            for (const entry of collection) {
                if (Array.isArray(entry) && entry.length >= 2) {
                    result.push([entry[0], entry[1]]);
                } else if (entry && typeof entry === 'object' && 'id' in entry) {
                    result.push([entry.id, entry.instance ?? entry]);
                } else {
                    throw new TypeError(
                        `${descriptor.type}.getInstances entries must identify an id`);
                }
            }
            return result;
        }

        function removePresentation(
            descriptor,
            id,
            reason,
            facts,
            record,
            context
        ) {
            if (descriptor.presentation?.has(id)) {
                descriptor.presentation.remove(
                    id, reason, facts, record, context);
            }
        }

        function forgetObject(id) {
            bindings.delete(id);
            consumedVersions.delete(id);
            joinSnapshotObjectIds.delete(id);
            ownershipTransitions.delete(id);
        }

        function removeBoundObject(id, reason, context, record) {
            const binding = bindings.get(id);
            const descriptor = binding && descriptors.get(binding.type);
            if (descriptor) {
                const instance = descriptor.getInstance(id, context);
                const facts = makeFacts(
                    record || getObject(id),
                    binding.type,
                    { objectId: id });
                removePresentation(
                    descriptor, id, reason, facts, record, context);
                if (instance != null) descriptor.remove(instance, reason, facts, context);
            }
            forgetObject(id);
            return !!binding;
        }

        function beginSession(session) {
            if (!session || typeof session !== 'object' || !('epoch' in session)) {
                throw new TypeError('beginSession requires an epoch');
            }
            if (retiredEpochs.has(session.epoch)) return false;
            if (sessionEpoch !== undefined && !Object.is(sessionEpoch, session.epoch)) {
                resetSession(sessionEpoch);
            }
            sessionEpoch = session.epoch;
            joinSnapshotObjectIds.clear();
            for (const id of session.snapshotObjectIds || []) {
                joinSnapshotObjectIds.add(id);
            }
            const facts = Object.freeze({
                epoch: sessionEpoch,
                snapshotObjectIds: Object.freeze(
                    Array.from(joinSnapshotObjectIds))
            });
            for (const descriptor of descriptors.values()) {
                descriptor.onSessionBegin?.(facts);
            }
            return true;
        }

        function handleDeletedObjectIds(ids, reason, context) {
            if (reason && typeof reason === 'object') {
                context = reason;
                reason = context.reason;
            }
            if (!isCurrentEpoch(context)) return 0;
            const removalReason = reason || REMOVAL_REASONS.DELETED;
            let removed = 0;
            for (const id of ids || []) {
                if (removeBoundObject(id, removalReason, context)) removed++;
                else forgetObject(id);
            }
            return removed;
        }

        function handleOwnershipMigrations(migrations, context) {
            if (!isCurrentEpoch(context)) return 0;
            let handled = 0;
            for (const migration of migrations || []) {
                if (!migration || migration.objectId == null) continue;
                const record = getObject(migration.objectId);
                const version = migration.newVersion
                    ?? migration.version
                    ?? record?.version;
                const consumedVersion = consumedVersions.get(migration.objectId);
                const canonicalIsNewer = typeof record?.version === 'number'
                    && typeof version === 'number'
                    && record.version > version;
                const consumedIsCurrentOrNewer =
                    consumedVersions.has(migration.objectId)
                    && (Object.is(consumedVersion, version)
                        || (typeof consumedVersion === 'number'
                            && typeof version === 'number'
                            && consumedVersion > version));
                const existing = ownershipTransitions.get(migration.objectId);
                if (canonicalIsNewer || consumedIsCurrentOrNewer
                    || (existing && Object.is(existing.version, version))) {
                    continue;
                }
                ownershipTransitions.set(migration.objectId, {
                    version,
                    pending: true
                });
                handled++;
            }
            return handled;
        }

        function classify(descriptor, record, facts, context) {
            const role = descriptor.classify(record, facts, context);
            if (!ROLES.has(role)) {
                throw new Error(
                    `${descriptor.type}.classify returned invalid role: ${String(role)}`);
            }
            return role;
        }

        function reconcileType(type, context) {
            if (!isCurrentEpoch(context)) {
                return Object.freeze({ stale: true, created: 0, applied: 0, removed: 0 });
            }
            const descriptor = descriptors.get(type);
            if (!descriptor) throw new Error(`unregistered replication type: ${type}`);

            const records = Array.from(getObjectsByType(type) || []);
            const retainedIds = new Set();
            let created = 0;
            let applied = 0;
            let removed = 0;

            for (const record of records) {
                if (!record || record.id == null) {
                    throw new TypeError(`${type} record must have an id`);
                }
                const id = record.id;
                retainedIds.add(id);
                let binding = bindings.get(id);
                if (binding && binding.type !== type) {
                    removeBoundObject(
                        id, REMOVAL_REASONS.TYPE_MISSING, context, record);
                    binding = undefined;
                    removed++;
                }

                let instance = descriptor.getInstance(id, context);
                const initialFacts = makeFacts(record, type);
                const role = classify(descriptor, record, initialFacts, context);

                if (role === 'ignore') {
                    removePresentation(
                        descriptor,
                        id,
                        REMOVAL_REASONS.ROLE_IGNORED,
                        initialFacts,
                        record,
                        context);
                    if (instance != null) {
                        descriptor.remove(
                            instance,
                            REMOVAL_REASONS.ROLE_IGNORED,
                            initialFacts,
                            context);
                        removed++;
                    }
                    forgetObject(id);
                    continue;
                }

                const previousRole = binding?.role;
                if (role === 'owned') {
                    const ownedFacts = makeFacts(record, type, {
                        joinSnapshot: joinSnapshotObjectIds.delete(id)
                    });
                    if (previousRole === 'replica') {
                        removePresentation(
                            descriptor,
                            id,
                            REMOVAL_REASONS.OWNERSHIP_GAINED,
                            ownedFacts,
                            record,
                            context);
                        if (descriptor.adoptOwned) {
                            instance = descriptor.adoptOwned(
                                record, instance, ownedFacts, context) ?? instance;
                        } else if (instance != null) {
                            descriptor.remove(
                                instance,
                                REMOVAL_REASONS.OWNERSHIP_GAINED,
                                ownedFacts,
                                context);
                            instance = descriptor.getInstance(id, context);
                            removed++;
                        }
                    } else if ((binding == null || instance == null)
                        && descriptor.adoptOwned) {
                        instance = descriptor.adoptOwned(
                            record, instance, ownedFacts, context) ?? instance;
                    }
                    bindings.set(id, { type, role, instance });
                    if (previousRole && previousRole !== role) {
                        descriptor.onRoleChanged?.(
                            instance, previousRole, role, ownedFacts, context);
                    }
                    ownershipTransitions.delete(id);
                    if (record.ownershipMigrationPending === true) {
                        record.ownershipMigrationPending = false;
                    }
                    continue;
                }

                const hadReplicaState = descriptor.presentation
                    ? descriptor.presentation.has(id)
                    : previousRole === 'replica' && instance != null;
                if (instance == null) {
                    instance = descriptor.createReplica(record, initialFacts, context);
                    if (instance == null) {
                        throw new Error(`${type}.createReplica did not return an instance`);
                    }
                    created++;
                }
                bindings.set(id, { type, role, instance });

                let transition = ownershipTransitions.get(id);
                if (!transition
                    && record.ownershipMigrationVersion != null
                    && record.ownershipMigrationVersion === record.version) {
                    transition = {
                        version: record.ownershipMigrationVersion,
                        pending: record.ownershipMigrationPending !== false
                    };
                    ownershipTransitions.set(id, transition);
                }
                const consumedVersion = consumedVersions.get(id);
                const equalVersion = consumedVersions.has(id)
                    && Object.is(consumedVersion, record.version);
                const ownershipVersion = transition
                    && Object.is(transition.version, record.version);
                const shouldIngest = !(equalVersion && hadReplicaState)
                    && !(ownershipVersion && hadReplicaState);
                let presentationFacts;

                if (shouldIngest) {
                    const joinSnapshot = joinSnapshotObjectIds.delete(id);
                    const preserveDirection = !!transition?.pending && !ownershipVersion;
                    const facts = makeFacts(record, type, {
                        joinSnapshot,
                        preserveDirection,
                        ownershipMigrationPending: !!transition?.pending
                    });
                    if (descriptor.presentation) {
                        descriptor.presentation.ingest(
                            id, record.data, facts, record, context);
                        presentationFacts = facts;
                    } else {
                        descriptor.apply(instance, record.data, facts, context);
                        applied++;
                    }
                    consumedVersions.set(id, record.version);
                    if (preserveDirection) {
                        transition.pending = false;
                        if (record.ownershipMigrationPending === true) {
                            record.ownershipMigrationPending = false;
                        }
                        ownershipTransitions.delete(id);
                    }
                } else if (!equalVersion) {
                    consumedVersions.set(id, record.version);
                }

                if (descriptor.presentation?.has(id)) {
                    const facts = presentationFacts || makeFacts(record, type, {
                        ownershipMigrationPending: !!transition?.pending
                    });
                    const sampled = descriptor.presentation.sample(
                        id, facts, record, context);
                    descriptor.apply(instance, sampled, facts, context);
                    applied++;
                }
                if (previousRole && previousRole !== role) {
                    descriptor.onRoleChanged?.(
                        instance, previousRole, role, initialFacts, context);
                }
            }

            for (const [id, instance] of enumerateInstances(descriptor, context)) {
                if (retainedIds.has(id)) continue;
                const record = getObject(id);
                const reason = record
                    ? REMOVAL_REASONS.TYPE_MISSING
                    : REMOVAL_REASONS.DELETED;
                const facts = makeFacts(record, type, { objectId: id });
                removePresentation(
                    descriptor, id, reason, facts, record, context);
                descriptor.remove(instance, reason, facts, context);
                forgetObject(id);
                removed++;
            }

            // Game code may remove a local instance before the canonical
            // record disappears (for example, local-first expiry).
            // Retire any remaining binding and presentation state even when
            // getInstances no longer has an entity to enumerate.
            for (const [id, binding] of Array.from(bindings)) {
                if (binding.type !== type || retainedIds.has(id)) continue;
                const record = getObject(id);
                const reason = record
                    ? REMOVAL_REASONS.TYPE_MISSING
                    : REMOVAL_REASONS.DELETED;
                removeBoundObject(id, reason, context, record);
                removed++;
            }

            const summary = Object.freeze({
                stale: false,
                type,
                records: records.length,
                created,
                applied,
                removed
            });
            descriptor.afterReconcile?.(summary, context);
            return summary;
        }

        function resetSession(epoch) {
            if (epoch !== undefined && !Object.is(epoch, sessionEpoch)) return false;
            const oldEpoch = sessionEpoch;
            const resetContext = Object.freeze({ epoch: oldEpoch });
            const seen = new Set();
            for (const [id, binding] of bindings) {
                const descriptor = descriptors.get(binding.type);
                if (!descriptor) continue;
                const facts = makeFacts(
                    getObject(id), binding.type, { objectId: id });
                removePresentation(
                    descriptor,
                    id,
                    REMOVAL_REASONS.SESSION_RESET,
                    facts,
                    getObject(id),
                    resetContext);
                const instance = descriptor.getInstance(id, resetContext);
                if (instance != null) {
                    descriptor.remove(
                        instance,
                        REMOVAL_REASONS.SESSION_RESET,
                        facts,
                        resetContext);
                    seen.add(`${binding.type}\0${String(id)}`);
                }
            }
            const resetPresentations = new Set();
            for (const descriptor of descriptors.values()) {
                for (const [id, instance] of enumerateInstances(
                    descriptor, resetContext)) {
                    if (seen.has(`${descriptor.type}\0${String(id)}`)) continue;
                    const facts = makeFacts(
                        getObject(id), descriptor.type, { objectId: id });
                    descriptor.remove(
                        instance,
                        REMOVAL_REASONS.SESSION_RESET,
                        facts,
                        resetContext);
                }
                if (descriptor.presentation
                    && !resetPresentations.has(descriptor.presentation)) {
                    descriptor.presentation.reset(
                        Object.freeze({ epoch: oldEpoch }),
                        resetContext);
                    resetPresentations.add(descriptor.presentation);
                }
                descriptor.onSessionReset?.(Object.freeze({ epoch: oldEpoch }));
            }
            bindings.clear();
            consumedVersions.clear();
            joinSnapshotObjectIds.clear();
            ownershipTransitions.clear();
            if (oldEpoch !== undefined) retiredEpochs.add(oldEpoch);
            sessionEpoch = undefined;
            return true;
        }

        function getBinding(id) {
            const binding = bindings.get(id);
            return binding
                ? Object.freeze({
                    objectId: id,
                    type: binding.type,
                    role: binding.role
                })
                : undefined;
        }

        function markVersionConsumed(id, version, context) {
            if (!isCurrentEpoch(context)) return false;
            consumedVersions.set(id, version);
            if (context?.consumeJoinSnapshot === true) {
                joinSnapshotObjectIds.delete(id);
            }
            return true;
        }

        function getSnapshot() {
            return Object.freeze({
                epoch: sessionEpoch,
                bindings: Object.freeze(
                    Array.from(bindings, ([objectId, binding]) => Object.freeze({
                        objectId,
                        type: binding.type,
                        role: binding.role
                    }))),
                consumedVersions: Object.freeze(Array.from(consumedVersions)),
                joinSnapshotObjectIds: Object.freeze(
                    Array.from(joinSnapshotObjectIds)),
                pendingOwnershipObjectIds: Object.freeze(
                    Array.from(ownershipTransitions)
                        .filter(([, value]) => value.pending)
                        .map(([id]) => id))
            });
        }

        const api = Object.freeze({
            registerType,
            beginSession,
            handleDeletedObjectIds,
            handleOwnershipMigrations,
            reconcileType,
            resetSession,
            getBinding,
            getConsumedVersion: id => consumedVersions.get(id),
            isOwnershipMigrationPending:
                id => ownershipTransitions.get(id)?.pending === true,
            markVersionConsumed,
            getSnapshot
        });

        for (const descriptor of options.descriptors || []) {
            registerType(descriptor);
        }
        return api;
    }

    return Object.freeze({
        createRuntime,
        RemovalReason: REMOVAL_REASONS
    });
})();

if (typeof window !== 'undefined') {
    window.ReplicationRuntime = ReplicationRuntime;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplicationRuntime;
}
