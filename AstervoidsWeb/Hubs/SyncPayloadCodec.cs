using AstervoidsWeb.Formatters;
using MessagePack;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// Hub-layer adapter between the server-internal
/// <see cref="Dictionary{TKey, TValue}"/> shape used by
/// <c>SessionObject.Data</c>, <c>ObjectUpdate</c>, and
/// <c>ReplacementObjectSpec</c>, and the wire-level
/// <see cref="SyncPayload"/> envelope used by <see cref="ObjectInfo"/>,
/// <see cref="ObjectUpdateInfo"/>, and <see cref="ObjectUpdateRequest"/>.
///
/// SchemaId=0 represents the dictionary as a MessagePack-serialized
/// <c>Dictionary&lt;string, object?&gt;</c>. The byte stream is wire-compatible
/// with the JS-side codec at <c>wwwroot/js/msgpack-codec.js</c>; both sides
/// can read either party's encoding (see
/// <c>SyncPayloadCrossWireFixturesTests</c> + <c>msgpack-codec-cross.test.mjs</c>).
///
/// SchemaId&gt;=1 is dispatched to <see cref="PositionalSchemaCodec"/> using
/// schemas the session registered via metadata.schemas (Phase 4 wireopt).
/// </summary>
public static class SyncPayloadCodec
{
    /// <summary>
    /// MessagePack options used for the SchemaId=0 inner-dict serialization.
    /// MUST stay in sync with <c>Program.cs</c>'s hub options so the bytes
    /// the wire carries are exactly the same as those JS encodes/decodes.
    /// </summary>
    public static readonly MessagePackSerializerOptions DictOptions =
        AstervoidsMessagePack.Options;

    /// <summary>
    /// Identifies the generic MessagePack dictionary payload format.
    /// </summary>
    public const byte DictionarySchemaId = 0;

    /// <summary>
    /// Wraps a server-internal data dict into the wire envelope. Returns a
    /// payload with SchemaId=0 and the dict serialized via the standard
    /// MessagePack options. Null/empty dicts produce an empty payload (Data is
    /// the canonical 1-byte empty fixmap, kept for round-trip symmetry).
    /// </summary>
    public static SyncPayload EncodeDict(Dictionary<string, object?>? data)
    {
        var bytes = MessagePackSerializer.Serialize(
            data ?? new Dictionary<string, object?>(0),
            DictOptions);
        return new SyncPayload(DictionarySchemaId, bytes);
    }

    /// <summary>
    /// Registry-aware re-encode used by
    /// <c>SessionHub.ToObjectInfo</c> on every broadcast path
    /// (OnObjectCreated, OnObjectReplaced, JoinSession snapshot).
    ///
    /// When <paramref name="schemaId"/> &gt;= 1 and the schema is registered for
    /// <paramref name="sessionId"/>, emits the compact positional encoding so
    /// the server preserves the wire-size win across the receive→store→re-
    /// broadcast round-trip. Without this, every CreateObject reply and every
    /// snapshot would collapse to dictionary MessagePack even when the sender had
    /// already paid the registration cost.
    ///
    /// SchemaId=0 selects the generic dictionary path. A positional schema must
    /// remain registered; missing registrations are errors, never a wire-format
    /// downgrade.
    /// </summary>
    public static SyncPayload EncodeDict(byte schemaId, Dictionary<string, object?>? data, SyncSchemaRegistry? registry, Guid sessionId)
    {
        if (schemaId == DictionarySchemaId)
            return EncodeDict(data);
        var schema = registry?.GetSchema(sessionId, schemaId);
        if (schema is null)
            throw new InvalidOperationException(
                $"No schema registered for SchemaId={schemaId}; cannot encode a positional payload.");
        var bytes = PositionalSchemaCodec.Encode(schema, data ?? new Dictionary<string, object?>(0));
        return new SyncPayload(schemaId, bytes);
    }

    /// <summary>
    /// Decodes a wire payload back to the server-internal data dict.
    /// Dictionary-only form: handles SchemaId=0 only and throws on others
    /// (caller forgot to pass a registry).
    /// </summary>
    public static Dictionary<string, object?> DecodeDict(SyncPayload payload)
    {
        if (payload is null) return new Dictionary<string, object?>(0);
        if (payload.SchemaId != DictionarySchemaId)
        {
            throw new NotSupportedException(
                $"SyncPayload SchemaId={payload.SchemaId} requires a SyncSchemaRegistry overload of DecodeDict. " +
                "Use DecodeDict(payload, sessionId, registry) for positional payloads.");
        }
        if (payload.Data is null || payload.Data.Length == 0)
        {
            return new Dictionary<string, object?>(0);
        }
        return MessagePackSerializer.Deserialize<Dictionary<string, object?>>(payload.Data, DictOptions)
               ?? throw new InvalidOperationException("Schema 0 payload must contain a dictionary.");
    }

    /// <summary>
    /// Decodes a wire payload using the per-session schema
    /// registry. SchemaId=0 selects the generic MessagePack dictionary path;
    /// SchemaId&gt;=1 is decoded positionally via
    /// <see cref="PositionalSchemaCodec.Decode"/> using the schema registered
    /// for <paramref name="sessionId"/>.
    ///
    /// Throws on an unknown positional schema id so peers using mismatched
    /// schemas surface loudly instead of silently corrupting state.
    /// </summary>
    public static Dictionary<string, object?> DecodeDict(SyncPayload payload, Guid sessionId, SyncSchemaRegistry registry)
    {
        if (payload is null) return new Dictionary<string, object?>(0);
        if (payload.SchemaId == DictionarySchemaId)
        {
            return DecodeDict(payload);
        }
        var schema = registry.GetSchema(sessionId, payload.SchemaId);
        if (schema is null)
        {
            throw new InvalidOperationException(
                $"Session {sessionId} has no schema registered for SchemaId={payload.SchemaId}. " +
                "Schemas must be registered at session-create time via metadata.schemas.");
        }
        return PositionalSchemaCodec.Decode(schema, payload.Data ?? Array.Empty<byte>());
    }
}
