using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using FluentAssertions;
using MessagePack;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Wire-size baseline tests for the wireopt roadmap. Locks in current MessagePack
/// byte counts for representative payloads so subsequent phases can measure their
/// savings (and so any phase that regresses byte counts fails CI).
///
/// IMPORTANT: when a wireopt phase intentionally shrinks a payload, update the
/// constant in this file *as part of the same commit* and reference the phase id.
/// Each constant doubles as both a baseline assertion and a docstring of the
/// expected after-state for future phases.
/// </summary>
public class WireSizeBenchTests
{
    private static readonly MessagePackSerializerOptions Options =
        AstervoidsMessagePack.Options;

    private static int Size<T>(T value) => MessagePackSerializer.Serialize(value, Options).Length;

    // ── Representative payloads ────────────────────────────────────────────────

    private static ObjectInfo SampleAsteroidInfo() => new(
        Id: Guid.NewGuid(),
        CreatorMemberId: Guid.NewGuid(),
        OwnerMemberId: Guid.NewGuid(),
        Scope: ObjectScope.Session,
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["radius"] = 0.05,
            ["velocityX"] = 0.1,
            ["velocityY"] = -0.05,
            ["angle"] = 1.234,
            ["rotationSpeed"] = 0.02,
            ["seed"] = 12345
        }),
        Version: 1L);

    private static ObjectInfo SampleShipInfo() => new(
        Id: Guid.NewGuid(),
        CreatorMemberId: Guid.NewGuid(),
        OwnerMemberId: Guid.NewGuid(),
        Scope: ObjectScope.Member,
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["type"] = "ship",
            ["x"] = 0.5,
            ["y"] = 0.5,
            ["angle"] = 0.0,
            ["velocityX"] = 0.0,
            ["velocityY"] = 0.0,
            ["rotationSpeed"] = 0.0,
            ["thrusting"] = false,
            ["invulnerable"] = false,
            ["colorIndex"] = 0,
            ["memberId"] = Guid.NewGuid().ToString(),
            ["score"] = 0,
            ["hitCount"] = 0
        }),
        Version: 1L);

    private static ObjectUpdateInfo SampleAsteroidUpdate() => new(
        Id: Guid.NewGuid(),
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234
        }),
        Version: 42L);

    private static ObjectUpdateInfo SampleShipUpdate() => new(
        Id: Guid.NewGuid(),
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
            ["velocityX"] = 0.05,
            ["velocityY"] = -0.03,
            ["rotationSpeed"] = 0.01,
            ["thrusting"] = true,
            ["invulnerable"] = false
            // Phase 2.3 (A4): score and hitCount no longer ride on per-frame
            // updates; pushed via OnObjectEvent instead. Snapshot reconciliation
            // (toSyncData / SampleShipInfo) still includes them.
        }),
        Version: 42L);

    private static ObjectUpdateInfo SampleBulletUpdate() => new(
        Id: Guid.NewGuid(),
        Data: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["lifetime"] = 0.8,
            ["pendingHit"] = true,
            ["hitTargetId"] = Guid.NewGuid().ToString(),
            ["hitImpactTorque"] = 0.05,
            ["hitBulletAngle"] = 1.57,
            ["hitOffsetN"] = 0.3
        }),
        Version: 17L);

    // ── Production positional schemas ──────────────────────────────────────────
    // These mirror index.html WIREOPT_SCHEMAS exactly.

    private static readonly PositionalSchemaCodec.Schema ShipSchema =
        new(1, new[] {
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
            new PositionalSchemaCodec.FieldSpec("thrustInput", "q8"),
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

    private static readonly PositionalSchemaCodec.Schema AsteroidSchema =
        new(2, new[] {
            new PositionalSchemaCodec.FieldSpec("type", "str"),
            new PositionalSchemaCodec.FieldSpec("x", "q16w"),
            new PositionalSchemaCodec.FieldSpec("y", "q16w"),
            new PositionalSchemaCodec.FieldSpec("angle", "q16_2pi"),
            new PositionalSchemaCodec.FieldSpec("radius", "q16"),
            new PositionalSchemaCodec.FieldSpec("velocityX", "q16s"),
            new PositionalSchemaCodec.FieldSpec("velocityY", "q16s"),
            new PositionalSchemaCodec.FieldSpec("rotationSpeed", "q16s"),
            new PositionalSchemaCodec.FieldSpec("seed", "f64"),
            new PositionalSchemaCodec.FieldSpec("vertices", "bytes"),
            new PositionalSchemaCodec.FieldSpec("terminalEpoch", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalX", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalY", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalAngle", "f64"),
        });

    private static readonly PositionalSchemaCodec.Schema BulletSchema =
        new(3, new[] {
            new PositionalSchemaCodec.FieldSpec("type", "str"),
            new PositionalSchemaCodec.FieldSpec("x", "q16w"),
            new PositionalSchemaCodec.FieldSpec("y", "q16w"),
            new PositionalSchemaCodec.FieldSpec("velocityX", "q16s"),
            new PositionalSchemaCodec.FieldSpec("velocityY", "q16s"),
            new PositionalSchemaCodec.FieldSpec("lifetime", "u16"),
            new PositionalSchemaCodec.FieldSpec("colorIndex", "u8"),
            new PositionalSchemaCodec.FieldSpec("ownerMemberId", "guid"),
            new PositionalSchemaCodec.FieldSpec("pendingHit", "bool"),
            new PositionalSchemaCodec.FieldSpec("hitTargetId", "nullable-guid"),
            new PositionalSchemaCodec.FieldSpec("hitImpactTorque", "q16s"),
            new PositionalSchemaCodec.FieldSpec("hitBulletAngle", "q16_2pi"),
            new PositionalSchemaCodec.FieldSpec("hitOffsetN", "q16s"),
            new PositionalSchemaCodec.FieldSpec("terminalEpoch", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalX", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalY", "f64"),
        });

    private static readonly PositionalSchemaCodec.Schema GameStateSchema =
        new(4, new[] {
            new PositionalSchemaCodec.FieldSpec("type", "str"),
            new PositionalSchemaCodec.FieldSpec("gameStarted", "bool"),
            new PositionalSchemaCodec.FieldSpec("wave", "u16"),
            new PositionalSchemaCodec.FieldSpec("state", "str"),
            new PositionalSchemaCodec.FieldSpec("lives", "u16"),
            new PositionalSchemaCodec.FieldSpec("groupScore", "u32"),
            new PositionalSchemaCodec.FieldSpec("speedMultiplier", "f32"),
            new PositionalSchemaCodec.FieldSpec("waveDelayTimer", "f32"),
            new PositionalSchemaCodec.FieldSpec("processedHits", "bytes"),
            new PositionalSchemaCodec.FieldSpec("processedScores", "bytes"),
            new PositionalSchemaCodec.FieldSpec("peakShipCount", "u8"),
            new PositionalSchemaCodec.FieldSpec("gameOverAt", "f64"),
            new PositionalSchemaCodec.FieldSpec("terminalAt", "f64"),
            new PositionalSchemaCodec.FieldSpec("scoreLifeAwardCount", "u32"),
        });

    // ── Per-payload baselines (current main, as of wireopt phase 0) ────────────

    [Fact]
    public void Baseline_AsteroidInfo_FullCreate()
    {
        // 9 data fields including string GUIDs for member ids embedded as keys/values.
        // Expected ranges accommodate slight variation per Guid (binary GUIDs are fixed 18 B).
        var size = Size(SampleAsteroidInfo());
        // Legacy schema-0 data retained as a comparison baseline; ObjectInfo
        // itself is now a compact six-slot array.
        size.Should().BeInRange(195, 205, "schema-0 asteroid create comparison");
    }

    [Fact]
    public void Baseline_ShipInfo_FullCreate()
    {
        var size = Size(SampleShipInfo());
        size.Should().BeInRange(278, 288, "schema-0 ship create comparison");
    }

    [Fact]
    public void Baseline_AsteroidUpdate_PerFrame()
    {
        var size = Size(SampleAsteroidUpdate());
        size.Should().BeInRange(58, 66, "schema-0 asteroid update comparison");
    }

    [Fact]
    public void Baseline_ShipUpdate_PerFrame()
    {
        var size = Size(SampleShipUpdate());
        size.Should().BeInRange(142, 152, "schema-0 ship update comparison");
    }

    [Fact]
    public void Baseline_BulletUpdate_PerFrame_WithPendingHit()
    {
        var size = Size(SampleBulletUpdate());
        size.Should().BeInRange(195, 225, "schema-0 pending-hit comparison");
    }

    // ── Batch-level baselines (one OnObjectsUpdated broadcast) ────────────────

    [Fact]
    public void Baseline_OnObjectsUpdated_3Asteroids()
    {
        // The hot-path broadcast carries List<ObjectUpdateInfo>; this is a typical
        // multi-asteroid frame. Used as the single most-impactful regression gate.
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdate(),
            SampleAsteroidUpdate(),
            SampleAsteroidUpdate()
        };
        var size = Size(batch);
        size.Should().BeInRange(180, 195, "three schema-0 asteroid updates");
    }

    [Fact]
    public void Baseline_OnObjectsUpdated_MixedSession()
    {
        // Realistic steady-state: 4 asteroids + 1 ship + 2 bullets = 7-object batch.
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdate(), SampleAsteroidUpdate(),
            SampleAsteroidUpdate(), SampleAsteroidUpdate(),
            SampleShipUpdate(),
            SampleBulletUpdate(), SampleBulletUpdate()
        };
        var size = Size(batch);
        size.Should().BeInRange(775, 800, "mixed schema-0 comparison batch");
    }

    // ── Snapshot baselines (rare path; one-shot per join) ─────────────────────

    [Fact]
    public void Baseline_JoinSessionResponse_4Asteroids_2Ships()
    {
        var validAtsList = new List<GuidLongPair>();
        var objects = new List<ObjectInfo>();
        for (int i = 0; i < 4; i++)
        {
            var o = SampleAsteroidInfo();
            objects.Add(o);
            validAtsList.Add(new GuidLongPair(o.Id, 1_700_000_000_000L + i));
        }
        for (int i = 0; i < 2; i++)
        {
            var o = SampleShipInfo();
            objects.Add(o);
            validAtsList.Add(new GuidLongPair(o.Id, 1_700_000_000_500L + i));
        }
        var members = new[]
        {
            new MemberInfo(Guid.NewGuid(), MemberRole.Server, DateTime.UtcNow),
            new MemberInfo(Guid.NewGuid(), MemberRole.Client, DateTime.UtcNow)
        };
        var dto = new JoinSessionResponse(
            SessionId: Guid.NewGuid(),
            SessionName: "Banana",
            MemberId: Guid.NewGuid(),
            Role: MemberRole.Client,
            ReconnectToken: new string('a', 64),
            Members: members,
            Objects: objects,
            ValidAts: validAtsList.ToArray(),
            Metadata: new Dictionary<string, object?> { ["aspectRatio"] = 1.78 });

        var size = Size(dto);
        size.Should().BeInRange(1830, 1870,
            "schema-0 comparison snapshot with compact ObjectInfo arrays");
    }

    [Fact]
    public void Baseline_UpdateObjectsResponse_3Versions()
    {
        var versions = new[]
        {
            new GuidLongPair(Guid.NewGuid(), 10),
            new GuidLongPair(Guid.NewGuid(), 11),
            new GuidLongPair(Guid.NewGuid(), 12)
        };
        var dto = new UpdateObjectsResponse(versions, 42L, 1_700_000_000_000L);
        var size = Size(dto);
        // Binary GuidLongPair entries plus a three-slot response array reduce the
        // original 184-byte contract to 72 bytes.
        size.Should().Be(72, "compact UpdateObjectsResponse with three versions");
    }

    // ── Phase 2.1 — generic OnObjectEvent broadcast ────────────────────────────

    [Fact]
    public void Baseline_ObjectEvent_ShipStateChanged()
    {
        // Phase 2.3: replaces per-frame score+hitCount on the ship update.
        // Sent only when score/hitCount changes (1 per asteroid kill, 1 per
        // ship hit) — far rarer than per-frame.
        var dto = new ObjectEventInfo(
            ObjectId: Guid.NewGuid(),
            EventKind: 1, // SHIP_STATE_CHANGED
            Payload: SyncPayloadCodec.EncodeDict(new Dictionary<string, object?>
            {
                ["sc"] = 100,
                ["hc"] = 2
            }).Data);
        var size = Size(dto);
        size.Should().BeInRange(35, 45,
            "compact positional event envelope with aliased MessagePack bytes");
    }

    // ── Production quantized schema baselines ──────────────────────────────────

    private static ObjectUpdateInfo SampleAsteroidUpdateQuantized() => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(2, PositionalSchemaCodec.Encode(AsteroidSchema, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
        })),
        Version: 42L);

    private static ObjectUpdateInfo SampleShipUpdateQuantized() => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(1, PositionalSchemaCodec.Encode(ShipSchema, new Dictionary<string, object?>
        {
            ["x"] = 0.523,
            ["y"] = 0.412,
            ["angle"] = 1.234,
            ["velocityX"] = 0.05,
            ["velocityY"] = -0.03,
            ["rotationSpeed"] = 0.01,
            ["thrusting"] = true,
            ["invulnerable"] = 120,
            ["thrustInput"] = 1d,
            ["brakeInput"] = 0d,
            ["turnControlMode"] = 1,
            ["turnTarget"] = 0.5,
            ["turnTargetAngle"] = 1.5,
            ["turnMagnitude"] = 1d,
            ["turnBias"] = 0d,
        })),
        Version: 42L);

    private static ObjectUpdateInfo SampleBulletUpdateQuantized(bool pendingHit = false) => new(
        Id: Guid.NewGuid(),
        Data: new SyncPayload(3, PositionalSchemaCodec.Encode(BulletSchema, pendingHit
            ? new Dictionary<string, object?>
            {
                ["pendingHit"] = true,
                ["hitTargetId"] = Guid.NewGuid().ToString(),
                ["hitImpactTorque"] = 0.05,
                ["hitBulletAngle"] = 1.57,
                ["hitOffsetN"] = 0.3
            }
            : new Dictionary<string, object?>
            {
                ["x"] = 0.523,
                ["y"] = 0.412,
                ["lifetime"] = 42
            })),
        Version: 17L);

    [Fact]
    public void Production_AsteroidUpdate_PerFrame_Quantized()
    {
        var size = Size(SampleAsteroidUpdateQuantized());
        size.Should().BeInRange(29, 35, "asteroid positional x/y/angle delta");
    }

    [Fact]
    public void Production_ShipUpdate_PerFrame_Quantized()
    {
        var size = Size(SampleShipUpdateQuantized());
        size.Should().BeInRange(52, 62, "full replay-capable ship update");
    }

    [Fact]
    public void Production_BulletUpdates_ArePositional()
    {
        Size(SampleBulletUpdateQuantized()).Should().BeInRange(
            29, 35, "ballistic bullet delta");
        Size(SampleBulletUpdateQuantized(pendingHit: true)).Should().BeInRange(
            50, 60, "pending-hit bullet delta");
    }

    [Fact]
    public void Production_OnObjectsUpdated_3Asteroids_Quantized()
    {
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdateQuantized(),
            SampleAsteroidUpdateQuantized(),
            SampleAsteroidUpdateQuantized()
        };
        var size = Size(batch);
        size.Should().BeInRange(90, 105, "three compact asteroid deltas");
    }

    [Fact]
    public void Production_OnObjectsUpdated_MixedSession_Quantized()
    {
        var batch = new List<ObjectUpdateInfo>
        {
            SampleAsteroidUpdateQuantized(), SampleAsteroidUpdateQuantized(),
            SampleAsteroidUpdateQuantized(), SampleAsteroidUpdateQuantized(),
            SampleShipUpdateQuantized(),
            SampleBulletUpdateQuantized(), SampleBulletUpdateQuantized()
        };
        var size = Size(batch);
        size.Should().BeInRange(235, 255, "mixed steady-state positional batch");
    }

    [Fact]
    public void Production_InnerPayloadBodies_AreByteStable()
    {
        var shipCreate = PositionalSchemaCodec.Encode(ShipSchema, new Dictionary<string, object?>
        {
            ["type"] = "ship",
            ["x"] = 0.5, ["y"] = 0.5, ["angle"] = 1d,
            ["velocityX"] = 0.1, ["velocityY"] = -0.05,
            ["rotationSpeed"] = 0.01,
            ["thrusting"] = true, ["invulnerable"] = 120,
            ["colorIndex"] = 1,
            ["memberId"] = "00112233-4455-6677-8899-aabbccddeeff",
            ["score"] = 0, ["hitCount"] = 0
        });
        var asteroidCreate = PositionalSchemaCodec.Encode(AsteroidSchema, new Dictionary<string, object?>
        {
            ["type"] = "asteroid",
            ["x"] = 0.5, ["y"] = 0.5, ["angle"] = 1d,
            ["radius"] = 0.083,
            ["velocityX"] = 0.1, ["velocityY"] = -0.05,
            ["rotationSpeed"] = 0.01,
            ["seed"] = 0.123456789
        });
        var bulletCreate = PositionalSchemaCodec.Encode(BulletSchema, new Dictionary<string, object?>
        {
            ["type"] = "bullet",
            ["x"] = 0.5, ["y"] = 0.5,
            ["velocityX"] = 1d, ["velocityY"] = 0d,
            ["lifetime"] = 60, ["colorIndex"] = 1,
            ["ownerMemberId"] = "00112233-4455-6677-8899-aabbccddeeff"
        });
        var gameStateCreate = PositionalSchemaCodec.Encode(GameStateSchema, new Dictionary<string, object?>
        {
            ["type"] = "gameState",
            ["gameStarted"] = true,
            ["wave"] = 1,
            ["state"] = "playing",
            ["lives"] = 3,
            ["groupScore"] = 0,
            ["speedMultiplier"] = 1d,
            ["waveDelayTimer"] = 0d,
            ["processedHits"] = Array.Empty<byte>(),
            ["processedScores"] = Array.Empty<byte>(),
            ["peakShipCount"] = 2,
            ["scoreLifeAwardCount"] = 0
        });

        shipCreate.Length.Should().Be(47);
        asteroidCreate.Length.Should().Be(34);
        bulletCreate.Length.Should().Be(37);
        gameStateCreate.Length.Should().Be(52);
    }
}
