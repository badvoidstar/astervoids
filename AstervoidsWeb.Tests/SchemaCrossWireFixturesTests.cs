using AstervoidsWeb.Hubs;
using FluentAssertions;
using Xunit;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Phase 4 cross-wire fixture tests. These pin the C# encoder's exact byte
/// output for canonical schemas. The matching JS file
/// <c>AstervoidsWeb/schema-codec-cross.test.mjs</c> decodes the same hex
/// constants and asserts identical dicts. If either side is changed, both
/// sides will fail and the wire compatibility break is loud.
///
/// Hex literals chosen to match: little-endian for numerics; GUID layout
/// matches <see cref="System.Guid.TryWriteBytes(System.Span{byte})"/> /
/// <see cref="MessagePack.Resolvers.BinaryGuidResolver"/> ordering
/// (first 4 bytes LE, next 2 LE, next 2 LE, final 8 BE).
/// </summary>
public class SchemaCrossWireFixturesTests
{
    private static string Hex(byte[] bytes) =>
        Convert.ToHexString(bytes).ToLowerInvariant();

    private static PositionalSchemaCodec.Schema Schema(byte id, params (string name, string type)[] fields)
        => new(id, fields.Select(f => new PositionalSchemaCodec.FieldSpec(f.name, f.type)).ToArray());

    private static PositionalSchemaCodec.Schema ShipSchema() => Schema(1,
        ("type", "str"),
        ("x", "q16w"), ("y", "q16w"), ("angle", "q16_2pi"),
        ("velocityX", "f32"), ("velocityY", "f32"), ("rotationSpeed", "q16s"),
        ("thrusting", "bool"), ("invulnerable", "u16"),
        ("colorIndex", "u8"), ("memberId", "guid"),
        ("score", "u32"), ("hitCount", "u16"),
        ("thrustInput", "f32"), ("brakeInput", "q8"),
        ("turnControlMode", "u8"), ("turnTarget", "q16s"),
        ("turnTargetAngle", "q16_2pi"), ("turnMagnitude", "q8"), ("turnBias", "q16s"),
        ("terminalEpoch", "f64"), ("terminalX", "f64"),
        ("terminalY", "f64"), ("terminalAngle", "f64"),
        ("invulnerabilityRevision", "u32"), ("invulnerableAt", "f64"),
        ("participantId", "guid"), ("participantTag", "str"));

    private static PositionalSchemaCodec.Schema AsteroidSchema() => Schema(2,
        ("type", "str"),
        ("x", "q16w"), ("y", "q16w"), ("angle", "q16_2pi"), ("radius", "q16"),
        ("velocityX", "f32"), ("velocityY", "f32"), ("rotationSpeed", "f32"),
        ("seed", "f64"), ("vertices", "bytes"),
        ("terminalEpoch", "f64"), ("terminalX", "f64"),
        ("terminalY", "f64"), ("terminalAngle", "f64"));

    private static PositionalSchemaCodec.Schema BulletSchema() => Schema(3,
        ("type", "str"),
        ("x", "q16w"), ("y", "q16w"),
        ("velocityX", "q16s"), ("velocityY", "q16s"),
        ("lifetime", "u16"), ("colorIndex", "u8"), ("ownerMemberId", "guid"),
        ("pendingHit", "bool"), ("hitTargetId", "nullable-guid"),
        ("hitImpactTorque", "q16s"), ("hitBulletAngle", "q16_2pi"),
        ("hitOffsetN", "q16s"), ("terminalEpoch", "f64"),
        ("terminalX", "f64"), ("terminalY", "f64"));

    [Fact]
    public void Fixture_AsteroidUpdate_AllFields()
    {
        var schema = AsteroidSchema();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.25,
            ["angle"] = 1.5707963267948966 // pi/2
        });
        Hex(bytes).Should().Be("0e00" + "0080" + "0060" + "0040");
    }

    [Fact]
    public void Fixture_AsteroidUpdate_OnlyAngle()
    {
        var schema = AsteroidSchema();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["angle"] = 0.0
        });
        Hex(bytes).Should().Be("0800" + "0000");
    }

    [Fact]
    public void Fixture_ShipUpdate_MixedTypes()
    {
        var schema = ShipSchema();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["angle"] = 0.0,
            ["velocityX"] = 0.0,
            ["velocityY"] = 0.0,
            ["rotationSpeed"] = 0.0,
            ["thrusting"] = false,
            ["invulnerable"] = 120
        });
        Hex(bytes).Should().Be(
            "fe010000" +
            "0080" +
            "0080" +
            "00000000" +
            "00000000" +
            "0000" +
            "0000" +
            "00" +
            "7800");
    }

    [Fact]
    public void Fixture_ShipUpdate_ValuesBeyondUnitInterval()
    {
        var schema = ShipSchema();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["velocityX"] = 1.5,
            ["thrustInput"] = 1.5
        });

        Hex(bytes).Should().Be("10200000" + "0000c03f" + "0000c03f");
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        decoded["velocityX"].Should().Be(1.5);
        decoded["thrustInput"].Should().Be(1.5);
    }

    [Fact]
    public void Fixture_BulletUpdate_GuidField()
    {
        var schema = BulletSchema();
        var memberId = Guid.Parse("11223344-5566-7788-99aa-bbccddeeff00");
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["ownerMemberId"] = memberId
        });
        Hex(bytes).Should().Be(
            "8600" +
            "0080" +
            "0080" +
            "443322116655887799aabbccddeeff00");
    }

    [Fact]
    public void Fixture_StringField_Utf8Length()
    {
        var schema = Schema(7, ("name", "str"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["name"] = "ship"
        });
        Hex(bytes).Should().Be("01" + "0400" + "73686970");
    }

    [Fact]
    public void Fixture_NullableGuid_NullCase()
    {
        var schema = Schema(8, ("hitTargetId", "nullable-guid"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["hitTargetId"] = null
        });
        Hex(bytes).Should().Be("01" + "00");
    }

    [Fact]
    public void Fixture_BytesField_LengthIsLittleEndianU32()
    {
        var schema = Schema(9, ("vertices", "bytes"));
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["vertices"] = new byte[] { 0xde, 0xad, 0xbe, 0xef }
        });
        Hex(bytes).Should().Be("01" + "04000000" + "deadbeef");
    }

    [Fact]
    public void Fixture_ShipTerminalTarget_ExactF64Fields()
    {
        var schema = ShipSchema();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["terminalEpoch"] = 1000d,
            ["terminalX"] = 0.25d,
            ["terminalY"] = 0.75d,
            ["terminalAngle"] = Math.PI
        });
        Hex(bytes).Should().Be(
            "0000f000" +
            "0000000000408f40" +
            "000000000000d03f" +
            "000000000000e83f" +
            "182d4454fb210940");
    }

    [Fact]
    public void Fixture_ShipInvulnerability_TransitionAndCaptureTime()
    {
        var schema = ShipSchema();
        var bytes = PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?>
        {
            ["invulnerable"] = 180,
            ["invulnerabilityRevision"] = 7,
            ["invulnerableAt"] = 1000d
        });
        Hex(bytes).Should().Be(
            "00010003" + "b400" + "07000000" + "0000000000408f40");
        var decoded = PositionalSchemaCodec.Decode(schema, bytes);
        Convert.ToInt32(decoded["invulnerable"]).Should().Be(180);
        Convert.ToUInt32(decoded["invulnerabilityRevision"]).Should().Be(7);
        decoded["invulnerableAt"].Should().Be(1000d);
    }

    [Fact]
    public void Fixture_GameState_AllPriorSlotsRetainTheirPositions()
    {
        var data = new Dictionary<string, object?>
        {
            ["type"] = "gameState",
            ["gameStarted"] = true,
            ["wave"] = 7,
            ["state"] = "playing",
            ["lives"] = 3,
            ["groupScore"] = 37,
            ["speedMultiplier"] = 1d,
            ["waveDelayTimer"] = 0d,
            ["processedHits"] = Array.Empty<byte>(),
            ["processedScores"] = Array.Empty<byte>(),
            ["peakShipCount"] = 2,
            ["gameOverAt"] = 1000d,
            ["terminalAt"] = 1750d,
            ["scoreLifeAwardCount"] = 3,
            ["countedParticipants"] = Array.Empty<byte>(),
            ["terminalShipId"] = "00112233-4455-6677-8899-aabbccddeeff"
        };
        const string body =
            "090067616d655374617465" + "01" + "0700" +
            "0700706c6179696e67" + "0300" + "25000000" +
            "0000803f" + "00000000" +
            "00000000" + "00000000" + "02" +
            "0000000000408f40" + "0000000000589b40" +
            "03000000" + "00000000" +
            "33221100554477668899aabbccddeeff";

        GameStateSchemaFixture.Legacy.Fields.Should().HaveCount(16);
        GameStateSchemaFixture.Legacy.BitmaskBytes.Should().Be(2);
        GameStateSchemaFixture.Current.Fields.Should().HaveCount(19);
        GameStateSchemaFixture.Current.BitmaskBytes.Should().Be(3);
        GameStateSchemaFixture.Current.Fields[16].Should().Be(
            new PositionalSchemaCodec.FieldSpec("participantScores", "bytes"));
        GameStateSchemaFixture.Current.Fields[17].Should().Be(
            new PositionalSchemaCodec.FieldSpec("participantNumbers", "bytes"));

        Hex(PositionalSchemaCodec.Encode(GameStateSchemaFixture.Legacy, data))
            .Should().Be("ffff" + body);
        var encoded = PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current, data);
        Hex(encoded).Should().Be("ffff00" + body);
        var decoded = PositionalSchemaCodec.Decode(GameStateSchemaFixture.Current, encoded);
        decoded.Should().NotContainKey("participantScores").And.NotContainKey("participantNumbers");
        PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current, decoded).Should().Equal(encoded);

        data["participantScores"] = Convert.FromHexString(GameStateSchemaFixture.ScoreEntries);
        data["participantNumbers"] = Convert.FromHexString(GameStateSchemaFixture.NumberEntries);
        var allSlots = PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current, data);
        Hex(allSlots).Should().Be("ffff03" + body + "28000000" +
            GameStateSchemaFixture.ScoreEntries + "28000000" + GameStateSchemaFixture.NumberEntries);
        var allDecoded = PositionalSchemaCodec.Decode(GameStateSchemaFixture.Current, allSlots);
        allDecoded.Should().HaveCount(18);
        PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current, allDecoded).Should().Equal(allSlots);
    }

    [Fact]
    public void Fixture_GameState_EmptyDeltaStillRequiresThreePresenceBytes()
    {
        var encoded = PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current,
            new Dictionary<string, object?>());
        Hex(encoded).Should().Be("000000");
        PositionalSchemaCodec.Decode(GameStateSchemaFixture.Current, encoded).Should().BeEmpty();
        var truncated = () => PositionalSchemaCodec.Decode(
            GameStateSchemaFixture.Current, new byte[] { 0, 0 });
        truncated.Should().Throw<InvalidOperationException>().WithMessage("*truncated bitmask*");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Fixture_GameState_PersonalMapsAbsentOrNull_DoNotFabricateHistory(bool explicitNull)
    {
        var data = new Dictionary<string, object?> { ["groupScore"] = 100 };
        if (explicitNull)
        {
            data["participantScores"] = null;
            data["participantNumbers"] = null;
        }

        var encoded = PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current, data);
        Hex(encoded).Should().Be("200000" + "64000000");
        var decoded = PositionalSchemaCodec.Decode(GameStateSchemaFixture.Current, encoded);
        decoded.Should().ContainSingle();
        Convert.ToUInt32(decoded["groupScore"]).Should().Be(100);
        decoded.Should().NotContainKey("participantScores").And.NotContainKey("participantNumbers");
    }

    [Theory]
    [InlineData("participantScores", "00000100000000")]
    [InlineData("participantNumbers", "00000200000000")]
    [InlineData("participantTags", "00000400000000")]
    public void Fixture_GameState_PersonalMapSlots_AreIndependentlyOptional(string field, string hex)
    {
        var encoded = PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current,
            new Dictionary<string, object?> { [field] = Array.Empty<byte>() });

        Hex(encoded).Should().Be(hex);
        var decoded = PositionalSchemaCodec.Decode(GameStateSchemaFixture.Current, encoded);
        decoded.Should().ContainSingle().Which.Key.Should().Be(field);
        decoded[field].Should().BeOfType<byte[]>().Which.Should().BeEmpty();
        PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current, decoded).Should().Equal(encoded);
    }

    [Fact]
    public void Fixture_GameState_EmptyPersonalMaps_ArePresentAndDistinctFromMissingHistory()
    {
        var encoded = PositionalSchemaCodec.Encode(GameStateSchemaFixture.Current,
            new Dictionary<string, object?>
            {
                ["participantScores"] = Array.Empty<byte>(),
                ["participantNumbers"] = Array.Empty<byte>()
            });

        Hex(encoded).Should().Be("0000030000000000000000");
        encoded.Should().HaveCount(11);
        var decoded = PositionalSchemaCodec.Decode(GameStateSchemaFixture.Current, encoded);
        decoded.Should().HaveCount(2);
        decoded["participantScores"].Should().BeOfType<byte[]>().Which.Should().BeEmpty();
        decoded["participantNumbers"].Should().BeOfType<byte[]>().Which.Should().BeEmpty();
    }

    [Fact]
    public void Fixture_DurableParticipantIdentity_AppendsWithoutChangingPoseMasks()
    {
        var schema = ShipSchema();
        var data = new Dictionary<string, object?>
        {
            ["participantId"] = "00112233-4455-6677-8899-aabbccddeeff",
            ["participantTag"] = "Pilot_1"
        };
        var encoded = PositionalSchemaCodec.Encode(schema, data);
        Hex(encoded).Should().Be("0000000c" + "33221100554477668899aabbccddeeff" + "070050696c6f745f31");
        PositionalSchemaCodec.Decode(schema, encoded).Should().BeEquivalentTo(data);
        PositionalSchemaCodec.Encode(schema, new Dictionary<string, object?> { ["score"] = 1 })
            .Should().HaveCount(8);
    }

    [Fact]
    public void Fixture_ParticipantTags_AreOpaqueCompactBytes()
    {
        var schema = GameStateSchemaFixture.Current;
        var tags = Convert.FromHexString(GameStateSchemaFixture.TagEntries);
        var encoded = PositionalSchemaCodec.Encode(schema,
            new Dictionary<string, object?> { ["participantTags"] = tags });
        Hex(encoded).Should().Be("00000418000000" + GameStateSchemaFixture.TagEntries);
        PositionalSchemaCodec.Decode(schema, encoded)["participantTags"]
            .Should().BeOfType<byte[]>().Which.Should().Equal(tags);
    }

    [Fact]
    public void Fixture_GameState_PersonalMaps_ZeroAndNonzeroEntriesSurviveSnapshotReencoding()
    {
        var registry = new SyncSchemaRegistry();
        var sessionId = Guid.NewGuid();
        registry.SetSessionSchemas(sessionId, [GameStateSchemaFixture.Current]);
        var data = new Dictionary<string, object?>
        {
            ["participantScores"] = Convert.FromHexString(GameStateSchemaFixture.ScoreEntries),
            ["participantNumbers"] = Convert.FromHexString(GameStateSchemaFixture.NumberEntries)
        };

        var encoded = SyncPayloadCodec.EncodeDict(4, data, registry, sessionId);
        encoded.SchemaId.Should().Be(4);
        Hex(encoded.Data).Should().Be(GameStateSchemaFixture.PersonalMapsHex);
        encoded.Data.Should().HaveCount(91);

        var decoded = SyncPayloadCodec.DecodeDict(
            new SyncPayload(4, Convert.FromHexString(GameStateSchemaFixture.PersonalMapsHex)),
            sessionId, registry);
        decoded.Should().HaveCount(2);
        decoded["participantScores"].Should().BeOfType<byte[]>().Which.Should().Equal(
            Convert.FromHexString(GameStateSchemaFixture.ScoreEntries));
        decoded["participantNumbers"].Should().BeOfType<byte[]>().Which.Should().Equal(
            Convert.FromHexString(GameStateSchemaFixture.NumberEntries));
        SyncPayloadCodec.EncodeDict(4, decoded, registry, sessionId).Data.Should().Equal(encoded.Data);
    }

    [Fact]
    public void Fixture_GameState_CreatorSessionRegistryKeepsLegacyAndCurrentLayoutsSeparate()
    {
        const string legacyHex =
            "1098" + "0000" + "0000000000408f40" + "0000000000589b40" +
            "33221100554477668899aabbccddeeff";
        var registry = new SyncSchemaRegistry();
        var legacySessionId = Guid.NewGuid();
        var currentSessionId = Guid.NewGuid();
        registry.SetSessionSchemas(legacySessionId, [GameStateSchemaFixture.Legacy]);
        registry.SetSessionSchemas(currentSessionId, [GameStateSchemaFixture.Current]);

        var decoded = SyncPayloadCodec.DecodeDict(
            new SyncPayload(4, Convert.FromHexString(legacyHex)), legacySessionId, registry);
        Convert.ToInt32(decoded["lives"]).Should().Be(0);
        decoded["gameOverAt"].Should().Be(1000d);
        decoded["terminalAt"].Should().Be(1750d);
        decoded["terminalShipId"].Should().Be("00112233-4455-6677-8899-aabbccddeeff");
        decoded.Should().NotContainKey("participantScores").And.NotContainKey("participantNumbers");
        Hex(SyncPayloadCodec.EncodeDict(4, decoded, registry, legacySessionId).Data)
            .Should().Be(legacyHex);
        Hex(SyncPayloadCodec.EncodeDict(4, decoded, registry, currentSessionId).Data)
            .Should().Be("109800" + legacyHex[4..]);
        registry.GetSchema(legacySessionId, 4).Should().BeSameAs(GameStateSchemaFixture.Legacy);
    }
}
