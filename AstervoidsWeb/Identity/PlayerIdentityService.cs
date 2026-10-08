using System.Text.Json;
using AstervoidsWeb.Configuration;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Identity;

internal sealed class PlayerIdentityService(IIdentityStore store, IOptions<IdentitySettings> options)
{
    private const int MaximumAttempts = 12;

    public async Task<VerifiedPlayerResult> VerifyPlayerAsync(
        string credential, Guid expectedPlayerId, CancellationToken cancellationToken = default)
    {
        if (!IdentitySecrets.IsToken(credential))
            return new(null, "invalid_browser_credential");
        if (expectedPlayerId == Guid.Empty)
            return new(null, "invalid_request");
        try
        {
            var browser = await ReadAsync<BrowserIdentityRow>(
                IdentityRows.BrowserKey(IdentitySecrets.Hash(credential)), cancellationToken);
            if (browser?.IdentityId is null)
                return new(null, "identity_required");
            if (browser.IdentityId != expectedPlayerId)
                return new(null, "binding_changed");
            return new((await BindingAsync(browser, cancellationToken)).Identity);
        }
        catch (IdentityStoreUnavailableException)
        {
            return new(null, "identity_unavailable");
        }
    }

    public Task<IdentityResult> ResolveAsync(
        string credential, ResolveIdentityRequest request, CancellationToken cancellationToken = default)
    {
        if (!IdentitySecrets.IsToken(credential))
            return Failure("invalid_browser_credential");
        if (request.InviteToken is not null && !IdentitySecrets.IsToken(request.InviteToken))
            return Failure("invalid_request");

        return WithStorageAsync(async () =>
        {
            var key = IdentityRows.BrowserKey(IdentitySecrets.Hash(credential));
            for (var attempt = 0; attempt < MaximumAttempts; attempt++)
            {
                var browser = await ReadAsync<BrowserIdentityRow>(key, cancellationToken);
                var invite = request.InviteToken is null ? null
                    : await FindInviteAsync(request.InviteToken, cancellationToken);
                if (request.InviteToken is not null && invite is null)
                    return IdentityResult.Failure("invite_not_found");
                if (browser is null)
                {
                    browser = new(key, IdentitySecrets.NewEtag(), null, 0);
                    if (!await store.TryCommitAsync([new(browser)], cancellationToken))
                        continue;
                }
                return IdentityResult.Success(200, new ResolveIdentityReply(
                    await BindingAsync(browser, cancellationToken), options.Value.PromptOnRoot,
                    invite is null ? null : new(invite.Id,
                        invite.Tag is null ? "pending" : "active", invite.Tag, invite.Version)));
            }
            return IdentityResult.Failure("identity_unavailable");
        });
    }

    public Task<IdentityResult> CreateRootAsync(
        string credential, RootIdentityRequest request, CancellationToken cancellationToken = default)
    {
        if (!IdentitySecrets.IsExpectedBinding(request.ExpectedBinding))
            return Failure("invalid_request");
        if (!IdentitySecrets.IsTag(request.Tag))
            return Failure("invalid_tag");

        return MutateAsync(credential, request.RequestId, "root", request, browser =>
        {
            if (!Matches(browser, request.ExpectedBinding) || browser!.IdentityId is not null)
                return Task.FromResult(PlanFailure("binding_changed"));

            var identity = NewIdentity(request.Tag);
            var binding = Rebind(browser, identity.Id);
            return Task.FromResult(new MutationPlan(
                IdentityResult.Success(201, new BindingReply(
                    new(new(identity.Id, identity.Tag!), binding.Version, binding.Revision))), binding,
                [new(identity), new(NewLookup(identity))]));
        }, cancellationToken);
    }

    public Task<IdentityResult> CreateInviteAsync(
        string credential, CreateInviteRequest request, CancellationToken cancellationToken = default) =>
        MutateAsync(credential, request.RequestId, "invite", request, async browser =>
        {
            if (browser?.IdentityId is null)
                return PlanFailure("identity_required");
            await BindingAsync(browser, cancellationToken);
            var invite = NewIdentity(null);
            return new(IdentityResult.Success(201, new InviteTokenReply(invite.InviteToken)),
                browser, [new(invite), new(NewLookup(invite))]);
        }, cancellationToken);

    public Task<IdentityResult> AcceptInviteAsync(
        string credential, AcceptInviteRequest request, CancellationToken cancellationToken = default)
    {
        if (!IdentitySecrets.IsToken(request.InviteToken)
            || !IdentitySecrets.IsEtag(request.ExpectedInviteEtag)
            || !IdentitySecrets.IsExpectedBinding(request.ExpectedBinding))
            return Failure("invalid_request");
        if (request.Tag is not null && !IdentitySecrets.IsTag(request.Tag))
            return Failure("invalid_tag");

        return MutateAsync(credential, request.RequestId, "accept", request, async browser =>
        {
            if (!Matches(browser, request.ExpectedBinding))
                return PlanFailure("binding_changed");
            var identity = await FindInviteAsync(request.InviteToken, cancellationToken);
            if (identity is null)
                return PlanFailure("invite_not_found");
            if (identity.Version != request.ExpectedInviteEtag)
                return PlanFailure("invite_changed");
            var writes = new List<IdentityWrite>();
            if (identity.Tag is null)
            {
                if (!IdentitySecrets.IsTag(request.Tag))
                    return PlanFailure("invalid_tag");
                identity = identity with { Tag = request.Tag, State = "active", Version = IdentitySecrets.NewEtag() };
                writes.Add(new(identity, identity.StorageEtag));
            }
            else if (request.Tag is not null && request.Tag != identity.Tag)
            {
                return PlanFailure("invalid_request");
            }
            var binding = Rebind(browser!, identity.Id);
            return new(IdentityResult.Success(200, new BindingReply(
                new(new(identity.Id, identity.Tag!), binding.Version, binding.Revision))), binding, writes);
        }, cancellationToken);
    }

    public Task<IdentityResult> SelfInviteAsync(
        string credential, SelfInviteRequest request, CancellationToken cancellationToken = default)
    {
        if (!IdentitySecrets.IsToken(credential))
            return Failure("invalid_browser_credential");
        if (!IdentitySecrets.IsExpectedBinding(request.ExpectedBinding))
            return Failure("invalid_request");

        return WithStorageAsync(async () =>
        {
            var browser = await ReadAsync<BrowserIdentityRow>(
                IdentityRows.BrowserKey(IdentitySecrets.Hash(credential)), cancellationToken);
            if (!Matches(browser, request.ExpectedBinding))
                return IdentityResult.Failure("binding_changed");
            if (browser!.IdentityId is null)
                return IdentityResult.Failure("identity_required");
            var identity = await ReadAsync<PlayerIdentityRow>(
                IdentityRows.PlayerKey(browser.IdentityId.Value), cancellationToken);
            if (identity?.Tag is null)
                throw new IdentityStoreUnavailableException();
            return IdentityResult.Success(200, new InviteTokenReply(identity.InviteToken));
        });
    }

    private Task<IdentityResult> MutateAsync<T>(
        string credential, Guid requestId, string operation, T request,
        Func<BrowserIdentityRow?, Task<MutationPlan>> prepare, CancellationToken cancellationToken)
    {
        if (!IdentitySecrets.IsToken(credential))
            return Failure("invalid_browser_credential");
        if (requestId == Guid.Empty)
            return Failure("invalid_request");

        return WithStorageAsync(async () =>
        {
            var browserHash = IdentitySecrets.Hash(credential);
            var browserKey = IdentityRows.BrowserKey(browserHash);
            var operationKey = IdentityRows.OperationKey(browserHash, requestId);
            var bodyHash = IdentitySecrets.Hash(JsonSerializer.Serialize(request, IdentityJson.Options));
            for (var attempt = 0; attempt < MaximumAttempts; attempt++)
            {
                var receipt = await ReadAsync<IdentityOperationRow>(operationKey, cancellationToken);
                var browser = await ReadAsync<BrowserIdentityRow>(browserKey, cancellationToken);
                if (receipt is not null)
                {
                    if (receipt.Operation != operation || receipt.BodyHash != bodyHash)
                        return IdentityResult.Failure("request_reused");
                    if (browser is null || browser.IdentityId != receipt.BindingIdentityId
                        || browser.Version != receipt.BindingEtag || browser.Revision != receipt.BindingRevision)
                        return IdentityResult.Failure("binding_changed");
                    return new(receipt.StatusCode, receipt.Body);
                }
                var plan = await prepare(browser);
                if (!plan.Result.Succeeded)
                {
                    // The same request may have committed between our receipt
                    // read and browser/invite reads. Replay it, not a false conflict.
                    if (await ReadAsync<IdentityOperationRow>(operationKey, cancellationToken) is not null)
                        continue;
                    return plan.Result;
                }
                var resultBrowser = plan.Browser!;
                var resultReceipt = new IdentityOperationRow(operationKey, IdentitySecrets.NewEtag(),
                    operation, bodyHash, resultBrowser.IdentityId!.Value, resultBrowser.Version,
                    resultBrowser.Revision, plan.Result.StatusCode, plan.Result.Body);
                var writes = plan.Writes.Concat([
                    new IdentityWrite(resultBrowser, browser!.StorageEtag),
                    new IdentityWrite(resultReceipt)]).ToArray();
                if (await store.TryCommitAsync(writes, cancellationToken))
                    return plan.Result;
            }
            return IdentityResult.Failure("identity_unavailable");
        });
    }

    private async Task<BrowserBinding> BindingAsync(
        BrowserIdentityRow browser, CancellationToken cancellationToken)
    {
        if (browser.IdentityId is null)
            return new(null, browser.Version, browser.Revision);
        var identity = await ReadAsync<PlayerIdentityRow>(
            IdentityRows.PlayerKey(browser.IdentityId.Value), cancellationToken);
        if (identity?.Tag is null)
            throw new IdentityStoreUnavailableException();
        return new(new(identity.Id, identity.Tag), browser.Version, browser.Revision);
    }

    private async Task<PlayerIdentityRow?> FindInviteAsync(string token, CancellationToken cancellationToken)
    {
        var invite = await ReadAsync<InviteLookupRow>(IdentityRows.InviteKey(token), cancellationToken);
        if (invite is null)
            return null;
        var identity = await ReadAsync<PlayerIdentityRow>(IdentityRows.PlayerKey(invite.IdentityId), cancellationToken);
        if (identity is null || identity.InviteToken != token)
            throw new IdentityStoreUnavailableException();
        return identity;
    }

    private async Task<T?> ReadAsync<T>(string key, CancellationToken cancellationToken) where T : IdentityRow
    {
        var row = await store.ReadAsync(key, cancellationToken);
        if (row is null)
            return null;
        return row as T ?? throw new IdentityStoreUnavailableException();
    }

    private static PlayerIdentityRow NewIdentity(string? tag)
    {
        var id = Guid.NewGuid();
        return new(IdentityRows.PlayerKey(id), IdentitySecrets.NewEtag(), id, tag,
            tag is null ? "pending" : "active", IdentitySecrets.NewToken());
    }

    private static InviteLookupRow NewLookup(PlayerIdentityRow identity) =>
        new(IdentityRows.InviteKey(identity.InviteToken), IdentitySecrets.NewEtag(), identity.Id);

    private static BrowserIdentityRow Rebind(BrowserIdentityRow browser, Guid identityId) =>
        browser.IdentityId == identityId ? browser : browser with
        {
            IdentityId = identityId,
            Revision = checked(browser.Revision + 1),
            Version = IdentitySecrets.NewEtag()
        };

    private static bool Matches(BrowserIdentityRow? browser, ExpectedBinding expected) =>
        browser is not null && browser.IdentityId == expected.IdentityId && browser.Version == expected.Etag;

    private static Task<IdentityResult> Failure(string code) => Task.FromResult(IdentityResult.Failure(code));
    private static MutationPlan PlanFailure(string code) => new(IdentityResult.Failure(code), null, []);

    private static async Task<IdentityResult> WithStorageAsync(Func<Task<IdentityResult>> execute)
    {
        try
        {
            return await execute();
        }
        catch (IdentityStoreUnavailableException)
        {
            return IdentityResult.Failure("identity_unavailable");
        }
        catch (OverflowException)
        {
            return IdentityResult.Failure("identity_unavailable");
        }
    }

    private sealed record MutationPlan(
        IdentityResult Result, BrowserIdentityRow? Browser, IReadOnlyList<IdentityWrite> Writes);
}
