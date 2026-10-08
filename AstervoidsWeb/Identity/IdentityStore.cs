using System.Text.Json;
using System.Text.Json.Serialization;

namespace AstervoidsWeb.Identity;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(PlayerIdentityRow), "identity")]
[JsonDerivedType(typeof(InviteLookupRow), "invite")]
[JsonDerivedType(typeof(BrowserIdentityRow), "browser")]
[JsonDerivedType(typeof(IdentityOperationRow), "operation")]
internal abstract record IdentityRow(string Key, string Version)
{
    // Public ETags must be known before a transaction so its receipt can contain
    // the exact result. Azure's native ETag is separate and enforces storage CAS.
    [JsonIgnore]
    public string? StorageEtag { get; init; }
}

internal sealed record PlayerIdentityRow(
    string Key, string Version, Guid Id, string? Tag, string State, string InviteToken,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool ExcludeFromLeaderboards = false)
    : IdentityRow(Key, Version);
internal sealed record InviteLookupRow(
    string Key, string Version, Guid IdentityId) : IdentityRow(Key, Version);
internal sealed record BrowserIdentityRow(
    string Key, string Version, Guid? IdentityId, long Revision) : IdentityRow(Key, Version);
internal sealed record IdentityOperationRow(
    string Key, string Version, string Operation, string BodyHash,
    Guid BindingIdentityId, string BindingEtag, long BindingRevision,
    int StatusCode, JsonElement Body) : IdentityRow(Key, Version);

internal sealed record IdentityWrite(IdentityRow Row, string? ExpectedStorageEtag = null);

internal interface IIdentityStore
{
    Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken);
    Task<bool> TryCommitAsync(IReadOnlyList<IdentityWrite> writes, CancellationToken cancellationToken);
}

internal sealed class IdentityStoreUnavailableException : Exception
{
    public IdentityStoreUnavailableException() : base("Identity storage is unavailable.") { }
}

internal sealed class UnavailableIdentityStore : IIdentityStore
{
    public Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken) =>
        throw new IdentityStoreUnavailableException();

    public Task<bool> TryCommitAsync(IReadOnlyList<IdentityWrite> writes, CancellationToken cancellationToken) =>
        throw new IdentityStoreUnavailableException();
}

internal static class IdentityRows
{
    public const string PartitionKey = "identity";

    public static string PlayerKey(Guid id) => $"I:{id:D}";
    public static string InviteKey(string token) => $"V:{IdentitySecrets.Hash(token)}";
    public static string BrowserKey(string browserHash) => $"B:{browserHash}";
    public static string OperationKey(string browserHash, Guid requestId) => $"O:{browserHash}:{requestId:D}";

    public static void Validate(IdentityRow row)
    {
        var valid = row.Key is not null && IdentitySecrets.IsEtag(row.Version) && (row switch
        {
            PlayerIdentityRow player => player.Id != Guid.Empty
                && player.Key == PlayerKey(player.Id)
                && (player.Tag is null ? player.State == "pending"
                    : player.State == "active" && IdentitySecrets.IsTag(player.Tag))
                && IdentitySecrets.IsToken(player.InviteToken),
            InviteLookupRow invite => invite.IdentityId != Guid.Empty
                && invite.Key.StartsWith("V:", StringComparison.Ordinal)
                && IdentitySecrets.IsHash(invite.Key[2..]),
            BrowserIdentityRow browser => browser.Key.StartsWith("B:", StringComparison.Ordinal)
                && IdentitySecrets.IsHash(browser.Key[2..])
                && (browser.IdentityId is null ? browser.Revision == 0
                    : browser.IdentityId != Guid.Empty && browser.Revision > 0),
            IdentityOperationRow operation => ValidOperationKey(operation.Key)
                && operation.Operation is "root" or "invite" or "accept"
                && IdentitySecrets.IsHash(operation.BodyHash)
                && operation.BindingIdentityId != Guid.Empty
                && IdentitySecrets.IsEtag(operation.BindingEtag)
                && operation.BindingRevision > 0
                && ValidOperationBody(operation),
            _ => false
        });
        if (!valid)
            throw new IdentityStoreUnavailableException();
    }

    private static bool ValidOperationKey(string key) => key.StartsWith("O:", StringComparison.Ordinal)
        && key.Length == 103 && IdentitySecrets.IsHash(key.Substring(2, 64))
        && key[66] == ':' && Guid.TryParseExact(key[67..], "D", out var id) && id != Guid.Empty;

    private static bool ValidOperationBody(IdentityOperationRow operation)
    {
        if (operation.Body.ValueKind != JsonValueKind.Object || IdentityJson.HasDuplicateProperties(operation.Body)
            || operation.StatusCode != (operation.Operation == "accept" ? 200 : 201))
            return false;
        try
        {
            if (operation.Operation == "invite")
                return IdentitySecrets.IsToken(operation.Body.Deserialize<InviteTokenReply>(IdentityJson.Options)?.InviteToken);
            var binding = operation.Body.Deserialize<BindingReply>(IdentityJson.Options)?.Binding;
            return binding?.Identity?.Id == operation.BindingIdentityId
                && IdentitySecrets.IsTag(binding.Identity.Tag)
                && binding.Etag == operation.BindingEtag && binding.Revision == operation.BindingRevision;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
