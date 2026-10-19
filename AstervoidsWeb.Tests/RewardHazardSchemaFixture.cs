using AstervoidsWeb.Hubs;

namespace AstervoidsWeb.Tests;

internal static class RewardHazardSchemaFixture
{
    internal static readonly PositionalSchemaCodec.Schema Effect = new(5,
    [
        new("type", "str"), new("kind", "u8"), new("payloadKind", "u8"), new("sourceId", "guid"),
        new("claimId", "nullable-guid"), new("participantId", "nullable-guid"), new("participantTag", "str"),
        new("shipId", "nullable-guid"), new("x", "q16w"), new("y", "q16w"),
        new("velocityX", "f32"), new("velocityY", "f32"), new("angle", "q16_2pi"),
        new("startedAt", "f64"), new("armedAt", "f64"), new("expiresAt", "f64"), new("points", "u32"),
        new("damageReceipts", "bytes"), new("asteroidTargets", "bytes"), new("hazardTargets", "bytes"),
        new("contributors", "bytes"), new("shipLifeId", "nullable-guid"),
    ]);

    internal static readonly PositionalSchemaCodec.Schema Claim = new(6,
    [
        new("type", "str"), new("targetId", "guid"), new("shipId", "guid"), new("participantId", "guid"),
        new("participantTag", "str"), new("x", "q16w"), new("y", "q16w"), new("angle", "q16_2pi"),
        new("claimedAt", "f64"), new("invulnerabilityRevision", "u32"),
        new("shipLifeId", "guid"),
    ]);

    internal const string BoostState =
        "33221100554477668899aabbccddeeff" + "0000000000408f40" + "000000000070a740";
    internal const string ModifierEntry =
        "33221100554477668899aabbccddeeff" + "08000000" + "02";
    internal const string ContributorEntry =
        "33221100554477668899aabbccddeeff" + "01000000";
}
