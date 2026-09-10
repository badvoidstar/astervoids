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
        ("terminalY", "f64"), ("terminalAngle", "f64"));

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

    [Theory]
    [InlineData((byte)5, "06000000800060")]
    [InlineData((byte)6, "060000800060")]
    [InlineData((byte)7, "060000800060")]
    public void Fixture_CompactUpdate_PreservesOriginalMaskAndQuantization(byte id, string hex)
    {
        var fields = id == 5 ? ShipSchema().Fields
            : id == 6 ? AsteroidSchema().Fields : BulletSchema().Fields;
        var schema = new PositionalSchemaCodec.Schema(id, fields);
        var data = new Dictionary<string, object?> { ["x"] = 0.5, ["y"] = 0.25 };
        Hex(PositionalSchemaCodec.Encode(schema, data)).Should().Be(hex);
        var decoded = PositionalSchemaCodec.Decode(schema, Convert.FromHexString(hex));
        Hex(PositionalSchemaCodec.Encode(schema, decoded)).Should().Be(hex);
    }

    [Fact]
    public void Fixture_BulletTimingAndClaim_ProductionSchema()
    {
        var additions = Schema(3,
            ("sampleAt", "f64"), ("sampleTick", "u32"),
            ("bornAt", "f64"), ("shot", "bytes"),
            ("hitClaimId", "guid"), ("hitClaimAt", "f64"),
            ("hitX", "f64"), ("hitY", "f64"), ("hitAngle", "f64"),
            ("hitTargetVersion", "u32"), ("hitTargetOwnerId", "guid"));
        var schema = new PositionalSchemaCodec.Schema(3,
            BulletSchema().Fields.Concat(additions.Fields).ToArray());
        var id = Guid.Parse("11223344-5566-7788-99aa-bbccddeeff00");
        var data = new Dictionary<string, object?>
        {
            ["sampleAt"] = 1000.5, ["sampleTick"] = 24,
            ["bornAt"] = 980.0, ["shot"] = new byte[] { 0x90 },
            ["hitClaimId"] = id, ["hitClaimAt"] = 1040.25,
            ["hitX"] = 0.5, ["hitY"] = 0.75, ["hitAngle"] = 1.5,
            ["hitTargetVersion"] = 42, ["hitTargetOwnerId"] = id
        };
        // The current production JS schema pins this fixture independently in
        // production-wire-schemas.test.mjs, including the fourth presence byte.
        const string expected =
            "0000ff070000000000448f40180000000000000000a08e400100000090" +
            "443322116655887799aabbccddeeff000000000000419040000000000000e03f" +
            "000000000000e83f000000000000f83f2a000000443322116655887799aabbccddeeff00";
        Hex(PositionalSchemaCodec.Encode(schema, data)).Should().Be(expected);
        var decoded = PositionalSchemaCodec.Decode(schema, Convert.FromHexString(expected));
        decoded["sampleAt"].Should().Be(1000.5);
        decoded["hitTargetOwnerId"].Should().Be(id.ToString());
        decoded["shot"].Should().BeEquivalentTo(new byte[] { 0x90 });
        Hex(PositionalSchemaCodec.Encode(schema, decoded)).Should().Be(expected);
    }

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
            "fe0100" +
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

        Hex(bytes).Should().Be("102000" + "0000c03f" + "0000c03f");
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
            "0000f0" +
            "0000000000408f40" +
            "000000000000d03f" +
            "000000000000e83f" +
            "182d4454fb210940");
    }
}
