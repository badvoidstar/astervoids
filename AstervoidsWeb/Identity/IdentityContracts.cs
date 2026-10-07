using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AstervoidsWeb.Configuration;

namespace AstervoidsWeb.Identity;

internal sealed record PlayerIdentity(Guid Id, string Tag);
internal sealed record BrowserBinding(PlayerIdentity? Identity, string Etag, long Revision);
internal sealed record ExpectedBinding(Guid? IdentityId, string Etag);
internal sealed record InviteView(Guid IdentityId, string State, string? Tag, string Etag);
internal sealed record ResolveIdentityRequest(string? InviteToken = null);
internal sealed record RootIdentityRequest(Guid RequestId, ExpectedBinding ExpectedBinding, string Tag);
internal sealed record CreateInviteRequest(Guid RequestId);
internal sealed record AcceptInviteRequest(
    Guid RequestId, string InviteToken, string ExpectedInviteEtag,
    ExpectedBinding ExpectedBinding, string? Tag = null);
internal sealed record SelfInviteRequest(ExpectedBinding ExpectedBinding);
internal sealed record ResolveIdentityReply(BrowserBinding Binding, bool PromptOnRoot, InviteView? Invite);
internal sealed record BindingReply(BrowserBinding Binding);
internal sealed record InviteTokenReply(string InviteToken);
internal sealed record IdentityError(string Code);
internal sealed record IdentityErrorReply(IdentityError Error);

internal sealed record IdentityResult(int StatusCode, JsonElement Body)
{
    public bool Succeeded => StatusCode is >= 200 and < 300;

    public static IdentityResult Success<T>(int statusCode, T body) =>
        new(statusCode, JsonSerializer.SerializeToElement(body, IdentityJson.Options));

    public static IdentityResult Failure(string code, int? statusCode = null) => new(statusCode ?? (code switch
    {
        "invalid_browser_credential" => 401,
        "invite_not_found" => 404,
        "identity_required" or "binding_changed" or "invite_changed" or "request_reused" => 409,
        "rate_limited" => 429,
        "identity_unavailable" => 503,
        _ => 400
    }), JsonSerializer.SerializeToElement(new IdentityErrorReply(new(code)), IdentityJson.Options));
}

internal static class IdentityJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        MaxDepth = 16
    };

    public static bool HasDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
                if (!names.Add(property.Name) || HasDuplicateProperties(property.Value))
                    return true;
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
                if (HasDuplicateProperties(item))
                    return true;
        }
        return false;
    }
}

internal static class IdentitySecrets
{
    public static string NewToken() => Encode(RandomNumberGenerator.GetBytes(32));
    public static string NewEtag() => Guid.NewGuid().ToString("N");
    public static string Hash(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static bool IsToken(string? value)
    {
        if (value is null || value.Length != 43
            || value.Any(c => !IsTagCharacter(c)))
            return false;

        Span<byte> bytes = stackalloc byte[32];
        return Convert.TryFromBase64String(
            value.Replace('-', '+').Replace('_', '/') + "=", bytes, out var written)
            && written == 32 && Encode(bytes) == value;
    }

    public static bool IsTag(string? tag) =>
        tag is { Length: >= 1 } && tag.Length <= SharedConfiguration.Current.IdentityTagMaxLength
            && tag.All(IsTagCharacter);

    public static bool IsHash(string? value) =>
        value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static bool IsEtag(string? value) => value is { Length: > 0 and <= 256 };
    public static bool IsExpectedBinding(ExpectedBinding? binding) =>
        binding is not null && binding.IdentityId != Guid.Empty && IsEtag(binding.Etag);

    private static bool IsTagCharacter(char c) =>
        c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-';

    private static string Encode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
