using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using AstervoidsWeb.Services;
using FluentAssertions;
using Xunit;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Phase 4E regression tests for the registry-aware re-encode path.
///
/// Pre-4E, <c>SessionHub.ToObjectInfo</c> always called the parameterless
/// <c>SyncPayloadCodec.EncodeDict(dict)</c> which collapsed every broadcast
/// payload to SchemaId=0 (legacy MessagePack), even when the sender had
/// already paid the cost of registering a positional schema. The wire-size
/// win from Phase 4D survived only on <c>OnObjectsUpdated</c> (which forwards
/// sender bytes verbatim); CreateObject responses, OnObjectReplaced, and
/// JoinSession snapshots all reverted to the bulkier MessagePack form.
///
/// Post-4E, the inbound payload's SchemaId rides on
/// <see cref="SessionObject.SchemaId"/> through storage. ToObjectInfo
/// re-encodes via the new
/// <see cref="SyncPayloadCodec.EncodeDict(byte, Dictionary{string, object?}?, SyncSchemaRegistry, Guid)"/>
/// overload which replays the positional encoding for SchemaId&gt;=1 and falls
/// back to legacy MessagePack for SchemaId=0 or when the schema isn't
/// registered (defensive fallback so a misconfigured session can't lose
/// state on broadcast).
/// </summary>
public class SyncPayloadCodecRegistryTests : TestBase
{
    private static PositionalSchemaCodec.Schema ShipSchema(byte id = 1) => new(
        id,
        new[]
        {
            new PositionalSchemaCodec.FieldSpec("type", "str"),
            new PositionalSchemaCodec.FieldSpec("x", "q16w"),
            new PositionalSchemaCodec.FieldSpec("y", "q16w"),
            new PositionalSchemaCodec.FieldSpec("angle", "q16_2pi"),
            new PositionalSchemaCodec.FieldSpec("velocityX", "q16s"),
            new PositionalSchemaCodec.FieldSpec("velocityY", "q16s"),
            new PositionalSchemaCodec.FieldSpec("rotationSpeed", "q16s"),
            new PositionalSchemaCodec.FieldSpec("thrusting", "bool"),
            new PositionalSchemaCodec.FieldSpec("invulnerable", "u16"),
            new PositionalSchemaCodec.FieldSpec("colorIndex", "u8"),
            new PositionalSchemaCodec.FieldSpec("memberId", "guid"),
            new PositionalSchemaCodec.FieldSpec("score", "u32"),
            new PositionalSchemaCodec.FieldSpec("hitCount", "u16"),
            new PositionalSchemaCodec.FieldSpec("thrustInput", "f32"),
            new PositionalSchemaCodec.FieldSpec("brakeInput", "q8"),
            new PositionalSchemaCodec.FieldSpec("turnControlMode", "u8"),
            new PositionalSchemaCodec.FieldSpec("turnTarget", "q16s"),
            new PositionalSchemaCodec.FieldSpec("turnTargetAngle", "q16_2pi"),
            new PositionalSchemaCodec.FieldSpec("turnMagnitude", "q8"),
            new PositionalSchemaCodec.FieldSpec("turnBias", "q16s"),
            new PositionalSchemaCodec.FieldSpec("terminalEpoch", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalX", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalY", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalAngle", "f64"),
        });

    private static Dictionary<string, object?> ShipCreateDict() => new()
    {
        ["type"] = "ship",
        ["x"] = 0.5,
        ["y"] = 0.25,
        ["angle"] = 0d,
        ["velocityX"] = 0d,
        ["velocityY"] = 0d,
        ["rotationSpeed"] = 0d,
        ["thrusting"] = false,
        ["invulnerable"] = 180,
        ["colorIndex"] = 1,
        ["memberId"] = "00112233-4455-6677-8899-aabbccddeeff",
        ["score"] = 0,
        ["hitCount"] = 0,
    };

    [Fact]
    public void EncodeDict_SchemaId0_AlwaysFallsBackToLegacyMessagePack()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        registry.SetSessionSchemas(sessionId, new[] { ShipSchema() });

        var payload = SyncPayloadCodec.EncodeDict(0, ShipCreateDict(), registry, sessionId);

        payload.SchemaId.Should().Be(SyncPayloadCodec.LegacyDictSchemaId);
        // Round-trip via legacy decoder must reproduce the dict.
        var decoded = SyncPayloadCodec.DecodeDict(payload);
        decoded["type"].Should().Be("ship");
        decoded["x"].Should().Be(0.5);
        decoded["y"].Should().Be(0.25);
    }

    [Fact]
    public void EncodeDict_RegisteredPositionalSchema_EmitsPositionalBytes()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        var schema = ShipSchema();
        registry.SetSessionSchemas(sessionId, new[] { schema });

        var payload = SyncPayloadCodec.EncodeDict(schema.Id, ShipCreateDict(), registry, sessionId);

        payload.SchemaId.Should().Be(schema.Id);
        // Positional must be byte-identical to a direct PositionalSchemaCodec.Encode call.
        var expected = PositionalSchemaCodec.Encode(schema, ShipCreateDict());
        payload.Data.Should().BeEquivalentTo(expected);
        // And materially smaller than the legacy fallback (~20-30 byte savings on this 3-field shape).
        var legacy = SyncPayloadCodec.EncodeDict(ShipCreateDict());
        payload.Data!.Length.Should().BeLessThan(legacy.Data!.Length,
            "positional encoding must be smaller than MessagePack for non-trivial dicts");
    }

    [Fact]
    public void EncodeDict_PositionalRoundTripsBitForBitViaDecode()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        var schema = ShipSchema();
        registry.SetSessionSchemas(sessionId, new[] { schema });

        var encoded = SyncPayloadCodec.EncodeDict(schema.Id, ShipCreateDict(), registry, sessionId);
        var decoded = SyncPayloadCodec.DecodeDict(encoded, sessionId, registry);

        decoded["type"].Should().Be("ship");
        Convert.ToDouble(decoded["x"]).Should().BeApproximately(0.5, 0.00002);
        Convert.ToDouble(decoded["y"]).Should().BeApproximately(0.25, 0.00002);
    }

    [Fact]
    public void EncodeDict_UnregisteredSchema_FallsBackToLegacyDictDefensively()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        // Note: no schemas registered for this session at all.

        var payload = SyncPayloadCodec.EncodeDict(42, ShipCreateDict(), registry, sessionId);

        // Falls back rather than throwing: receivers route on the envelope's
        // SchemaId, so a SchemaId=0 fallback is decodable by every peer.
        // Throwing here would crash the broadcast and risk leaking state.
        payload.SchemaId.Should().Be(SyncPayloadCodec.LegacyDictSchemaId);
        var decoded = SyncPayloadCodec.DecodeDict(payload);
        decoded.Should().ContainKey("type").WhoseValue.Should().Be("ship");
    }

    [Fact]
    public void EncodeDict_NullRegistry_FallsBackToLegacyDict()
    {
        // Defensive: ToObjectInfo callers shouldn't pass null but the overload
        // tolerates it so a partially-wired test or future call site doesn't
        // NRE inside a broadcast.
        var payload = SyncPayloadCodec.EncodeDict(1, ShipCreateDict(), null, Guid.NewGuid());

        payload.SchemaId.Should().Be(SyncPayloadCodec.LegacyDictSchemaId);
    }

    [Fact]
    public void ObjectService_CreateObject_PersistsInboundSchemaId()
    {
        // The plumbing test: SessionHub passes payload.SchemaId into the
        // service, which stamps it on the new SessionObject so ToObjectInfo
        // can replay it on every subsequent broadcast and snapshot.
        var (session, creator) = CreateTestSession();
        var data = ShipCreateDict();

        var obj = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Member, data,
            ownerMemberId: null, clientValidAt: null, serverReceiveTimeMs: null,
            schemaId: 1);

        obj.Should().NotBeNull();
        obj!.SchemaId.Should().Be(1);
    }

    [Fact]
    public void ObjectService_CreateObject_DefaultsSchemaIdToZero()
    {
        // Existing callers that don't pass schemaId keep the legacy
        // SchemaId=0 behavior. Backward-compat for every test in the suite
        // (and for any future caller that creates server-side objects).
        var (session, creator) = CreateTestSession();

        var obj = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Member, ShipCreateDict());

        obj.Should().NotBeNull();
        obj!.SchemaId.Should().Be(0);
    }

    [Fact]
    public void ObjectService_GenericSchemaZeroObjectSurvivesUpdateAndSnapshot()
    {
        var (session, creator) = CreateTestSession();
        var registry = new SyncSchemaRegistry();
        registry.SetSessionSchemas(session.Id, new[] { ShipSchema() });
        var obj = ObjectService.CreateObject(
            session.Id,
            creator.Id,
            ObjectScope.Session,
            new Dictionary<string, object?>
            {
                ["type"] = "generic-widget",
                ["nested"] = new Dictionary<string, object?>
                {
                    ["enabled"] = true,
                    ["values"] = new object?[] { 1, "two", null }
                },
                ["bytes"] = new byte[] { 0, 127, 128, 255 }
            },
            schemaId: SyncPayloadCodec.LegacyDictSchemaId)!;

        obj = ObjectService.UpdateObject(
            session.Id,
            obj.Id,
            new Dictionary<string, object?> { ["revision"] = 2 })!;
        var snapshot = SyncPayloadCodec.EncodeDict(
            obj.SchemaId, obj.Data, registry, session.Id);
        var decoded = SyncPayloadCodec.DecodeDict(snapshot);

        snapshot.SchemaId.Should().Be(SyncPayloadCodec.LegacyDictSchemaId);
        decoded["type"].Should().Be("generic-widget");
        Convert.ToInt64(decoded["revision"]).Should().Be(2);
        decoded["bytes"].Should().BeEquivalentTo(new byte[] { 0, 127, 128, 255 });
        decoded["nested"].Should().BeAssignableTo<Dictionary<object, object?>>();
    }

    [Fact]
    public void SchemaZeroAndPositionalPayloadsDecodeInOneMixedBatch()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        var schema = ShipSchema();
        registry.SetSessionSchemas(sessionId, new[] { schema });
        var payloads = new[]
        {
            SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
            {
                ["type"] = "generic-widget",
                ["value"] = 7
            }),
            SyncPayloadCodec.EncodeDict(schema.Id, ShipCreateDict(), registry, sessionId)
        };

        var decoded = payloads
            .Select(payload => SyncPayloadCodec.DecodeDict(payload, sessionId, registry))
            .ToArray();

        decoded[0]["type"].Should().Be("generic-widget");
        Convert.ToInt64(decoded[0]["value"]).Should().Be(7);
        decoded[1]["type"].Should().Be("ship");
    }

    [Fact]
    public void ObjectService_TerminalUpdateSurvivesShipSnapshotReencode()
    {
        var (session, creator) = CreateTestSession();
        var schema = ShipSchema();
        var registry = new SyncSchemaRegistry();
        registry.SetSessionSchemas(session.Id, new[] { schema });
        var obj = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Member, ShipCreateDict(),
            ownerMemberId: null, clientValidAt: null, serverReceiveTimeMs: null,
            schemaId: schema.Id)!;

        var terminalWirePayload = SyncPayloadCodec.EncodeDict(
            schema.Id,
            new Dictionary<string, object?>
            {
                ["terminalEpoch"] = 1000d,
                ["terminalX"] = 0.25d,
                ["terminalY"] = 0.75d,
                ["terminalAngle"] = Math.PI
            },
            registry,
            session.Id);
        var terminalUpdate = SyncPayloadCodec.DecodeDict(
            terminalWirePayload, session.Id, registry);
        obj = ObjectService.UpdateObject(session.Id, obj.Id, terminalUpdate)!;

        var snapshotPayload = SyncPayloadCodec.EncodeDict(
            obj.SchemaId, obj.Data, registry, session.Id);
        var decoded = SyncPayloadCodec.DecodeDict(
            snapshotPayload, session.Id, registry);
        decoded["terminalEpoch"].Should().Be(1000d);
        decoded["terminalX"].Should().Be(0.25d);
        decoded["terminalY"].Should().Be(0.75d);
        decoded["terminalAngle"].Should().Be(Math.PI);
    }

    [Fact]
    public void ReplacementObjectSpec_DefaultsSchemaIdToZero()
    {
        // Default constructor compatibility: pre-Phase-4E ReplaceObject call
        // sites that don't supply SchemaId continue to get the legacy path.
        var spec = new ReplacementObjectSpec(ObjectScope.Session, ShipCreateDict());
        spec.SchemaId.Should().Be(0);
    }

    [Fact]
    public void ObjectService_ReplaceObject_PropagatesPerSpecSchemaId()
    {
        // The full end-to-end of the split-children path: each replacement
        // spec carries its own SchemaId so heterogeneous children (e.g. one
        // ship-shaped, one asteroid-shaped) re-broadcast positionally for
        // the right kind.
        var (session, creator) = CreateTestSession();
        var parent = ObjectService.CreateObject(
            session.Id, creator.Id, ObjectScope.Session, ShipCreateDict())!;

        var specs = new[]
        {
            new ReplacementObjectSpec(ObjectScope.Session, ShipCreateDict(), null, SchemaId: 1),
            new ReplacementObjectSpec(ObjectScope.Session, ShipCreateDict(), null, SchemaId: 0),
        };

        var children = ObjectService.ReplaceObject(
            session.Id, parent.Id, creator.Id, specs);

        children.Should().NotBeNull();
        children!.Should().HaveCount(2);
        children[0].SchemaId.Should().Be(1);
        children[1].SchemaId.Should().Be(0);
    }
}
