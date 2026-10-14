using AstervoidsWeb.Hubs;

namespace AstervoidsWeb.Tests;

internal static class GameStateSchemaFixture
{
    internal static readonly PositionalSchemaCodec.Schema Current = new(4,
    [
        new("type", "str"),
        new("gameStarted", "bool"),
        new("wave", "u16"),
        new("state", "str"),
        new("lives", "u16"),
        new("groupScore", "u32"),
        new("speedMultiplier", "f32"),
        new("waveDelayTimer", "f32"),
        new("processedHits", "bytes"),
        new("processedScores", "bytes"),
        new("peakShipCount", "u8"),
        new("gameOverAt", "f64"),
        new("terminalAt", "f64"),
        new("scoreLifeAwardCount", "u32"),
        new("countedParticipants", "bytes"),
        new("terminalShipId", "guid"),
        new("participantScores", "bytes"),
        new("participantNumbers", "bytes"),
        new("participantTags", "bytes"),
        new("participantXp", "bytes"),
        new("processedEffects", "bytes"),
    ]);

    internal const string ScoreEntries =
        "33221100554477668899aabbccddeeff00000000" +
        "443322116655887799aabbccddeeff0040e20100";

    internal const string NumberEntries =
        "33221100554477668899aabbccddeeff01000000" +
        "443322116655887799aabbccddeeff0002000000";

    internal const string PersonalMapsHex =
        "000003" + "28000000" + ScoreEntries + "28000000" + NumberEntries;

    internal const string TagEntries =
        "33221100554477668899aabbccddeeff07" + "50696c6f745f31";

    internal const string LargeXpEntry =
        "33221100554477668899aabbccddeeff" + "000010000000f041";

    internal const string LargeXpHex = "00000818000000" + LargeXpEntry;
}
