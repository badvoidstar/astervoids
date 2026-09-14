using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using MessagePack;

namespace AstervoidsWeb.Hubs;

// Session responses
[MessagePackObject]
public record CreateSessionResponse(
    [property: Key("sessionId")] Guid SessionId,
    [property: Key("sessionName")] string SessionName,
    [property: Key("memberId")] Guid MemberId,
    [property: Key("role")] MemberRole Role,
    [property: Key("reconnectToken")] string ReconnectToken,
    [property: Key("metadata")] Dictionary<string, object?> Metadata);

[MessagePackObject]
public record JoinSessionResponse(
    [property: Key("sessionId")] Guid SessionId,
    [property: Key("sessionName")] string SessionName,
    [property: Key("memberId")] Guid MemberId,
    [property: Key("role")] MemberRole Role,
    [property: Key("reconnectToken")] string ReconnectToken,
    [property: Key("members")] IEnumerable<MemberInfo> Members,
    [property: Key("objects")] IEnumerable<ObjectInfo> Objects,
    [property: Key("validAts")] GuidLongPair[] ValidAts,
    [property: Key("metadata")] Dictionary<string, object?> Metadata
);

[MessagePackObject]
public record ActiveSessionsResponse(
    [property: Key("sessions")] IEnumerable<SessionListItem> Sessions,
    [property: Key("maxSessions")] int MaxSessions,
    [property: Key("canCreateSession")] bool CanCreateSession);

[MessagePackObject]
public record SessionListItem(
    [property: Key("id")] Guid Id,
    [property: Key("name")] string Name,
    [property: Key("memberCount")] int MemberCount,
    [property: Key("maxMembers")] int MaxMembers,
    [property: Key("createdAt")] DateTime CreatedAt,
    /// <summary>
    /// Id of the region that owns this session. The client must connect to this
    /// region's <c>/sessionHub</c> to Join. Mirrors <c>SessionInfo.RegionId</c>.
    /// </summary>
    [property: Key("regionId")] string RegionId);

[MessagePackObject]
public record SessionStateSnapshot(
    [property: Key("members")] IEnumerable<MemberInfo> Members,
    [property: Key("objects")] IEnumerable<ObjectInfo> Objects,
    [property: Key("validAts")] GuidLongPair[] ValidAts,
    [property: Key("memberSequences")] GuidLongPair[] MemberSequences);

// Member info
[MessagePackObject]
public record MemberInfo(
    [property: Key("id")] Guid Id,
    [property: Key("role")] MemberRole Role,
    [property: Key("joinedAt")] DateTime JoinedAt);

[MessagePackObject]
public record MemberLeftInfo(
    [property: Key("memberId")] Guid MemberId,
    [property: Key("promotedMemberId")] Guid? PromotedMemberId,
    [property: Key("promotedRole")] MemberRole? PromotedRole,
    [property: Key("deletedObjectIds")] IEnumerable<Guid> DeletedObjectIds,
    [property: Key("migratedObjects")] IEnumerable<ObjectMigration> MigratedObjects
);

// Object info and operations
// ValidAt is no longer per-object on the wire. Live broadcasts (OnObjectCreated,
// OnObjectsUpdated, OnObjectReplaced) carry a single batch-level validAt trailing
// argument. Snapshot DTOs (JoinSessionResponse, SessionStateSnapshot) carry a
// parallel ValidAts array (GuidLongPair[]) so each pre-existing object keeps its
// own age. SessionObject.ValidAt remains the server-side storage.
//
// The per-object Data slot is a SyncPayload (byte SchemaId, byte[] Data).
// SchemaId=0 carries a generic MessagePack map; nonzero IDs select registered
// positional schemas. The server treats the encoded bytes as opaque outside
// the sync-layer encode/decode boundary.
/// <summary>
/// Full object state. Carries both identities: <see cref="Id"/> is the globally
/// unique GUID every other DTO and the game layer address objects by, and
/// <see cref="Handle"/> is the session-scoped integer the hot paths use instead
/// (see <see cref="ObjectUpdateRequest"/>). Every <c>ObjectInfo</c> a client
/// receives — create response, <c>OnObjectCreated</c>, replacement children, join
/// and reconciliation snapshots — teaches it one handle→id mapping, so no separate
/// mapping message is needed and a reconnect resync re-teaches the whole session.
/// </summary>
[MessagePackObject]
public record ObjectInfo(
    [property: Key(0)] Guid Id,
    [property: Key(1)] Guid CreatorMemberId,
    [property: Key(2)] Guid OwnerMemberId,
    [property: Key(3)] ObjectScope Scope,
    [property: Key(4)] SyncPayload Data,
    [property: Key(5)] long Version,
    [property: Key(6)] int Handle);

/// <summary>
/// One object's state in an <c>OnObjectsUpdated</c> broadcast, addressed by
/// session-scoped <see cref="Handle"/> rather than GUID. See
/// <see cref="ObjectUpdateRequest"/> for the sizing rationale; the saving applies
/// once per receiving member here, so it scales with session size.
/// </summary>
[MessagePackObject]
public record ObjectUpdateInfo(
    [property: Key(0)] int Handle,
    [property: Key(1)] SyncPayload Data,
    [property: Key(2)] long Version);

/// <summary>
/// One object's pending data in an <c>UpdateObjects</c> invocation.
///
/// <para>
/// <see cref="Handle"/> is the session-scoped integer allocated by
/// <see cref="Session.AllocateObjectHandle"/>, not the object's GUID. A binary GUID
/// costs 18 B (bin8 header + 16 payload bytes) on every entry of every flush; a
/// handle costs 1 B up to 127, 2 B up to 255 and 3 B up to 65535, so a typical
/// steady-state session pays 1–2 B. This is the only object-identity slot on the
/// uplink, which is the scarcest direction on cellular links.
/// </para>
///
/// <para>
/// Handles are unique within a session and never reused, so an update that arrives
/// after its target was deleted resolves to nothing rather than to another object.
/// Unknown handles are skipped exactly like unknown ids were, and are reported as
/// rejected (version 0) in the positional acknowledgement.
/// </para>
/// </summary>
[MessagePackObject]
public record ObjectUpdateRequest(
    [property: Key(0)] int Handle,
    [property: Key(1)] SyncPayload Data);

[MessagePackObject]
public record ObjectReplacedEvent(
    [property: Key(0)] Guid DeletedObjectId,
    [property: Key(1)] List<ObjectInfo> CreatedObjects);

// Operation responses
[MessagePackObject]
public record CreateObjectResponse(
    [property: Key(0)] ObjectInfo ObjectInfo,
    [property: Key(1)] long MemberSequence,
    [property: Key(2)] long ValidAt);

[MessagePackObject]
public record ReplaceObjectResponse(
    [property: Key(0)] List<ObjectInfo> CreatedObjects,
    [property: Key(1)] long MemberSequence,
    [property: Key(2)] long ValidAt);

/// <summary>
/// Wire envelope for the <c>UpdateObjects</c> acknowledgement.
///
/// <para>
/// <c>Versions</c> is positional: entry <c>i</c> is the server-assigned version
/// for request element <c>i</c>, or <c>0</c> when that update was not applied
/// (unknown handle, or not owned by the caller). <see cref="SessionObject"/>
/// versions start at 1 and only increment, so 0 is an unambiguous "rejected"
/// sentinel.
/// </para>
///
/// <para>
/// Positional correspondence removes the object identity from the acknowledgement
/// entirely — the caller already knows which object it sent at each index. Each
/// entry drops from a 24 B <c>GuidLongPair</c> to a 1–3 B integer. Measured
/// over the whole message that is a 71–83% reduction for batches of 3–20
/// objects; the message-level figure is below the per-entry saving because
/// <c>MemberSequence</c> and <c>ServerTimestamp</c> are fixed overhead.
/// </para>
/// </summary>
[MessagePackObject]
public record UpdateObjectsResponse(
    [property: Key(0)] long[] Versions,
    [property: Key(1)] long MemberSequence,
    [property: Key(2)] long ServerTimestamp);

[MessagePackObject]
public record DeleteObjectResponse(
    [property: Key(0)] bool Success,
    [property: Key(1)] long MemberSequence);

/// <summary>
/// Wire-level (Guid, long) pair encoded as a 2-element MessagePack fixarray
/// thanks to positional <c>[Key(int)]</c> attributes. Used in place of
/// <c>Dictionary&lt;string, long&gt;</c> on snapshot/update-response wire shapes
/// where keys are GUIDs:
/// <list type="bullet">
///   <item>Dict-of-string-keyed-GUIDs costs ~37 B per key (full 36-char string).</item>
///   <item>This pair costs ~24 B per entry (fixarray header 1 B + bin8(16) GUID 18 B + small int 5 B).</item>
///   <item>Saves ~13–19 B per entry.</item>
/// </list>
/// JS clients see each pair as a 2-element array <c>[guidString, long]</c> after
/// the existing <c>GuidUtils.transformBinaryGuids</c> walk converts the 16-byte
/// binary GUID to a string. The session-client adapter folds the array back into
/// an object/Map for ergonomic game-side access.
/// </summary>
// Generic per-object event channel. Server is a relay — payload is opaque
// to the server (game-encoded MessagePack bytes). EventKind is a small byte-id
// agreed between game peers (registered via ObjectSync.registerEventKind).
// Use for low-frequency state transitions that don't belong on the per-frame
// update path (score changes, one-shot impact reports, etc.).
[MessagePackObject]
public record ObjectEventInfo(
    [property: Key(0)] Guid ObjectId,
    [property: Key(1)] byte EventKind,
    [property: Key(2)] byte[]? Payload);

[MessagePackObject]
public record GuidLongPair(
    [property: Key(0)] Guid Id,
    [property: Key(1)] long Value);

/// <summary>
/// Wire envelope for per-object game data. The server is opaque
/// w.r.t. <c>Data</c>; <see cref="SchemaId"/> selects how clients (and the
/// hub-layer encoders/decoders) interpret the bytes:
///
/// <list type="bullet">
///   <item><b>0</b> = generic map form. Bytes are <c>MessagePackSerializer.Serialize&lt;Dictionary&lt;string, object?&gt;&gt;(...)</c>
///         using the standard contractless resolver. Lossless round-trip with
///         the JS msgpack codec at <c>wwwroot/js/msgpack-codec.js</c>.</item>
///   <item><b>1..N</b> = positional schemas (registered per session
///         in <c>metadata.schemas</c>). Bytes are a packed positional
///         representation; the server still treats them as opaque.</item>
/// </list>
///
/// Wire cost vs the prior shape (raw <c>Dictionary&lt;string, object?&gt;</c>):
/// <list type="bullet">
///   <item>+2 B per object (1 B SchemaId + 1 B bin8 length header on the byte[]).</item>
///   <item>Recouped many times over by typed positional schemas and quantization.</item>
/// </list>
///
/// Positional <c>[Key(int)]</c> attributes serialize this as a 2-element
/// MessagePack fixarray, the most compact wrapper we can produce
/// (<c>0x92 &lt;schemaId byte&gt; &lt;bin8 ...&gt;</c>).
/// </summary>
[MessagePackObject]
public record SyncPayload(
    [property: Key(0)] byte SchemaId,
    [property: Key(1)] byte[] Data);
