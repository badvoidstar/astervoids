using System.Buffers;
using AstervoidsWeb.Formatters;
using AstervoidsWeb.Hubs;
using AstervoidsWeb.Models;
using FluentAssertions;
using MessagePack;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Protocol;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Tests;

public class ReplacementWireTests
{
    private static readonly MessagePackSerializerOptions SerializerOptions =
        AstervoidsMessagePack.Options;

    private static List<ObjectInfo> Children() => [Child(1), Child(2)];

    private static ObjectInfo Child(int value) => new(
        Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), ObjectScope.Session,
        SyncPayloadCodec.EncodeDict(new Dictionary<string, object?> { ["counter"] = value }), 1);

    private static int WireSize(HubMessage message)
    {
        var protocol = new MessagePackHubProtocol(Options.Create(
            new MessagePackHubProtocolOptions { SerializerOptions = SerializerOptions }));
        var buffer = new ArrayBufferWriter<byte>();
        protocol.WriteMessage(message, buffer);
        return buffer.WrittenCount;
    }

    [Fact]
    public void ReplaceResponse_UsesThreePositionalSlotsWithOneValidatedAnchor()
    {
        var children = Children();
        var response = new ReplaceObjectResponse(children, 7, 1_700_000_000_123);
        var bytes = MessagePackSerializer.Serialize(response, SerializerOptions);
        var reader = new MessagePackReader(bytes);
        reader.ReadArrayHeader().Should().Be(3);
        reader.Skip();
        reader.ReadInt64().Should().Be(7);
        reader.ReadInt64().Should().Be(response.ValidAt);
        reader.End.Should().BeTrue();
        var decoded = MessagePackSerializer.Deserialize<ReplaceObjectResponse>(bytes, SerializerOptions);
        decoded.CreatedObjects.Select(child => child.Id).Should().Equal(children.Select(child => child.Id));
        decoded.MemberSequence.Should().Be(7);
        decoded.ValidAt.Should().Be(response.ValidAt);
        bytes.Length.Should().Be(
            MessagePackSerializer.Serialize(children, SerializerOptions).Length + 11,
            "the array, small sequence, and int64 validAt add only eleven bytes");
    }

    [Fact]
    public void ReplaceSender_ReceivesOneCompletionInsteadOfDuplicatedChildPayloads()
    {
        var children = Children();
        var validAt = 1_700_000_000_123L;
        var oldCompletion = WireSize(CompletionMessage.WithResult("1", children));
        var oldEcho = WireSize(new InvocationMessage("OnObjectReplaced",
        [
            new ObjectReplacedEvent(Guid.NewGuid(), children),
            Guid.NewGuid(), 7L, validAt + 20, validAt
        ]));
        var completion = WireSize(CompletionMessage.WithResult(
            "1", new ReplaceObjectResponse(children, 7, validAt)));

        completion.Should().Be(oldCompletion + 11);
        completion.Should().Be(170, "two small generic children fit in one compact completion");
        (oldCompletion + oldEcho - completion).Should().BeGreaterThan(200,
            "the sender no longer receives an invocation containing the same children");
    }
}
