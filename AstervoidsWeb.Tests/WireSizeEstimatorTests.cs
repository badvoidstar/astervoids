using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using FluentAssertions;
using MessagePack;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Correctness tests for <see cref="WireSizeEstimator"/>.
///
/// The estimator replaces serialize-to-measure on the per-flush
/// <c>UpdateObjects</c> path. It models MessagePack's encoding rules
/// arithmetically, so these tests assert the arithmetic against what the real
/// serializer actually produces for the same values. If MessagePack's encoding
/// behaviour or a hot-path DTO shape ever changes, these fail.
/// </summary>
public class WireSizeEstimatorTests
{
    private static readonly MessagePackSerializerOptions Options =
        AstervoidsMessagePack.Options;

    private static int ActualSize<T>(T value) =>
        MessagePackSerializer.Serialize(value, Options).Length;

    // ── Primitive encodings ────────────────────────────────────────────────────

    [Theory]
    [InlineData(0L)]
    [InlineData(1L)]
    [InlineData(127L)]          // positive fixint boundary
    [InlineData(128L)]          // uint8
    [InlineData(255L)]
    [InlineData(256L)]          // uint16
    [InlineData(12000L)]        // representative object version
    [InlineData(65535L)]
    [InlineData(65536L)]        // uint32
    [InlineData(uint.MaxValue)]
    [InlineData(4294967296L)]   // uint64
    [InlineData(1700000000000L)] // epoch milliseconds
    [InlineData(-1L)]
    [InlineData(-32L)]          // negative fixint boundary
    [InlineData(-33L)]          // int8
    [InlineData(-128L)]
    [InlineData(-129L)]         // int16
    [InlineData(-32768L)]
    [InlineData(-32769L)]       // int32
    [InlineData(int.MinValue)]
    [InlineData(-2147483649L)]  // int64
    [InlineData(long.MaxValue)]
    [InlineData(long.MinValue)]
    public void Int_MatchesSerializedSize(long value)
    {
        WireSizeEstimator.Int(value).Should().Be(ActualSize(value));
    }

    [Fact]
    public void NullableInt_CountsNilAsOneByte()
    {
        WireSizeEstimator.Int((long?)null).Should().Be(ActualSize((long?)null));
        WireSizeEstimator.Int((long?)42).Should().Be(ActualSize((long?)42));
    }

    [Fact]
    public void GuidBytes_MatchesBinaryGuidFormatterOutput()
    {
        WireSizeEstimator.GuidBytes.Should().Be(ActualSize(Guid.NewGuid()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(15)]     // fixarray boundary
    [InlineData(16)]     // array16
    [InlineData(100)]
    public void ArrayHeader_MatchesSerializedOverhead(int count)
    {
        // An array of N nils costs header + N single-byte nils.
        var array = new object?[count];
        WireSizeEstimator.ArrayHeader(count)
            .Should().Be(ActualSize(array) - count * WireSizeEstimator.NilBytes);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(8)]
    [InlineData(255)]    // bin8 boundary
    [InlineData(256)]    // bin16
    public void BinHeader_MatchesSerializedOverhead(int length)
    {
        var bytes = new byte[length];
        WireSizeEstimator.BinHeader(length).Should().Be(ActualSize(bytes) - length);
    }

    // ── DTO shapes ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Session-scoped handles for sample updates, cycling through the
    /// MessagePack integer widths (fixint, uint8, uint32) so a batch never
    /// measures a single encoding width.
    /// </summary>
    private static int HandleAt(int index) => (index % 3) switch
    {
        0 => 1 + index,
        1 => 200 + index,
        _ => 70000 + index
    };

    [Fact]
    public void Payload_MatchesSerializedSyncPayload()
    {
        var payload = new SyncPayload(2, new byte[8]);
        WireSizeEstimator.Payload(payload).Should().Be(ActualSize(payload));
    }

    [Fact]
    public void Payload_HandlesNullPayloadAndNullData()
    {
        WireSizeEstimator.Payload(null).Should().Be(ActualSize((SyncPayload?)null));

        var nullData = new SyncPayload(0, null!);
        WireSizeEstimator.Payload(nullData).Should().Be(ActualSize(nullData));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(20)]     // crosses the fixarray boundary
    public void UpdateObjectsRequest_MatchesSerializedArgumentTuple(int count)
    {
        var updates = Enumerable.Range(0, count)
            .Select(i => new ObjectUpdateRequest(HandleAt(i), new SyncPayload(2, new byte[8])))
            .ToList();

        long? senderSequence = 4200;
        long? senderSendIntervalMs = 50;
        long? clientValidAt = 1700000000000L;

        var estimated = WireSizeEstimator.UpdateObjectsRequest(
            updates, senderSequence, senderSendIntervalMs, clientValidAt);

        var actual = ActualSize(updates)
            + ActualSize(senderSequence)
            + ActualSize(senderSendIntervalMs)
            + ActualSize(clientValidAt);

        estimated.Should().Be(actual);
    }

    [Fact]
    public void UpdateObjectsRequest_HandlesNullTrailingArguments()
    {
        var updates = new List<ObjectUpdateRequest>
        {
            new(HandleAt(0), new SyncPayload(2, new byte[8])),
        };

        var estimated = WireSizeEstimator.UpdateObjectsRequest(updates, null, null, null);
        var actual = ActualSize(updates) + 3 * ActualSize((long?)null);

        estimated.Should().Be(actual);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(20)]
    public void ObjectsUpdatedBroadcast_MatchesSerializedArgumentTuple(int count)
    {
        var updates = Enumerable.Range(0, count)
            .Select(i => new ObjectUpdateInfo(HandleAt(i), new SyncPayload(2, new byte[8]), 12000 + i))
            .ToList();

        var senderMemberId = Guid.NewGuid();
        long? senderSequence = 4200;
        long memberSequence = 991;
        long serverTimestamp = 1700000000000L;
        long? senderSendIntervalMs = 50;
        long batchValidAt = 1700000000123L;

        var estimated = WireSizeEstimator.ObjectsUpdatedBroadcast(
            updates, senderSequence, memberSequence, serverTimestamp, senderSendIntervalMs, batchValidAt);

        var actual = ActualSize(updates)
            + ActualSize(senderMemberId)
            + ActualSize(senderSequence)
            + ActualSize(memberSequence)
            + ActualSize(serverTimestamp)
            + ActualSize(senderSendIntervalMs)
            + ActualSize(batchValidAt);

        estimated.Should().Be(actual);
    }

    [Fact]
    public void ObjectsUpdatedBroadcast_MatchesWithVariablePayloadSizes()
    {
        // Mixed payload sizes, including one that crosses the bin8 boundary,
        // to confirm per-element data lengths are summed rather than assumed.
        var updates = new List<ObjectUpdateInfo>
        {
            new(1, new SyncPayload(2, new byte[8]), 1),
            new(200, new SyncPayload(1, new byte[33]), 300),
            new(70000, new SyncPayload(3, new byte[260]), 70000),
        };

        var estimated = WireSizeEstimator.ObjectsUpdatedBroadcast(updates, null, 1, 2, null, 3);
        var actual = ActualSize(updates)
            + ActualSize(Guid.NewGuid())
            + ActualSize((long?)null)
            + ActualSize(1L)
            + ActualSize(2L)
            + ActualSize((long?)null)
            + ActualSize(3L);

        estimated.Should().Be(actual);
    }
}
