using MessagePack;
using MessagePack.Resolvers;

namespace AstervoidsWeb.Formatters;

/// <summary>
/// Canonical MessagePack options for hub transport, nested payloads, and wire tests.
/// </summary>
public static class AstervoidsMessagePack
{
    public static MessagePackSerializerOptions Options { get; } =
        MessagePackSerializerOptions.Standard
            .WithResolver(CompositeResolver.Create(
                BinaryGuidResolver.Instance,
                ContractlessStandardResolver.Instance))
            .WithSecurity(MessagePackSecurity.UntrustedData);
}
