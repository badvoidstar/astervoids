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
[MessagePackObject]
public record ObjectInfo(
    [property: Key(0)] Guid Id,
    [property: Key(1)] Guid CreatorMemberId,
    [property: Key(2)] Guid OwnerMemberId,
    [property: Key(3)] ObjectScope Scope,
    [property: Key(4)] SyncPayload Data,
    [property: Key(5)] long Version);

[MessagePackObject]
public record ObjectUpdateInfo(
    [property: Key(0)] Guid Id,
    [property: Key(1)] SyncPayload Data,
    [property: Key(2)] long Version);

[MessagePackObject]
public record ObjectUpdateRequest(
    [property: Key(0)] Guid ObjectId,
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
public record UpdateObjectsResponse(
    [property: Key(0)] GuidLongPair[] Versions,
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
