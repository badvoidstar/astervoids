using AstervoidsWeb.Models;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of object management.
///
/// Correctness guarantees
/// ──────────────────────
/// • All object mutations (create, update, delete, replace) execute under the session's
///   <c>Session.SyncRoot</c> lock, making version increments, ownership checks, and data
///   writes atomic.
/// • <c>SessionObject.Data</c> is replaced with a new dictionary on every mutation
///   (copy-on-write) so that snapshot reads outside the lock observe a stable copy.
/// • Batch update (<see cref="UpdateObjects"/>) skips objects not owned by the caller.
///   Each individual object mutation is still fully atomic.
/// • Member departure and object ownership migration are handled atomically inside
///   <see cref="SessionService.LeaveSession"/>, not here.
/// </summary>
public class ObjectService : IObjectService
{
    private readonly ISessionService _sessionService;

    public ObjectService(ISessionService sessionService)
    {
        _sessionService = sessionService;
    }

    /// <summary>
    /// Validates that a session exists. Returns the session if valid, or null if not found.
    /// </summary>
    private Session? GetValidSession(Guid sessionId)
        => _sessionService.GetSessionForSynchronization(sessionId);

    public SessionObject? CreateObject(Guid sessionId, Guid creatorMemberId, ObjectScope scope, Dictionary<string, object?>? data = null, Guid? ownerMemberId = null, long? clientValidAt = null, long? serverReceiveTimeMs = null, byte schemaId = 0)
    {
        if (!Enum.IsDefined(scope))
            return null;

        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;

            if (!session.Members.TryGetValue(creatorMemberId, out _))
                return null;

            var effectiveOwner = ownerMemberId ?? creatorMemberId;
            if (effectiveOwner != creatorMemberId && !session.Members.TryGetValue(effectiveOwner, out _))
                return null;

            var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var validAt = ValidAtPolicy.Resolve(clientValidAt, receive);
            var obj = NewSessionObject(session, creatorMemberId, effectiveOwner, scope, data, validAt, schemaId);
            session.AddObject(obj);
            return Snapshot(obj);
        }
    }

    /// <summary>
    /// Updates a single object owned by the caller. Ownership, membership, and
    /// lifecycle are checked atomically with the last-write-wins data merge.
    /// </summary>
    public SessionObject? UpdateObject(Guid sessionId, Guid objectId, Guid ownerMemberId, Dictionary<string, object?> data, long? clientValidAt = null, long? serverReceiveTimeMs = null)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;
            if (!session.Members.ContainsKey(ownerMemberId))
                return null;

            if (!session.Objects.TryGetValue(objectId, out var obj))
                return null;
            if (obj.OwnerMemberId != ownerMemberId)
                return null;

            var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var validAt = ValidAtPolicy.Resolve(clientValidAt, receive, obj.ValidAt);
            ApplyUpdate(obj, data, validAt);
            return Snapshot(obj);
        }
    }

    /// <summary>
    /// Batch-updates multiple objects owned by <paramref name="ownerMemberId"/>.
    ///
    /// Updates address their target by session-scoped <c>Handle</c> rather than by GUID —
    /// that is the identity the hot wire path carries. Unknown handles and objects not
    /// owned by the caller are silently skipped.  Successfully updated objects are
    /// returned in request order, including each repeated handle. Patches merge in
    /// that order (last write wins per field); no expected version is supplied or checked.
    /// The call-level timestamp goes through the ±2 s server-time sanity check,
    /// then is clamped against the newest previous timestamp in the accepted batch so
    /// every updated object shares one monotonic <c>ValidAt</c>.
    /// </summary>
    public IReadOnlyList<SessionObject> UpdateObjects(Guid sessionId, Guid ownerMemberId, IEnumerable<ObjectUpdate> updates, long? callLevelClientValidAt = null, long? serverReceiveTimeMs = null)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return [];

        var results = new List<SessionObject>();
        var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return results;
            if (!session.Members.ContainsKey(ownerMemberId))
                return results;

            var acceptedUpdates = new List<(SessionObject Object, ObjectUpdate Update)>();
            foreach (var update in updates)
            {
                if (!session.TryGetObjectByHandle(update.Handle, out var obj) || obj == null)
                    continue;

                // Ownership check inside the lock — not TOCTOU-prone
                if (obj.OwnerMemberId != ownerMemberId)
                    continue;

                acceptedUpdates.Add((obj, update));
            }

            if (acceptedUpdates.Count == 0)
                return results;

            var newestPreviousValidAt = acceptedUpdates.Max(item => item.Object.ValidAt);
            var batchValidAt = ValidAtPolicy.Resolve(
                callLevelClientValidAt, receive, newestPreviousValidAt);

            foreach (var (obj, update) in acceptedUpdates)
            {
                ApplyUpdate(obj, update.Data, batchValidAt);
                results.Add(Snapshot(obj));
            }
        }

        return results;
    }

    /// <summary>
    /// Deletes an object, enforcing that <paramref name="ownerMemberId"/> is the current
    /// owner.  The ownership check and deletion are atomic under <c>session.SyncRoot</c>.
    /// </summary>
    public SessionObject? DeleteObject(Guid sessionId, Guid objectId, Guid ownerMemberId)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;
            if (!session.Members.ContainsKey(ownerMemberId))
                return null;

            if (!session.Objects.TryGetValue(objectId, out var obj))
                return null;

            if (obj.OwnerMemberId != ownerMemberId)
                return null;

            return session.RemoveObject(objectId, out var removed) && removed != null
                ? Snapshot(removed)
                : null;
        }
    }

    /// <inheritdoc/>
    public IReadOnlyList<SessionObject>? ReplaceObject(
        Guid sessionId,
        Guid deleteObjectId,
        Guid ownerMemberId,
        IReadOnlyList<ReplacementObjectSpec> replacements,
        long? clientValidAt = null,
        long? serverReceiveTimeMs = null)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;
            if (!session.Members.ContainsKey(ownerMemberId))
                return null;

            // Verify ownership of the object being replaced — atomic with the delete below
            if (!session.Objects.TryGetValue(deleteObjectId, out var objToDelete))
                return null;
            if (objToDelete.OwnerMemberId != ownerMemberId)
                return null;

            // Validate every child before allocating handles, adding children, or
            // deleting the parent. Only an omitted owner defaults to the caller.
            foreach (var spec in replacements)
            {
                if (!Enum.IsDefined(spec.Scope)
                    || (spec.OwnerOverride is { } owner && !session.Members.ContainsKey(owner)))
                    return null;
            }

            // All replacement children share the SAME validated collision-time stamp so
            // observers see them spawn at exactly the parent's bracket-rendered position
            // at that moment. Monotonic cap is taken against the deleted parent's
            // ValidAt, not against the (not-yet-existing) children's previous values.
            var receive = serverReceiveTimeMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var validAt = ValidAtPolicy.Resolve(clientValidAt, receive, objToDelete.ValidAt);

            // Determine effective owner for replacements (must be a current member)
            var created = new List<SessionObject>(replacements.Count);
            foreach (var spec in replacements)
            {
                var effectiveOwner = spec.OwnerOverride ?? ownerMemberId;

                var obj = NewSessionObject(session, ownerMemberId, effectiveOwner, spec.Scope, spec.Data, validAt, spec.SchemaId);
                session.AddObject(obj);
                created.Add(obj);
            }

            // Delete the original — we already verified ownership above
            session.RemoveObject(deleteObjectId, out _);

            return created.Select(Snapshot).ToList();
        }
    }

    public IEnumerable<SessionObject> GetSessionObjects(Guid sessionId)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return Enumerable.Empty<SessionObject>();

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return Enumerable.Empty<SessionObject>();

            return session.Objects.Values.Select(Snapshot).ToList();
        }
    }

    public SessionObject? GetObject(Guid sessionId, Guid objectId)
    {
        var session = GetValidSession(sessionId);
        if (session == null)
            return null;

        lock (session.SyncRoot)
        {
            if (session.LifecycleState != SessionLifecycleState.Active)
                return null;

            return session.Objects.TryGetValue(objectId, out var obj)
                ? Snapshot(obj)
                : null;
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────────

    /// <summary>
    /// Applies a data merge (copy-on-write) + version bump to a single object,
    /// stamping the object's ValidAt with the validated server-time sample.
    /// Must be called while holding <c>session.SyncRoot</c>.
    /// </summary>
    private static void ApplyUpdate(SessionObject obj, Dictionary<string, object?> data, long validAt)
    {
        // Copy-on-write: create a new dictionary so readers outside the lock observe
        // a stable snapshot rather than a partially-written dictionary.
        var newData = SyncDataCloner.CloneDictionary(obj.Data);
        foreach (var kvp in data)
            newData[kvp.Key] = SyncDataCloner.CloneValue(kvp.Value);

        obj.Data = newData;
        obj.Version++;
        obj.UpdatedAt = DateTime.UtcNow;
        obj.ValidAt = validAt;
    }

    /// <summary>
    /// Constructs a fresh <see cref="SessionObject"/> with a freshly allocated session-scoped
    /// handle, defensively cloning <paramref name="data"/> so caller mutations after the call
    /// cannot corrupt the stored object. Caller is responsible for inserting it via
    /// <see cref="Session.AddObject"/>, which indexes the handle.
    /// </summary>
    private static SessionObject NewSessionObject(
        Session session,
        Guid creatorMemberId,
        Guid ownerMemberId,
        ObjectScope scope,
        Dictionary<string, object?>? data,
        long validAt,
        byte schemaId = 0)
        => new()
        {
            SessionId = session.Id,
            Handle = session.AllocateObjectHandle(),
            CreatorMemberId = creatorMemberId,
            OwnerMemberId = ownerMemberId,
            Scope = scope,
            Data = data != null
                ? SyncDataCloner.CloneDictionary(data)
                : new Dictionary<string, object?>(),
            ValidAt = validAt,
            SchemaId = schemaId
        };

    private static SessionObject Snapshot(SessionObject obj)
        => SyncDataCloner.CloneObject(obj);
}
