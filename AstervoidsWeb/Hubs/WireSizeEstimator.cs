namespace AstervoidsWeb.Hubs;

/// <summary>
/// Arithmetic MessagePack size estimates for the hot-path DTOs.
///
/// <para>
/// <see cref="SessionHub"/> records per-member TX/RX byte counts for
/// <c>/api/srvmon</c>. Deriving those counts by actually serializing the
/// arguments duplicates the work the SignalR protocol is about to do anyway,
/// and allocates a throwaway buffer per call — on <c>UpdateObjects</c> that
/// happens twice per flush (once for the invocation, once for the broadcast),
/// on every flush, for every member.
/// </para>
///
/// <para>
/// The hot-path shapes are fully known at compile time, so their encoded size
/// can be computed from the already-encoded <see cref="SyncPayload.Data"/>
/// lengths plus fixed header arithmetic. Cold paths (create/join/leave) keep
/// the generic serialize-to-measure fallback in <see cref="SessionHub"/>:
/// they are rare, and their shapes are not worth modelling.
/// </para>
///
/// <para>
/// These are estimates for monitoring only. They model the MessagePack
/// encoding rules exactly for the shapes below, but nothing depends on them
/// being exact — they never affect wire bytes or game behaviour.
/// </para>
/// </summary>
internal static class WireSizeEstimator
{
    /// <summary>MessagePack nil is a single byte.</summary>
    internal const int NilBytes = 1;

    /// <summary>
    /// Encoded size of a signed integer under MessagePack's minimal-width
    /// integer encoding (the behaviour of <c>MessagePackWriter.Write(long)</c>).
    /// </summary>
    internal static int Int(long value)
    {
        if (value >= 0)
        {
            if (value <= sbyte.MaxValue) return 1;        // positive fixint
            if (value <= byte.MaxValue) return 2;         // uint8
            if (value <= ushort.MaxValue) return 3;       // uint16
            if (value <= uint.MaxValue) return 5;         // uint32
            return 9;                                     // uint64
        }
        if (value >= -32) return 1;                       // negative fixint
        if (value >= sbyte.MinValue) return 2;            // int8
        if (value >= short.MinValue) return 3;            // int16
        if (value >= int.MinValue) return 5;              // int32
        return 9;                                         // int64
    }

    /// <summary>Encoded size of a nullable integer, counting nil as one byte.</summary>
    internal static int Int(long? value) => value.HasValue ? Int(value.Value) : NilBytes;

    /// <summary>Encoded size of an array header for <paramref name="count"/> elements.</summary>
    internal static int ArrayHeader(int count)
    {
        if (count <= 15) return 1;                        // fixarray
        if (count <= ushort.MaxValue) return 3;           // array16
        return 5;                                         // array32
    }

    /// <summary>Encoded size of a binary header for <paramref name="length"/> bytes.</summary>
    internal static int BinHeader(int length)
    {
        if (length <= byte.MaxValue) return 2;            // bin8
        if (length <= ushort.MaxValue) return 3;          // bin16
        return 5;                                         // bin32
    }

    /// <summary>
    /// Encoded size of a <see cref="Guid"/> written by
    /// <c>BinaryGuidFormatter</c>: a 16-byte bin8 payload.
    /// </summary>
    internal const int GuidBytes = 2 + 16;

    /// <summary>
    /// Encoded size of a <see cref="SyncPayload"/>: a 2-element fixarray of
    /// <c>[schemaId, dataBytes]</c>.
    /// </summary>
    internal static int Payload(SyncPayload? payload)
    {
        if (payload == null) return NilBytes;
        var data = payload.Data;
        var dataLength = data?.Length ?? 0;
        return ArrayHeader(2)
            + Int(payload.SchemaId)
            + (data == null ? NilBytes : BinHeader(dataLength) + dataLength);
    }

    /// <summary>
    /// Encoded size of the <c>UpdateObjects</c> invocation arguments
    /// (client → server), excluding SignalR's own framing.
    /// </summary>
    internal static long UpdateObjectsRequest(
        IReadOnlyList<ObjectUpdateRequest> updates,
        long? senderSequence,
        long? senderSendIntervalMs,
        long? clientValidAt)
    {
        long total = ArrayHeader(updates.Count);
        for (int i = 0; i < updates.Count; i++)
        {
            var update = updates[i];
            total += ArrayHeader(2) + Int(update.Handle) + Payload(update.Data);
        }
        return total
            + Int(senderSequence)
            + Int(senderSendIntervalMs)
            + Int(clientValidAt);
    }

    /// <summary>
    /// Encoded size of the <c>OnObjectsUpdated</c> broadcast arguments
    /// (server → each receiving client), excluding SignalR's own framing.
    /// </summary>
    internal static long ObjectsUpdatedBroadcast(
        IReadOnlyList<ObjectUpdateInfo> updates,
        long? senderSequence,
        long memberSequence,
        long serverTimestamp,
        long? senderSendIntervalMs,
        long batchValidAt)
    {
        long total = ArrayHeader(updates.Count);
        for (int i = 0; i < updates.Count; i++)
        {
            var update = updates[i];
            total += ArrayHeader(3) + Int(update.Handle) + Payload(update.Data) + Int(update.Version);
        }
        return total
            + GuidBytes                     // senderMemberId
            + Int(senderSequence)
            + Int(memberSequence)
            + Int(serverTimestamp)
            + Int(senderSendIntervalMs)
            + Int(batchValidAt);
    }
}
