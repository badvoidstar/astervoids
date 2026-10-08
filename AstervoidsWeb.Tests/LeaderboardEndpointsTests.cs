using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AstervoidsWeb.Identity;
using AstervoidsWeb.Leaderboards;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace AstervoidsWeb.Tests;

public class LeaderboardEndpointsTests : IClassFixture<LeaderboardEndpointsTests.Factory>
{
    private const string QueryPath = "/api/leaderboard/query";
    private const string ScoresPath = "/api/leaderboard/scores";
    private const string StaticOrigin = "https://leaderboard-test.azurestaticapps.net";
    private const string ScoreJson = """
        {"playerId":"00000001-0000-0000-0000-000000000001","runId":"00000002-0000-0000-0000-000000000001","score":0,"wave":1,"teamSize":1,"aspectRatio":1,"difficulty":0.65}
        """;
    private readonly Factory _factory;

    public LeaderboardEndpointsTests(Factory factory) => _factory = factory;

    public sealed class Factory : AstervoidsWebFactory
    {
        private readonly IdentityTestState _state = new();
        public string DataFile => _state.DataFile;
        public Dictionary<string, string?> Overrides { get; } = new();
        public string EnvironmentName { get; set; } = "Development";
        public bool ConfigureOrigins { get; set; } = true;
        internal ILeaderboardStore? Store { get; set; }
        internal IIdentityStore? IdentityStore { get; set; }
        internal IdentityLogCollector Logs { get; } = new();

        protected override void ConfigureAstervoidsWeb(IWebHostBuilder builder)
        {
            builder.UseEnvironment(EnvironmentName);
            builder.ConfigureAppConfiguration((_, configuration) =>
            {
                var values = new Dictionary<string, string?>
                {
                    ["Identity:Provider"] = "File",
                    ["Identity:DataFile"] = _state.DataFile,
                    ["Identity:AllowFileInProduction"] = "false",
                    ["Identity:RateLimit:BrowserPermitLimit"] = "120",
                    ["Identity:RateLimit:IpPermitLimit"] = "600",
                    ["Identity:RateLimit:WindowSeconds"] = "60",
                    ["Leaderboard:MaxEntries"] = "50",
                    ["Leaderboard:RateLimit:QueryIpPermitLimit"] = "120",
                    ["Leaderboard:RateLimit:ScoreBrowserPermitLimit"] = "120",
                    ["Leaderboard:RateLimit:ScoreIpPermitLimit"] = "600",
                    ["Leaderboard:RateLimit:WindowSeconds"] = "60",
                    ["Region:ApexHostname"] = ConfigureOrigins ? "https://example.com" : "",
                    ["Region:AdditionalAllowedOrigins:0"] = ConfigureOrigins ? StaticOrigin : "",
                    ["Region:Regions:0:Hostname"] = ConfigureOrigins ? "https://region.example.com/" : ""
                };
                foreach (var pair in Overrides)
                    values[pair.Key] = pair.Value;
                configuration.AddInMemoryCollection(values);
            });
            builder.ConfigureServices(services =>
            {
                services.AddSingleton<ILoggerProvider>(Logs);
                if (Store is not null)
                {
                    services.RemoveAll<ILeaderboardStore>();
                    services.AddSingleton(Store);
                }
                if (IdentityStore is not null)
                {
                    services.RemoveAll<IIdentityStore>();
                    services.AddSingleton(IdentityStore);
                }
            });
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing)
                _state.Dispose();
        }
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"teamSize\":null,\"aspect\":null,\"difficulty\":null}")]
    public async Task PublicQueriesNeedNoCredentialsOrIdentityStorageAndReturnAnyByDefault(string json)
    {
        using var factory = new Factory { IdentityStore = new ThrowingIdentityStore("must-not-be-read") };
        using var client = factory.CreateClient();
        using var request = Request(QueryPath, null, json);
        using var response = await client.SendAsync(request);
        var body = await Body(response, 200);
        Assert.Equal("{\"entries\":[],\"limit\":50,\"maxTeamSize\":4}", body.GetRawText());
        Assert.False(File.Exists(factory.DataFile));
        Assert.False(File.Exists(factory.DataFile + ".lock"));
        Assert.False(File.Exists(LeaderboardHosting.CompanionDataFile(factory.DataFile)));
        using var ignoredCredential = await Send(client, QueryPath, "not-a-browser-credential", new { });
        await Body(ignoredCredential, 200);
    }

    [Fact]
    public async Task ScoreApiDerivesTheTagRecordsZeroAndReturnsConfiguredLimitsWithoutPrivateIdentityData()
    {
        using var factory = new Factory();
        factory.Overrides["Leaderboard:MaxEntries"] = "3";
        factory.Overrides["Session:MaxMembersPerSession"] = "7";
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        var binding = await CreatePlayer(client, browser, "Exact_Tag");
        var score = LeaderboardTestState.Submission(binding.Identity!.Id, score: 0, teamSize: 7,
            aspectRatio: 2, difficulty: 0.42);
        using var recorded = await Send(client, ScoresPath, browser, score);
        Assert.Equal("{\"recorded\":true}", (await Body(recorded, 200)).GetRawText());
        using var repeated = await Send(client, ScoresPath, browser, score);
        await Body(repeated, 200);
        using var query = await Send(client, QueryPath, null, new { teamSize = 7, aspect = "landscape", difficulty = 0.42 });
        var body = await Body(query, 200);
        Assert.Equal(3, body.GetProperty("limit").GetInt32());
        Assert.Equal(7, body.GetProperty("maxTeamSize").GetInt32());
        var entry = Assert.Single(body.GetProperty("entries").EnumerateArray());
        Assert.Equal(new[] { "aspect", "difficulty", "name", "rank", "score", "teamSize", "wave" },
            entry.EnumerateObject().Select(property => property.Name).Order().ToArray());
        Assert.Equal("Exact_Tag", entry.GetProperty("name").GetString());
        Assert.Equal(0u, entry.GetProperty("score").GetUInt32());
        Assert.Equal(1, entry.GetProperty("rank").GetInt32());
        Assert.DoesNotContain(browser, body.GetRawText());
        Assert.DoesNotContain(binding.Identity.Id.ToString(), body.GetRawText());
        Assert.DoesNotContain(score.RunId.ToString(), body.GetRawText());
        using var invalidTeam = await Send(client, ScoresPath, browser, score with { TeamSize = 8 });
        await Error(invalidTeam, 400, "invalid_request");
    }

    [Fact]
    public async Task ForgedAndGuestBindingsCannotWriteAndWrongPlayerHasAnExplicitConflict()
    {
        using var factory = new Factory();
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        var binding = await CreatePlayer(client, browser);
        var score = LeaderboardTestState.Submission(binding.Identity!.Id);
        using var forged = await Send(client, ScoresPath, IdentitySecrets.NewToken(), score);
        await Error(forged, 409, "identity_required");
        var guest = IdentitySecrets.NewToken();
        using var resolvedGuest = await Send(client, "/api/identity/resolve", guest, new { });
        await Body(resolvedGuest, 200);
        using var guestScore = await Send(client, ScoresPath, guest, score);
        await Error(guestScore, 409, "identity_required");
        using var wrongPlayer = await Send(client, ScoresPath, browser, score with { PlayerId = Guid.NewGuid() });
        await Error(wrongPlayer, 409, "binding_changed");
        using var query = await Send(client, QueryPath, null, new { });
        Assert.Empty((await Body(query, 200)).GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task AutomationIsNeverVisibleToPublicQueriesEvenWithoutMarkerAndAfterInvitationRecovery()
    {
        using var factory = new Factory();
        using var automatedClient = factory.CreateClient();
        using var ordinaryClient = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        automatedClient.DefaultRequestHeaders.Add(IdentityHosting.TestIdentityHeader, "true");
        var binding = await CreatePlayer(automatedClient, browser, "SameTag");
        Assert.True(binding.Identity!.ExcludeFromLeaderboards);
        automatedClient.DefaultRequestHeaders.Remove(IdentityHosting.TestIdentityHeader);
        var request = LeaderboardTestState.Submission(binding.Identity.Id, score: 0);
        using var before = await Send(ordinaryClient, QueryPath, null, new { });
        Assert.Empty((await Body(before, 200)).GetProperty("entries").EnumerateArray());
        using var initial = await Send(automatedClient, ScoresPath, browser, request);
        await Error(initial, 403, "leaderboard_ineligible");
        Assert.False(File.Exists(LeaderboardHosting.CompanionDataFile(factory.DataFile)));

        var ordinaryBrowser = IdentitySecrets.NewToken();
        var ordinary = await CreatePlayer(ordinaryClient, ordinaryBrowser, "SameTag");
        Assert.False(ordinary.Identity!.ExcludeFromLeaderboards);
        using var realScore = await Send(ordinaryClient, ScoresPath, ordinaryBrowser,
            LeaderboardTestState.Submission(ordinary.Identity.Id, score: 23));
        await Body(realScore, 200);
        foreach (var score in new uint[] { 1, 100, uint.MaxValue })
        {
            using var checkpoint = await Send(automatedClient, ScoresPath, browser, request with { Score = score });
            await Error(checkpoint, 403, "leaderboard_ineligible");
            await AssertOnlyOrdinaryScore();
        }

        using var self = await Send(automatedClient, "/api/identity/invites/self", browser,
            new SelfInviteRequest(IdentityTestState.Expect(binding)));
        var selfToken = (await Body(self, 200)).GetProperty("inviteToken").GetString()!;
        using var friend = await Send(automatedClient, "/api/identity/invites", browser,
            new CreateInviteRequest(Guid.NewGuid()));
        var friendToken = (await Body(friend, 201)).GetProperty("inviteToken").GetString()!;
        foreach (var token in new[] { selfToken, friendToken })
        {
            var otherBrowser = IdentitySecrets.NewToken();
            using var resolved = await Send(ordinaryClient, "/api/identity/resolve", otherBrowser, new { inviteToken = token });
            var view = (await Body(resolved, 200)).Deserialize<ResolveIdentityReply>(IdentityJson.Options)!;
            using var accepted = await Send(ordinaryClient, "/api/identity/invites/accept", otherBrowser,
                new AcceptInviteRequest(Guid.NewGuid(), token, view.Invite!.Etag,
                    IdentityTestState.Expect(view.Binding), view.Invite.State == "pending" ? "Friend" : null));
            var inherited = (await Body(accepted, 200)).Deserialize<BindingReply>(IdentityJson.Options)!.Binding;
            Assert.True(inherited.Identity!.ExcludeFromLeaderboards);
            using var forged = await Send(ordinaryClient, ScoresPath, otherBrowser,
                request with { PlayerId = inherited.Identity.Id, Score = uint.MaxValue });
            await Error(forged, 403, "leaderboard_ineligible");
            await AssertOnlyOrdinaryScore();
        }
        Assert.DoesNotContain(factory.Logs.Messages, message =>
            message.Contains(browser, StringComparison.Ordinal) || message.Contains(selfToken, StringComparison.Ordinal)
            || message.Contains(friendToken, StringComparison.Ordinal) || message.Contains("SameTag", StringComparison.Ordinal));

        async Task AssertOnlyOrdinaryScore()
        {
            using var query = await Send(ordinaryClient, QueryPath, null, new { });
            var row = Assert.Single((await Body(query, 200)).GetProperty("entries").EnumerateArray());
            Assert.Equal(23u, row.GetProperty("score").GetUInt32());
            Assert.Equal("SameTag", row.GetProperty("name").GetString());
        }
    }

    [Fact]
    public async Task ExcludedSubmissionsStillUseTheExistingIdentityAndScoreRateLimits()
    {
        using var factory = new Factory();
        factory.Overrides["Identity:RateLimit:BrowserPermitLimit"] = "1";
        factory.Overrides["Leaderboard:RateLimit:ScoreBrowserPermitLimit"] = "1";
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add(IdentityHosting.TestIdentityHeader, "true");
        var browser = IdentitySecrets.NewToken();
        var player = await CreatePlayer(client, browser);
        using var invitation = await Send(client, "/api/identity/invites", browser, new { requestId = Guid.NewGuid() });
        await Limited(invitation, 60);
        var request = LeaderboardTestState.Submission(player.Identity!.Id);
        using var excluded = await Send(client, ScoresPath, browser, request);
        await Error(excluded, 403, "leaderboard_ineligible");
        using var limited = await Send(client, ScoresPath, browser, request);
        await Limited(limited, 60);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB")]
    public async Task ScoreWritesRequireOneCanonicalBrowserHeader(string? browser)
    {
        using var client = _factory.CreateClient();
        using var request = Request(ScoresPath, browser, ScoreJson);
        using var response = await client.SendAsync(request);
        await Error(response, 401, "invalid_browser_credential");
    }

    [Fact]
    public async Task RepeatedBrowserHeaderIsRejectedBeforeScoreStorage()
    {
        using var client = _factory.CreateClient();
        using var request = Request(ScoresPath, IdentitySecrets.NewToken(), ScoreJson);
        request.Headers.TryAddWithoutValidation(IdentityHosting.BrowserHeader, IdentitySecrets.NewToken());
        using var response = await client.SendAsync(request);
        await Error(response, 401, "invalid_browser_credential");
    }

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{")]
    [InlineData("{\"teamSize\":null,\"teamSize\":null}")]
    [InlineData("{\"unknown\":\"private\"}")]
    [InlineData("{\"TeamSize\":1}")]
    [InlineData("{\"teamSize\":\"1\"}")]
    [InlineData("{\"teamSize\":0}")]
    [InlineData("{\"teamSize\":5}")]
    [InlineData("{\"teamSize\":1.5}")]
    [InlineData("{\"aspect\":\"Portrait\"}")]
    [InlineData("{\"aspect\":\"any\"}")]
    [InlineData("{\"aspect\":0}")]
    [InlineData("{\"difficulty\":\"0.2\"}")]
    [InlineData("{\"difficulty\":0.009}")]
    [InlineData("{\"difficulty\":2.001}")]
    [InlineData("{\"difficulty\":1e309}")]
    [InlineData("{\"difficulty\":null,}")]
    [InlineData("{\"limit\":500}")]
    [InlineData("{\"playerId\":\"not-accepted\"}")]
    public async Task MalformedAmbiguousOrUnmappedQueryJsonIsSafelyRejected(string json)
    {
        using var client = _factory.CreateClient();
        using var request = Request(QueryPath, null, json);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData("playerId", "\"00000000-0000-0000-0000-000000000000\"")]
    [InlineData("playerId", "\"not-a-guid\"")]
    [InlineData("playerId", "null")]
    [InlineData("runId", "\"00000000-0000-0000-0000-000000000000\"")]
    [InlineData("runId", "\"\"")]
    [InlineData("score", "-1")]
    [InlineData("score", "4294967296")]
    [InlineData("score", "1.5")]
    [InlineData("score", "\"1\"")]
    [InlineData("wave", "0")]
    [InlineData("wave", "-1")]
    [InlineData("wave", "2147483648")]
    [InlineData("wave", "1.5")]
    [InlineData("teamSize", "0")]
    [InlineData("teamSize", "5")]
    [InlineData("teamSize", "1.5")]
    [InlineData("aspectRatio", "0")]
    [InlineData("aspectRatio", "-1")]
    [InlineData("aspectRatio", "1e309")]
    [InlineData("aspectRatio", "\"NaN\"")]
    [InlineData("difficulty", "0.009")]
    [InlineData("difficulty", "2.001")]
    [InlineData("difficulty", "1e309")]
    [InlineData("difficulty", "\"0.2\"")]
    public async Task InvalidScoreFieldsNeverReachIdentityOrLeaderboardWrites(string field, string replacement)
    {
        var json = JsonNode.Parse(ScoreJson)!;
        json[field] = JsonNode.Parse(replacement);
        using var client = _factory.CreateClient();
        using var request = Request(ScoresPath, IdentitySecrets.NewToken(), json.ToJsonString());
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData("playerId")]
    [InlineData("runId")]
    [InlineData("score")]
    [InlineData("wave")]
    [InlineData("teamSize")]
    [InlineData("aspectRatio")]
    [InlineData("difficulty")]
    public async Task EveryScoreFieldIsRequired(string field)
    {
        var json = JsonNode.Parse(ScoreJson)!.AsObject();
        json.Remove(field);
        using var client = _factory.CreateClient();
        using var request = Request(ScoresPath, IdentitySecrets.NewToken(), json.ToJsonString());
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData(",\"name\":\"Forged\"")]
    [InlineData(",\"tag\":\"Forged\"")]
    [InlineData(",\"score\":0")]
    [InlineData(",\"Score\":0")]
    [InlineData(",\"binding\":{\"identityId\":\"forged\"}")]
    [InlineData(",\"excludeFromLeaderboards\":false")]
    [InlineData(",\"excludeFromLeaderboards\":true")]
    public async Task NamesDuplicatesAndUnmappedScoreFieldsAreNeverAccepted(string extra)
    {
        using var client = _factory.CreateClient();
        using var request = Request(ScoresPath, IdentitySecrets.NewToken(), ScoreJson[..^1] + extra + "}");
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("text/plain")]
    [InlineData("application/json; charset=utf-16")]
    public async Task JsonUtf8ContentTypeIsRequired(string? contentType)
    {
        using var client = _factory.CreateClient();
        using var request = Request(QueryPath, null, "{}");
        request.Content!.Headers.ContentType = contentType is null ? null : MediaTypeHeaderValue.Parse(contentType);
        using var response = await client.SendAsync(request);
        await Error(response, 415, "invalid_request");
    }

    [Fact]
    public async Task CompressedRequestsAreRejectedAndExactSizeBoundaryIsAccepted()
    {
        using var client = _factory.CreateClient();
        using var compressed = Request(QueryPath, null, "{}");
        compressed.Content!.Headers.ContentEncoding.Add("gzip");
        using var rejected = await client.SendAsync(compressed);
        await Error(rejected, 415, "invalid_request");
        using var request = Request(QueryPath, null, "{}" + new string(' ', LeaderboardEndpoints.MaximumBodyBytes - 2));
        request.Content!.Headers.ContentType = new("application/vnd.astervoids+json");
        using var accepted = await client.SendAsync(request);
        await Body(accepted, 200);
    }

    [Theory]
    [InlineData(QueryPath, false)]
    [InlineData(QueryPath, true)]
    [InlineData(ScoresPath, false)]
    [InlineData(ScoresPath, true)]
    public async Task BodyLimitAlsoBoundsUnknownLengthStreams(string path, bool streaming)
    {
        using var client = _factory.CreateClient();
        using var request = Request(path, IdentitySecrets.NewToken(), "{}");
        var bytes = Encoding.UTF8.GetBytes(new string(' ', LeaderboardEndpoints.MaximumBodyBytes) + "{}");
        request.Content = streaming ? new UnknownLengthContent(bytes) : new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new("application/json");
        using var response = await client.SendAsync(request);
        await Error(response, 413, "invalid_request");
    }

    [Theory]
    [InlineData(QueryPath, "GET")]
    [InlineData(ScoresPath, "GET")]
    [InlineData(QueryPath, "PUT")]
    [InlineData("/api/leaderboard/unknown", "POST")]
    [InlineData("/api/leaderboard/query?difficulty=0.2", "POST")]
    [InlineData("/api/leaderboard/scores?playerId=private", "POST")]
    public async Task OnlyKnownPostsWithoutQueryStringsAreAllowed(string path, string method)
    {
        using var client = _factory.CreateClient();
        using var request = Request(path, IdentitySecrets.NewToken(), "{}");
        request.Method = new(method);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ConfiguredOriginsStayIsolatedFromRegionalFallback(bool configured)
    {
        using var factory = new Factory { ConfigureOrigins = configured };
        using var client = factory.CreateClient();
        using var preflight = new HttpRequestMessage(HttpMethod.Options, QueryPath);
        preflight.Headers.Add("Origin", "https://untrusted.example.com");
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        preflight.Headers.Add("Access-Control-Request-Headers", "content-type");
        using var permission = await client.SendAsync(preflight);
        Private(permission);
        Assert.False(permission.Headers.Contains("Access-Control-Allow-Origin"));
        using var request = Request(QueryPath, null, "{}");
        request.Headers.Add("Origin", "https://untrusted.example.com");
        using var rejected = await client.SendAsync(request);
        await Error(rejected, 400, "invalid_request");
        Assert.False(rejected.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("https://example.com/private")]
    [InlineData("https://example.com/?value=not-allowed")]
    public async Task MalformedOriginsAreRejected(string origin)
    {
        using var client = _factory.CreateClient();
        using var request = Request(QueryPath, null, "{}");
        request.Headers.Add("Origin", origin);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData(QueryPath)]
    [InlineData(ScoresPath)]
    public async Task ExplicitPreflightsAndActualErrorsHaveNoCredentialsCachingOrCompression(string path)
    {
        using var client = _factory.CreateClient();
        using var preflight = new HttpRequestMessage(HttpMethod.Options, path);
        preflight.Headers.Add("Origin", StaticOrigin);
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        preflight.Headers.Add("Access-Control-Request-Headers", "content-type,x-astervoids-browser,x-astervoids-test-identity");
        using var permission = await client.SendAsync(preflight);
        Assert.Equal(HttpStatusCode.NoContent, permission.StatusCode);
        Private(permission);
        Assert.Equal(StaticOrigin, Assert.Single(permission.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("POST", Assert.Single(permission.Headers.GetValues("Access-Control-Allow-Methods")));
        Assert.Equal(IdentityHosting.PreflightMaxAge.TotalSeconds.ToString(CultureInfo.InvariantCulture),
            Assert.Single(permission.Headers.GetValues("Access-Control-Max-Age")));
        Assert.False(permission.Headers.Contains("Access-Control-Allow-Credentials"));
        using var actual = Request(path, "invalid", "{}");
        actual.Headers.Add("Origin", StaticOrigin);
        using var response = await client.SendAsync(actual);
        if (path == QueryPath)
            await Body(response, 200);
        else
            await Error(response, 401, "invalid_browser_credential");
        Assert.Equal(StaticOrigin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.False(response.Headers.Contains("Access-Control-Max-Age"));
    }

    [Fact]
    public async Task SameOriginWithoutManifestWorksAndForwardedHeadersDoNotAuthorizeAnotherOrigin()
    {
        using var factory = new Factory { ConfigureOrigins = false };
        using var client = factory.CreateClient();
        using var sameOrigin = Request(QueryPath, null, "{}");
        sameOrigin.Headers.Add("Origin", "http://localhost");
        using var accepted = await client.SendAsync(sameOrigin);
        await Body(accepted, 200);
        using var forwarded = Request(QueryPath, null, "{}");
        forwarded.Headers.Add("Origin", "https://untrusted.example.com");
        forwarded.Headers.Add("X-Forwarded-Host", "untrusted.example.com");
        forwarded.Headers.Add("X-Forwarded-Proto", "https");
        using var rejected = await client.SendAsync(forwarded);
        await Error(rejected, 400, "invalid_request");
    }

    [Fact]
    public async Task QueryAndScoreBudgetsAreIndependentAndDoNotReplaceIdentityMutationLimits()
    {
        using var factory = new Factory();
        factory.Overrides["Identity:RateLimit:BrowserPermitLimit"] = "2";
        factory.Overrides["Leaderboard:RateLimit:ScoreBrowserPermitLimit"] = "1";
        factory.Overrides["Leaderboard:RateLimit:QueryIpPermitLimit"] = "1";
        factory.Overrides["Leaderboard:RateLimit:WindowSeconds"] = "31";
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        var binding = await CreatePlayer(client, browser);
        var score = LeaderboardTestState.Submission(binding.Identity!.Id);
        using var firstScore = await Send(client, ScoresPath, browser, score);
        await Body(firstScore, 200);
        using var firstQuery = await Send(client, QueryPath, null, new { });
        await Body(firstQuery, 200);
        using var identityInvite = await Send(client, "/api/identity/invites", browser, new { requestId = Guid.NewGuid() });
        await Body(identityInvite, 201);

        using var limitedScore = Request(ScoresPath, browser, JsonSerializer.Serialize(score, IdentityJson.Options));
        limitedScore.Headers.Add("Origin", StaticOrigin);
        using var scoreResponse = await client.SendAsync(limitedScore);
        await Limited(scoreResponse, 31);
        Assert.Contains("Retry-After", string.Join(",", scoreResponse.Headers.GetValues("Access-Control-Expose-Headers")));
        using var queryResponse = await Send(client, QueryPath, IdentitySecrets.NewToken(), new { });
        await Limited(queryResponse, 31);
        using var identityResponse = await Send(client, "/api/identity/invites", browser, new { requestId = Guid.NewGuid() });
        await Limited(identityResponse, 60);
        using var resolve = await Send(client, "/api/identity/resolve", browser, new { });
        await Body(resolve, 200);
        using var self = await Send(client, "/api/identity/invites/self", browser,
            new SelfInviteRequest(IdentityTestState.Expect(binding)));
        await Body(self, 200);
        using var ping = await client.GetAsync("/api/ping");
        Assert.Equal(HttpStatusCode.OK, ping.StatusCode);
    }

    [Fact]
    public async Task ScoreIpBudgetCannotBeBypassedByRotatingBrowsersOrForwardedIps()
    {
        using var factory = new Factory();
        factory.Overrides["Leaderboard:RateLimit:ScoreIpPermitLimit"] = "1";
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        var first = await CreatePlayer(client, browser);
        using var accepted = await Send(client, ScoresPath, browser, LeaderboardTestState.Submission(first.Identity!.Id));
        await Body(accepted, 200);
        var otherBrowser = IdentitySecrets.NewToken();
        var other = await CreatePlayer(client, otherBrowser);
        using var request = Request(ScoresPath, otherBrowser,
            JsonSerializer.Serialize(LeaderboardTestState.Submission(other.Identity!.Id), IdentityJson.Options));
        request.Headers.Add("X-Forwarded-For", "192.0.2.1");
        using var rejected = await client.SendAsync(request);
        await Limited(rejected, 60);
        using var query = await Send(client, QueryPath, null, new { });
        await Body(query, 200);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("501")]
    [InlineData("invalid")]
    public async Task InvalidMaximumIsNotSilentlyClampedAndDoesNotBreakStartup(string maximum)
    {
        using var factory = new Factory();
        factory.Overrides["Leaderboard:MaxEntries"] = maximum;
        using var client = factory.CreateClient();
        using var response = await Send(client, QueryPath, null, new { });
        await Error(response, 503, "leaderboard_unavailable");
        using var ping = await client.GetAsync("/api/ping");
        Assert.Equal(HttpStatusCode.OK, ping.StatusCode);
        await CreatePlayer(client, IdentitySecrets.NewToken());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProductionFileAccessRequiresTheExistingIdentityOptIn(bool optIn)
    {
        using var factory = new Factory { EnvironmentName = "Production" };
        factory.Overrides["Identity:AllowFileInProduction"] = optIn.ToString();
        using var client = factory.CreateClient();
        using var response = await Send(client, QueryPath, null, new { });
        if (optIn)
            await Body(response, 200);
        else
            await Error(response, 503, "leaderboard_unavailable");
        using var ping = await client.GetAsync("/api/ping");
        Assert.Equal(HttpStatusCode.OK, ping.StatusCode);
    }

    [Theory]
    [InlineData("Unknown", "")]
    [InlineData("AzureTable", "")]
    [InlineData("AzureTable", "http://table.example.com")]
    [InlineData("AzureTable", "https://table.example.com/?credential=disallowed")]
    public async Task InvalidPrimaryProviderNeverFallsBackToLocalScores(string provider, string endpoint)
    {
        using var factory = new Factory();
        factory.Overrides["Identity:Provider"] = provider;
        factory.Overrides["Identity:TableEndpoint"] = endpoint;
        using var client = factory.CreateClient();
        using var response = await Send(client, QueryPath, null, new { });
        await Error(response, 503, "leaderboard_unavailable");
        Assert.False(File.Exists(LeaderboardHosting.CompanionDataFile(factory.DataFile)));
    }

    [Fact]
    public async Task UnexpectedLeaderboardErrorsAreSanitizedWithoutDisablingIdentityOrGameHealth()
    {
        var privateDetail = "private-storage-diagnostic-" + Guid.NewGuid().ToString("N");
        using var factory = new Factory { Store = new ThrowingLeaderboardStore(privateDetail) };
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        var binding = await CreatePlayer(client, browser);
        using var query = Request(QueryPath, null, "{}");
        query.Headers.Add("Origin", StaticOrigin);
        using var queryResponse = await client.SendAsync(query);
        await Error(queryResponse, 503, "leaderboard_unavailable");
        Assert.Equal(StaticOrigin, Assert.Single(queryResponse.Headers.GetValues("Access-Control-Allow-Origin")));
        using var scoreResponse = await Send(client, ScoresPath, browser,
            LeaderboardTestState.Submission(binding.Identity!.Id));
        await Error(scoreResponse, 503, "leaderboard_unavailable");
        using var resolve = await Send(client, "/api/identity/resolve", browser, new { });
        await Body(resolve, 200);
        using var ping = await client.GetAsync("/api/ping");
        Assert.Equal(HttpStatusCode.OK, ping.StatusCode);
        using var regions = await client.GetAsync("/api/regions");
        Assert.Equal(HttpStatusCode.OK, regions.StatusCode);
        Assert.DoesNotContain(factory.Logs.Messages, message =>
            message.Contains(privateDetail, StringComparison.Ordinal) || message.Contains(browser, StringComparison.Ordinal));
    }

    private static async Task<BrowserBinding> CreatePlayer(HttpClient client, string browser, string tag = "Pilot")
    {
        using var resolved = await Send(client, "/api/identity/resolve", browser, new { });
        var binding = (await Body(resolved, 200)).GetProperty("binding");
        using var created = await Send(client, "/api/identity/root", browser, new
        {
            requestId = Guid.NewGuid(), expectedBinding = new { identityId = (Guid?)null, etag = binding.GetProperty("etag").GetString() }, tag
        });
        return (await Body(created, 201)).Deserialize<BindingReply>(IdentityJson.Options)!.Binding;
    }

    private static HttpRequestMessage Request(string path, string? browser, string json)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        if (browser is not null)
            request.Headers.TryAddWithoutValidation(IdentityHosting.BrowserHeader, browser);
        request.Headers.AcceptEncoding.ParseAdd("br, gzip");
        return request;
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, string path, string? browser, object body)
    {
        using var request = Request(path, browser, JsonSerializer.Serialize(body, IdentityJson.Options));
        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> Body(HttpResponseMessage response, int status)
    {
        Assert.Equal(status, (int)response.StatusCode);
        Private(response);
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task Error(HttpResponseMessage response, int status, string code) =>
        Assert.Equal("{\"error\":{\"code\":\"" + code + "\"}}", (await Body(response, status)).GetRawText());

    private static async Task Limited(HttpResponseMessage response, int maximum)
    {
        await Error(response, 429, "rate_limited");
        Assert.True(int.TryParse(Assert.Single(response.Headers.GetValues("Retry-After")), out var seconds));
        Assert.InRange(seconds, 1, maximum);
    }

    private static void Private(HttpResponseMessage response)
    {
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Empty(response.Content.Headers.ContentEncoding);
        Assert.False(response.Headers.Contains("Set-Cookie"));
    }

    private sealed class UnknownLengthContent(byte[] bytes) : HttpContent
    {
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            stream.WriteAsync(bytes).AsTask();
    }

    private sealed class ThrowingLeaderboardStore(string detail) : ILeaderboardStore
    {
        public Task<LeaderboardRecord?> ReadAsync(Guid playerId, Guid runId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
        public Task<bool> TryCommitAsync(
            LeaderboardRecord? previous, LeaderboardRecord next, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
        public Task<IReadOnlyList<LeaderboardRecord>> QueryAsync(
            LeaderboardQueryRequest query, int limit, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
    }

    private sealed class ThrowingIdentityStore(string detail) : IIdentityStore
    {
        public Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
        public Task<bool> TryCommitAsync(IReadOnlyList<IdentityWrite> writes, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
    }
}
