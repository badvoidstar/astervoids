using System.Text.Json.Nodes;
using AstervoidsWeb.Identity;
using static AstervoidsWeb.Tests.IdentityTestState;

namespace AstervoidsWeb.Tests;

public class FileIdentityStoreTests
{
    [Fact]
    public async Task RestartPreservesIdentitiesBindingsTokensAndReceipts()
    {
        using var state = new IdentityTestState();
        var browser = IdentitySecrets.NewToken();
        var (original, originalRequest) = await Root(state.Service(), browser, "Persist");
        var originalToken = await Self(state.Service(), browser, original);
        var request = new CreateInviteRequest(Guid.NewGuid());
        var friendToken = Read<InviteTokenReply>(
            await state.Service().CreateInviteAsync(browser, request), 201).InviteToken;
        var restarted = state.Restart();
        Assert.Equal(original, (await Resolve(restarted, browser)).Binding);
        Assert.Equal(originalToken, await Self(restarted, browser, original));
        Assert.Equal(original, Read<BindingReply>(
            await restarted.CreateRootAsync(browser, originalRequest), 201).Binding);
        Assert.Equal(friendToken,
            Read<InviteTokenReply>(await restarted.CreateInviteAsync(browser, request), 201).InviteToken);

        var otherBrowser = IdentitySecrets.NewToken();
        var pending = await Resolve(restarted, otherBrowser, friendToken);
        var accept = new AcceptInviteRequest(
            Guid.NewGuid(), friendToken, pending.Invite!.Etag, Expect(pending.Binding), "Friend");
        var other = Read<BindingReply>(await restarted.AcceptInviteAsync(otherBrowser, accept)).Binding;
        Assert.Equal(other, Read<BindingReply>(
            await state.Restart().AcceptInviteAsync(otherBrowser, accept)).Binding);
        Assert.Equal(friendToken, await Self(state.Restart(), otherBrowser, other));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("{\"formatVersion\":2,\"rows\":{}}")]
    [InlineData("{\"formatVersion\":1,\"rows\":null}")]
    [InlineData("{\"formatVersion\":1,\"rows\":{\"invalid\":null}}")]
    [InlineData("{\"formatVersion\":1,\"rows\":{},\"rows\":{}}")]
    [InlineData("{\"formatVersion\":2,\"formatVersion\":1,\"rows\":{}}")]
    public async Task InvalidExistingFileIsUnavailableAndNeverReset(string corrupt)
    {
        using var state = new IdentityTestState();
        Directory.CreateDirectory(state.DirectoryPath);
        await File.WriteAllTextAsync(state.DataFile, corrupt);
        Error(await state.Service().ResolveAsync(IdentitySecrets.NewToken(), new()),
            "identity_unavailable", 503);
        Assert.Equal(corrupt, await File.ReadAllTextAsync(state.DataFile));
        Assert.Empty(Directory.GetFiles(state.DirectoryPath, "*.write"));
    }

    [Theory]
    [InlineData("missing-lookup")]
    [InlineData("invalid-state")]
    [InlineData("invalid-tag")]
    [InlineData("invalid-key")]
    [InlineData("invalid-revision")]
    [InlineData("invalid-receipt")]
    public async Task StructurallyCorruptRowsCannotProducePartialOrResetState(string corruption)
    {
        using var state = new IdentityTestState();
        var browser = IdentitySecrets.NewToken();
        await Root(state.Service(), browser);
        var document = JsonNode.Parse(await File.ReadAllTextAsync(state.DataFile))!;
        var rows = document["rows"]!.AsObject();
        var identity = rows.First(pair => pair.Key.StartsWith("I:", StringComparison.Ordinal));
        var binding = rows.First(pair => pair.Key.StartsWith("B:", StringComparison.Ordinal));
        switch (corruption)
        {
            case "missing-lookup":
                rows.Remove(rows.First(pair => pair.Key.StartsWith("V:", StringComparison.Ordinal)).Key);
                break;
            case "invalid-state":
                identity.Value!["state"] = "pending";
                break;
            case "invalid-tag":
                identity.Value!["tag"] = "invalid tag";
                break;
            case "invalid-key":
                identity.Value!["key"] = null;
                break;
            case "invalid-revision":
                binding.Value!["revision"] = -1;
                break;
            case "invalid-receipt":
                rows.First(pair => pair.Key.StartsWith("O:", StringComparison.Ordinal)).Value!["body"] = new JsonObject();
                break;
        }
        var corrupt = document.ToJsonString();
        await File.WriteAllTextAsync(state.DataFile, corrupt);
        Error(await state.Restart().ResolveAsync(browser, new()), "identity_unavailable", 503);
        Assert.Equal(corrupt, await File.ReadAllTextAsync(state.DataFile));
    }

    [Fact]
    public async Task StableExclusiveLockCoordinatesIndependentStoreInstances()
    {
        using var state = new IdentityTestState();
        var browser = IdentitySecrets.NewToken();
        var before = await Resolve(state.Service(), browser);
        var held = new FileStream(state.DataFile + ".lock", FileMode.Open,
            FileAccess.ReadWrite, FileShare.None);
        try
        {
            var pending = state.Restart().CreateRootAsync(browser,
                new(Guid.NewGuid(), Expect(before.Binding), "Locked"));
            await Task.Delay(50);
            Assert.False(pending.IsCompleted);
            held.Dispose();
            Assert.Equal("Locked", Read<BindingReply>(await pending, 201).Binding.Identity!.Tag);
        }
        finally
        {
            held.Dispose();
        }
        Assert.True(File.Exists(state.DataFile + ".lock"));
        Assert.Empty(Directory.GetFiles(state.DirectoryPath, "*.write"));
    }

    [Fact]
    public async Task CredentialOnlyExistsAsHashInDurableRowsAndFilenames()
    {
        using var state = new IdentityTestState();
        var browser = IdentitySecrets.NewToken();
        await Root(state.Service(), browser);
        var document = await File.ReadAllTextAsync(state.DataFile);
        Assert.DoesNotContain(browser, document);
        Assert.Contains(IdentitySecrets.Hash(browser), document);
        Assert.Equal(new[] { "identity.json", "identity.json.lock" },
            Directory.GetFiles(state.DirectoryPath).Select(Path.GetFileName).Order().ToArray());
    }

    [Fact]
    public async Task UnusableFilePathDoesNotBecomeAnEmptyStore()
    {
        using var state = new IdentityTestState();
        Directory.CreateDirectory(state.DataFile);
        Error(await state.Service().ResolveAsync(IdentitySecrets.NewToken(), new()),
            "identity_unavailable", 503);
        Assert.True(Directory.Exists(state.DataFile));
    }
}
