using System.Text.Json;
using System.Text.Json.Serialization;

namespace AstervoidsWeb.Configuration;

internal sealed record SharedConfiguration(int IdentityTagMaxLength)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    public static SharedConfiguration Current { get; } = Load();

    private static SharedConfiguration Load()
    {
        using var source = typeof(SharedConfiguration).Assembly
            .GetManifestResourceStream("AstervoidsWeb.SharedConfiguration.json")
            ?? throw new InvalidOperationException("The shared configuration resource is missing.");
        return Read(source);
    }

    internal static SharedConfiguration Read(Stream source)
    {
        var configuration = JsonSerializer.Deserialize<SharedConfiguration>(source, JsonOptions)
            ?? throw new InvalidDataException("Shared configuration must be an object.");
        if (configuration.IdentityTagMaxLength is < 1 or > byte.MaxValue)
            throw new InvalidDataException("identityTagMaxLength must fit a positive one-byte tag length.");
        return configuration;
    }
}
