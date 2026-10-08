using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AstervoidsWeb.Configuration;
using AstervoidsWeb.Identity;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AstervoidsWeb.Tests;

public class IdentityEndpointsTests : IClassFixture<IdentityEndpointsTests.Factory>
{
    public static TheoryData<string> OverLimitTags => new()
    {
        new string('A', SharedConfiguration.Current.IdentityTagMaxLength + 1)
    };

    private const string StaticOrigin = "https://identity-test.azurestaticapps.net";
    private readonly Factory _factory;

    public IdentityEndpointsTests(Factory factory) => _factory = factory;

    public sealed class Factory : AstervoidsWebFactory
    {
        private readonly IdentityTestState _state = new();
        public Dictionary<string, string?> Overrides { get; } = new();
        public string EnvironmentName { get; set; } = "Development";
        public bool ConfigureOrigins { get; set; } = true;
        internal IIdentityStore? Store { get; set; }
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
                    ["Identity:PromptOnRoot"] = "true",
                    ["Identity:RateLimit:BrowserPermitLimit"] = "120",
                    ["Identity:RateLimit:IpPermitLimit"] = "600",
                    ["Identity:RateLimit:WindowSeconds"] = "60",
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
                    services.RemoveAll<IIdentityStore>();
                    services.AddSingleton(Store);
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

    [Fact]
    public async Task SharedConfigurationDrivesIdentityValidationAndGeneratedBrowserAsset()
    {
        using var client = _factory.CreateClient();
        using var configuration = JsonDocument.Parse(await client.GetStringAsync("/shared-config.json"));
        Assert.Equal(new[] { "identityTagMaxLength" }, Names(configuration.RootElement));
        var maximum = configuration.RootElement.GetProperty("identityTagMaxLength").GetInt32();
        Assert.InRange(maximum, 1, byte.MaxValue);

        var script = await client.GetStringAsync("/js/shared-config-data.js");
        const string prefix = "globalThis.ASTERVOIDS_SHARED_CONFIG = Object.freeze(";
        Assert.StartsWith(prefix, script);
        Assert.EndsWith(");", script.TrimEnd());
        using var generated = JsonDocument.Parse(script.TrimEnd()[prefix.Length..^2]);
        Assert.Equal(maximum, generated.RootElement.GetProperty("identityTagMaxLength").GetInt32());
        Assert.True(IdentitySecrets.IsTag(new string('A', maximum)));
        Assert.False(IdentitySecrets.IsTag(new string('A', maximum + 1)));

        var browser = IdentitySecrets.NewToken();
        using var resolved = await Send(client, "/resolve", browser, new { });
        var binding = (await Body(resolved, 200)).GetProperty("binding");
        using var rejected = await Send(client, "/root", browser,
            new { requestId = Guid.NewGuid(), expectedBinding = Expected(binding), tag = new string('A', maximum + 1) });
        Assert.Equal("invalid_tag", (await Body(rejected, 400)).GetProperty("error").GetProperty("code").GetString());
        using var accepted = await Send(client, "/root", browser,
            new { requestId = Guid.NewGuid(), expectedBinding = Expected(binding), tag = new string('A', maximum) });
        Assert.Equal(maximum, (await Body(accepted, 201)).GetProperty("binding")
            .GetProperty("identity").GetProperty("tag").GetString()!.Length);
    }

    [Theory]
    [InlineData("Pilot_1", "Friend")]
    [InlineData("A_b-123456", "Friend_123")]
    public async Task ResolveRootInviteClaimAndSelfHaveExactShapesAndPrivateResponses(
        string rootTag, string friendTag)
    {
        using var client = _factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        using var resolveResponse = await Send(client, "/resolve", browser, new { });
        var resolved = await Body(resolveResponse, 200);
        Assert.Equal(new[] { "binding", "invite", "promptOnRoot" }, Names(resolved));
        Assert.Equal(JsonValueKind.Null, resolved.GetProperty("invite").ValueKind);
        Assert.True(resolved.GetProperty("promptOnRoot").GetBoolean());
        var binding = resolved.GetProperty("binding");
        Assert.Equal(new[] { "etag", "identity", "revision" }, Names(binding));
        Assert.Equal(JsonValueKind.Null, binding.GetProperty("identity").ValueKind);
        Assert.Equal(0, binding.GetProperty("revision").GetInt64());

        var rootRequest = new { requestId = Guid.NewGuid(), expectedBinding = Expected(binding), tag = rootTag };
        using var rootResponse = await Send(client, "/root", browser, rootRequest);
        var root = await Body(rootResponse, 201);
        Assert.Single(root.EnumerateObject());
        var named = root.GetProperty("binding");
        var identity = named.GetProperty("identity");
        Assert.Equal(new[] { "id", "tag" }, Names(identity));
        Assert.NotEqual(Guid.Empty, identity.GetProperty("id").GetGuid());
        Assert.Equal(rootTag, identity.GetProperty("tag").GetString());
        using var rootRetry = await Send(client, "/root", browser, rootRequest);
        Assert.Equal(root.GetRawText(), (await Body(rootRetry, 201)).GetRawText());

        using var inviteResponse = await Send(client, "/invites", browser, new { requestId = Guid.NewGuid() });
        var invited = await Body(inviteResponse, 201);
        Assert.Single(invited.EnumerateObject());
        var token = invited.GetProperty("inviteToken").GetString()!;
        Assert.True(IdentitySecrets.IsToken(token));
        var friendBrowser = IdentitySecrets.NewToken();
        using var friendResolve = await Send(client, "/resolve", friendBrowser, new { inviteToken = token });
        var friend = await Body(friendResolve, 200);
        var invitation = friend.GetProperty("invite");
        Assert.Equal(new[] { "etag", "identityId", "state", "tag" }, Names(invitation));
        Assert.Equal("pending", invitation.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, invitation.GetProperty("tag").ValueKind);

        using var acceptedResponse = await Send(client, "/invites/accept", friendBrowser, new
        {
            requestId = Guid.NewGuid(), inviteToken = token,
            expectedInviteEtag = invitation.GetProperty("etag").GetString(),
            expectedBinding = Expected(friend.GetProperty("binding")), tag = friendTag
        });
        var accepted = (await Body(acceptedResponse, 200)).GetProperty("binding");
        Assert.Equal(friendTag, accepted.GetProperty("identity").GetProperty("tag").GetString());
        using var selfResponse = await Send(client, "/invites/self", friendBrowser,
            new { expectedBinding = Expected(accepted) });
        Assert.Equal(token, (await Body(selfResponse, 200)).GetProperty("inviteToken").GetString());
        Assert.DoesNotContain(browser, resolved.GetRawText());
        Assert.DoesNotContain(friendBrowser, accepted.GetRawText());
        Assert.False(resolveResponse.Headers.Contains("Set-Cookie"));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task CreationOnlyExclusionAcceptsExplicitJsonOrAutomationHeaderAndPersistsWithoutEither(
        bool header, bool body)
    {
        using var factory = new Factory();
        using var client = factory.CreateClient();
        if (header) client.DefaultRequestHeaders.Add(IdentityHosting.TestIdentityHeader, "true");
        var browser = IdentitySecrets.NewToken();
        using var resolved = await Send(client, "/resolve", browser, new { });
        var binding = (await Body(resolved, 200)).GetProperty("binding");
        var requestId = Guid.NewGuid();
        var root = new
        {
            requestId, expectedBinding = Expected(binding), tag = "Policy", excludeFromLeaderboards = body
        };
        using var created = await Send(client, "/root", browser, root);
        var createdBody = await Body(created, 201);
        var identity = createdBody.GetProperty("binding").GetProperty("identity");
        Assert.Equal(header || body, identity.TryGetProperty("excludeFromLeaderboards", out var excluded));
        if (header || body) Assert.True(excluded.GetBoolean());
        using var replay = await Send(client, "/root", browser, root);
        Assert.Equal(createdBody.GetRawText(), (await Body(replay, 201)).GetRawText());
        client.DefaultRequestHeaders.Remove(IdentityHosting.TestIdentityHeader);
        using var later = await Send(client, "/resolve", browser, new { });
        Assert.Equal(identity.GetRawText(),
            (await Body(later, 200)).GetProperty("binding").GetProperty("identity").GetRawText());
        if (header && !body)
        {
            using var changedPolicy = await Send(client, "/root", browser, root);
            await Error(changedPolicy, 409, "request_reused");
        }
    }

    [Theory]
    [InlineData("false")]
    [InlineData("True")]
    [InlineData("1")]
    [InlineData("true,false")]
    public async Task AutomationHeaderIsAnExactOptInRatherThanAnAmbiguousOverride(string marker)
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        request.Headers.TryAddWithoutValidation(IdentityHosting.TestIdentityHeader, marker);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Fact]
    public async Task AnActualEmptyAutomationHeaderIsRejectedByValidation()
    {
        // HttpClient omits empty header values, so test this at the HTTP middleware boundary.
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/identity/resolve";
        context.Request.Method = "POST";
        context.Request.ContentType = "application/json";
        context.Request.Headers[IdentityHosting.BrowserHeader] = IdentitySecrets.NewToken();
        context.Request.Headers[IdentityHosting.TestIdentityHeader] = "";
        context.Response.Body = new MemoryStream();
        var middleware = new IdentityValidationMiddleware(_ =>
            throw new InvalidOperationException("Invalid headers must not reach identity operations."));
        await middleware.InvokeAsync(context, new IdentityOrigins(Options.Create(new RegionSettings())));
        Assert.Equal(400, context.Response.StatusCode);
    }

    [Fact]
    public async Task RepeatedAutomationHeadersAreRejected()
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        request.Headers.TryAddWithoutValidation(IdentityHosting.TestIdentityHeader, new[] { "true", "true" });
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData("null")]
    [InlineData("\"true\"")]
    [InlineData("1")]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("true,\"excludeFromLeaderboards\":false")]
    public async Task ExclusionJsonRemainsStrictAndDoesNotAcceptDuplicateFields(string value)
    {
        using var client = _factory.CreateClient();
        foreach (var path in new[] { "/root", "/invites" })
        {
            var root = path == "/root" ? ",\"tag\":\"Pilot\",\"expectedBinding\":{\"identityId\":null,\"etag\":\"b1\"}" : "";
            using var request = Request(path, IdentitySecrets.NewToken(),
                "{\"requestId\":\"" + Guid.NewGuid() + "\"" + root + ",\"excludeFromLeaderboards\":" + value + "}");
            using var response = await client.SendAsync(request);
            await Error(response, 400, "invalid_request");
        }
    }

    [Fact]
    public async Task AutomationCannotReclassifyAnExistingPlayerOrPendingInvitation()
    {
        using var factory = new Factory();
        using var client = factory.CreateClient();
        var original = IdentitySecrets.NewToken();
        await CreateRoot(client, original);
        using var inviteResponse = await Send(client, "/invites", original, new { requestId = Guid.NewGuid() });
        var pendingToken = (await Body(inviteResponse, 201)).GetProperty("inviteToken").GetString();
        using var resolve = await Send(client, "/resolve", original, new { });
        var originalBinding = (await Body(resolve, 200)).GetProperty("binding");
        using var self = await Send(client, "/invites/self", original,
            new { expectedBinding = Expected(originalBinding) });
        var selfToken = (await Body(self, 200)).GetProperty("inviteToken").GetString();

        client.DefaultRequestHeaders.Add(IdentityHosting.TestIdentityHeader, "true");
        using var rename = await Send(client, "/root", original, new
        {
            requestId = Guid.NewGuid(), expectedBinding = Expected(originalBinding), tag = "Pilot",
            excludeFromLeaderboards = true
        });
        await Error(rename, 409, "binding_changed");
        foreach (var token in new[] { selfToken, pendingToken })
        {
            var browser = IdentitySecrets.NewToken();
            using var resolving = await Send(client, "/resolve", browser, new { inviteToken = token });
            var view = await Body(resolving, 200);
            var invitation = view.GetProperty("invite");
            var accepting = new
            {
                requestId = Guid.NewGuid(), inviteToken = token,
                expectedInviteEtag = invitation.GetProperty("etag").GetString(),
                expectedBinding = Expected(view.GetProperty("binding")),
                tag = invitation.GetProperty("state").GetString() == "pending" ? "Friend" : null
            };
            using var accepted = await Send(client, "/invites/accept", browser, accepting);
            Assert.False((await Body(accepted, 200)).GetProperty("binding").GetProperty("identity")
                .TryGetProperty("excludeFromLeaderboards", out _));
        }
        using var unchanged = await Send(client, "/resolve", original, new { });
        Assert.Equal(originalBinding.GetRawText(), (await Body(unchanged, 200)).GetProperty("binding").GetRawText());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB")]
    public async Task InvalidBrowserHeaderReturnsOnlyConstantError(string? browser)
    {
        using var client = _factory.CreateClient();
        using var response = await Send(client, "/resolve", browser, new { });
        await Error(response, 401, "invalid_browser_credential");
    }

    [Fact]
    public async Task RepeatedBrowserHeaderIsNotAccepted()
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        request.Headers.TryAddWithoutValidation(IdentityHosting.BrowserHeader, IdentitySecrets.NewToken());
        using var response = await client.SendAsync(request);
        await Error(response, 401, "invalid_browser_credential");
    }

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{")]
    [InlineData("{\"inviteToken\":false}")]
    [InlineData("{\"inviteToken\":\"bad\"}")]
    [InlineData("{\"inviteToken\":null,\"inviteToken\":null}")]
    [InlineData("{\"unknown\":\"private value\"}")]
    [InlineData("{\"InviteToken\":null}")]
    [InlineData("{\"inviteToken\":null,}")]
    public async Task MalformedOrAmbiguousJsonIsSafelyRejected(string json)
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), json);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData("/root", "{}")]
    [InlineData("/root", "{\"requestId\":\"not-a-guid\",\"tag\":\"Pilot\",\"expectedBinding\":{\"identityId\":null,\"etag\":\"x\"}}")]
    [InlineData("/root", "{\"requestId\":\"00000000-0000-0000-0000-000000000000\",\"tag\":\"Pilot\",\"expectedBinding\":{\"identityId\":null,\"etag\":\"x\"}}")]
    [InlineData("/invites", "{}")]
    [InlineData("/invites/accept", "{}")]
    [InlineData("/invites/self", "{\"expectedBinding\":{\"etag\":\"x\"}}")]
    [InlineData("/invites/self", "{\"expectedBinding\":{\"identityId\":\"invalid\",\"etag\":\"x\"}}")]
    [InlineData("/invites/self", "{\"expectedBinding\":null}")]
    [InlineData("/resolve", "{\"excludeFromLeaderboards\":true}")]
    [InlineData("/invites/accept", "{\"excludeFromLeaderboards\":true}")]
    [InlineData("/invites/self", "{\"excludeFromLeaderboards\":true}")]
    public async Task MissingRequiredOrMalformedFieldsAreInvalidRequests(string path, string json)
    {
        using var client = _factory.CreateClient();
        using var request = Request(path, IdentitySecrets.NewToken(), json);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Theory]
    [InlineData("")]
    [MemberData(nameof(OverLimitTags))]
    [InlineData("P ilot")]
    [InlineData("é")]
    [InlineData(null)]
    public async Task InvalidRootTagHasSpecificErrorAndLeavesBrowserUnbound(string? tag)
    {
        using var client = _factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        using var resolve = await Send(client, "/resolve", browser, new { });
        var before = (await Body(resolve, 200)).GetProperty("binding");
        using var response = await Send(client, "/root", browser, new
        {
            requestId = Guid.NewGuid(), expectedBinding = Expected(before), tag
        });
        await Error(response, 400, "invalid_tag");
        using var afterResponse = await Send(client, "/resolve", browser, new { });
        Assert.Equal(before.GetRawText(), (await Body(afterResponse, 200)).GetProperty("binding").GetRawText());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("text/plain")]
    [InlineData("application/json; charset=utf-16")]
    public async Task JsonContentTypeIsRequired(string? contentType)
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        request.Content!.Headers.ContentType = contentType is null ? null : MediaTypeHeaderValue.Parse(contentType);
        using var response = await client.SendAsync(request);
        await Error(response, 415, "invalid_request");
    }

    [Fact]
    public async Task CompressedRequestBodyIsRejected()
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        request.Content!.Headers.ContentEncoding.Add("gzip");
        using var response = await client.SendAsync(request);
        await Error(response, 415, "invalid_request");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OversizedBodiesAreBoundedIncludingUnknownContentLength(bool streaming)
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        var bytes = Encoding.UTF8.GetBytes(new string(' ', IdentityEndpoints.MaximumBodyBytes) + "{}");
        request.Content = streaming ? new UnknownLengthContent(bytes) : new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new("application/json");
        using var response = await client.SendAsync(request);
        await Error(response, 413, "invalid_request");
    }

    [Fact]
    public async Task KnownLengthBoundaryAndJsonSuffixAreAccepted()
    {
        using var client = _factory.CreateClient();
        using var request = Request("/resolve", IdentitySecrets.NewToken(),
            "{}" + new string(' ', IdentityEndpoints.MaximumBodyBytes - 2));
        request.Content!.Headers.ContentType = new("application/vnd.astervoids+json");
        using var response = await client.SendAsync(request);
        await Body(response, 200);
    }

    [Theory]
    [InlineData("/resolve", "GET")]
    [InlineData("/unknown", "POST")]
    [InlineData("/resolve?inviteToken=not-accepted-here", "POST")]
    public async Task WrongMethodPathOrQueryNeverExposesData(string path, string method)
    {
        using var client = _factory.CreateClient();
        using var request = Request(path, IdentitySecrets.NewToken(), "{}");
        request.Method = new(method);
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
    }

    [Fact]
    public async Task UnknownInviteReturnsPrivateNotFound()
    {
        using var client = _factory.CreateClient();
        using var response = await Send(client, "/resolve", IdentitySecrets.NewToken(),
            new { inviteToken = IdentitySecrets.NewToken() });
        await Error(response, 404, "invite_not_found");
    }

    [Theory]
    [InlineData("https://example.com", "/root")]
    [InlineData("https://example.com", "/resolve")]
    [InlineData("https://region.example.com", "/root")]
    [InlineData("https://region.example.com", "/resolve")]
    [InlineData(StaticOrigin, "/root")]
    [InlineData(StaticOrigin, "/resolve")]
    public async Task IdentityPreflightCachesOnlyExplicitOriginsMethodsAndHeaders(string origin, string path)
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/api/identity" + path);
        request.Headers.Add("Origin", origin);
        request.Headers.Add("Access-Control-Request-Method", "POST");
        request.Headers.Add("Access-Control-Request-Headers", "content-type,x-astervoids-browser,x-astervoids-test-identity");
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Private(response);
        Assert.Equal(origin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("POST", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Methods")));
        Assert.Equal(IdentityHosting.PreflightMaxAge.TotalSeconds.ToString(CultureInfo.InvariantCulture),
            Assert.Single(response.Headers.GetValues("Access-Control-Max-Age")));
        Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
        var headers = string.Join(",", response.Headers.GetValues("Access-Control-Allow-Headers")).ToLowerInvariant();
        Assert.Contains("x-astervoids-browser", headers);
        Assert.Contains("x-astervoids-test-identity", headers);
        Assert.Contains("content-type", headers);
        Assert.DoesNotContain("*", headers);
    }

    [Fact]
    public async Task PreflightPermissionDoesNotCacheIdentityDataOrAuthorizeAnInvalidCredential()
    {
        using var client = _factory.CreateClient();
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/api/identity/resolve");
        preflight.Headers.Add("Origin", StaticOrigin);
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        preflight.Headers.Add("Access-Control-Request-Headers", "content-type,x-astervoids-browser");
        using var permission = await client.SendAsync(preflight);
        Assert.Equal(HttpStatusCode.NoContent, permission.StatusCode);
        Assert.True(permission.Headers.Contains("Access-Control-Max-Age"));

        using var actual = Request("/resolve", "invalid", "{}");
        actual.Headers.Add("Origin", StaticOrigin);
        using var rejected = await client.SendAsync(actual);
        await Error(rejected, 401, "invalid_browser_credential");
        Assert.Equal(StaticOrigin, Assert.Single(rejected.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.False(rejected.Headers.Contains("Access-Control-Max-Age"));

        using var valid = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        valid.Headers.Add("Origin", StaticOrigin);
        using var resolved = await client.SendAsync(valid);
        await Body(resolved, 200);
        Assert.False(resolved.Headers.Contains("Access-Control-Max-Age"));
    }

    [Fact]
    public async Task CorsDoesNotPermitArbitraryRequestHeaders()
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/api/identity/root");
        request.Headers.Add("Origin", StaticOrigin);
        request.Headers.Add("Access-Control-Request-Method", "POST");
        request.Headers.Add("Access-Control-Request-Headers", "content-type,x-arbitrary-secret");
        using var response = await client.SendAsync(request);
        Private(response);
        Assert.DoesNotContain("x-arbitrary-secret",
            string.Join(",", response.Headers.GetValues("Access-Control-Allow-Headers")).ToLowerInvariant());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task IdentityCorsNeverInheritsPermissiveRegionalFallback(bool configureOrigins)
    {
        using var factory = new Factory { ConfigureOrigins = configureOrigins };
        using var client = factory.CreateClient();
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/api/identity/resolve");
        preflight.Headers.Add("Origin", "https://untrusted.example.com");
        preflight.Headers.Add("Access-Control-Request-Method", "POST");
        preflight.Headers.Add("Access-Control-Request-Headers", "content-type,x-astervoids-browser");
        using var response = await client.SendAsync(preflight);
        Private(response);
        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
        Assert.False(response.Headers.Contains("Access-Control-Max-Age"));

        using var actual = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        actual.Headers.Add("Origin", "https://untrusted.example.com");
        using var rejected = await client.SendAsync(actual);
        await Error(rejected, 400, "invalid_request");
        Assert.False(rejected.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task SameOriginWorksWithoutManifestAndConfiguredCorsIncludesErrors()
    {
        using var localFactory = new Factory { ConfigureOrigins = false };
        using var localClient = localFactory.CreateClient();
        using var local = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        local.Headers.Add("Origin", "http://localhost");
        using var localResponse = await localClient.SendAsync(local);
        await Body(localResponse, 200);

        using var client = _factory.CreateClient();
        using var invalid = Request("/resolve", "invalid", "{}");
        invalid.Headers.Add("Origin", StaticOrigin);
        using var invalidResponse = await client.SendAsync(invalid);
        await Error(invalidResponse, 401, "invalid_browser_credential");
        Assert.Equal(StaticOrigin,
            Assert.Single(invalidResponse.Headers.GetValues("Access-Control-Allow-Origin")));
    }

    [Theory]
    [InlineData("https://ca-web-preview.test-env.westus2.azurecontainerapps.io")]
    [InlineData("https://preview.example.com")]
    [InlineData("https://preview-region.example.com")]
    public async Task ConfiguredHttpsIngressOriginsSupportIdentityWhenTheBackendReceivesHttp(string origin)
    {
        using var factory = new Factory { ConfigureOrigins = false, EnvironmentName = "Production" };
        factory.Overrides["Identity:AllowFileInProduction"] = "true";
        factory.Overrides["Region:AdditionalAllowedOrigins:0"] =
            "https://ca-web-preview.test-env.westus2.azurecontainerapps.io";
        factory.Overrides["Region:AdditionalAllowedOrigins:1"] = "https://preview.example.com";
        factory.Overrides["Region:AdditionalAllowedOrigins:2"] = "https://preview-region.example.com";
        using var client = factory.CreateClient(new()
        {
            BaseAddress = new Uri($"http://{new Uri(origin).Authority}"),
            AllowAutoRedirect = false
        });
        client.DefaultRequestHeaders.Add("Origin", origin);
        client.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https");

        var browser = IdentitySecrets.NewToken();
        await CreateRoot(client, browser);
        using var response = await Send(client, "/resolve", browser, new { });
        var identity = (await Body(response, 200)).GetProperty("binding").GetProperty("identity");
        Assert.Equal("Pilot", identity.GetProperty("tag").GetString());
        Assert.NotEqual(Guid.Empty, identity.GetProperty("id").GetGuid());
        Assert.Equal(origin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
    }

    [Fact]
    public async Task ForwardedHeadersDoNotAuthorizeAnUnconfiguredHttpsOrigin()
    {
        using var factory = new Factory { ConfigureOrigins = false };
        using var client = factory.CreateClient(new()
        {
            BaseAddress = new Uri("http://untrusted.example.com"),
            AllowAutoRedirect = false
        });
        using var request = Request("/resolve", IdentitySecrets.NewToken(), "{}");
        request.Headers.Add("Origin", "https://untrusted.example.com");
        request.Headers.Add("X-Forwarded-Proto", "https");
        request.Headers.Add("X-Forwarded-Host", "untrusted.example.com");
        using var response = await client.SendAsync(request);
        await Error(response, 400, "invalid_request");
        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProductionFileProviderRequiresExplicitOptInWithoutBreakingOtherApis(bool optIn)
    {
        using var factory = new Factory { EnvironmentName = "Production" };
        factory.Overrides["Identity:AllowFileInProduction"] = optIn.ToString();
        using var client = factory.CreateClient();
        using var response = await Send(client, "/resolve", IdentitySecrets.NewToken(), new { });
        if (optIn)
            await Body(response, 200);
        else
            await Error(response, 503, "identity_unavailable");
        using var ping = await client.GetAsync("/api/ping");
        Assert.Equal(HttpStatusCode.OK, ping.StatusCode);
    }

    [Theory]
    [InlineData("AzureTable", "")]
    [InlineData("AzureTable", "http://example.com")]
    [InlineData("AzureTable", "https://example.com/?credential=not-allowed")]
    [InlineData("Unknown", "")]
    public async Task InvalidProviderConfigurationIsUnavailableRatherThanFallingBack(string provider, string endpoint)
    {
        using var factory = new Factory();
        factory.Overrides["Identity:Provider"] = provider;
        factory.Overrides["Identity:TableEndpoint"] = endpoint;
        using var client = factory.CreateClient();
        using var response = await Send(client, "/resolve", IdentitySecrets.NewToken(), new { });
        await Error(response, 503, "identity_unavailable");
    }

    [Fact]
    public async Task UnexpectedStorageErrorsNeverEchoOrLogPrivateMaterial()
    {
        var privateDetail = "private-diagnostic-" + Guid.NewGuid().ToString("N");
        using var factory = new Factory { Store = new FailingStore(privateDetail) };
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        using var request = Request("/resolve", browser, "{}");
        request.Headers.Add("Origin", StaticOrigin);
        using var response = await client.SendAsync(request);
        await Error(response, 503, "identity_unavailable");
        Assert.Equal(StaticOrigin, Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.DoesNotContain(factory.Logs.Messages, message =>
            message.Contains(privateDetail, StringComparison.Ordinal)
            || message.Contains(browser, StringComparison.Ordinal));
    }

    [Fact]
    public async Task PerBrowserCreationLimitReturnsIntegerRetryAfter()
    {
        using var factory = new Factory();
        factory.Overrides["Identity:RateLimit:BrowserPermitLimit"] = "1";
        using var client = factory.CreateClient();
        var browser = IdentitySecrets.NewToken();
        await CreateRoot(client, browser);
        using var request = Request("/invites", browser,
            JsonSerializer.Serialize(new { requestId = Guid.NewGuid() }));
        request.Headers.Add("Origin", StaticOrigin);
        using var response = await client.SendAsync(request);
        await Error(response, 429, "rate_limited");
        Assert.True(int.TryParse(Assert.Single(response.Headers.GetValues("Retry-After")), out var retry));
        Assert.InRange(retry, 1, 60);
        Assert.Contains("Retry-After", string.Join(",", response.Headers.GetValues("Access-Control-Expose-Headers")));
        using var resolve = await Send(client, "/resolve", browser, new { });
        await Body(resolve, 200);
    }

    [Fact]
    public async Task PerIpCreationLimitCannotBeBypassedByRotatingBrowserCredentials()
    {
        using var factory = new Factory();
        factory.Overrides["Identity:RateLimit:IpPermitLimit"] = "1";
        using var client = factory.CreateClient();
        await CreateRoot(client, IdentitySecrets.NewToken());
        var another = IdentitySecrets.NewToken();
        using var resolve = await Send(client, "/resolve", another, new { });
        var binding = (await Body(resolve, 200)).GetProperty("binding");
        using var response = await Send(client, "/root", another,
            new { requestId = Guid.NewGuid(), expectedBinding = Expected(binding), tag = "Pilot" });
        await Error(response, 429, "rate_limited");
    }

    private static async Task CreateRoot(HttpClient client, string browser)
    {
        using var resolve = await Send(client, "/resolve", browser, new { });
        var binding = (await Body(resolve, 200)).GetProperty("binding");
        using var root = await Send(client, "/root", browser,
            new { requestId = Guid.NewGuid(), expectedBinding = Expected(binding), tag = "Pilot" });
        await Body(root, 201);
    }

    private static HttpRequestMessage Request(string path, string? browser, string json)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/identity" + path)
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

    private static object Expected(JsonElement binding) => new
    {
        identityId = binding.GetProperty("identity").ValueKind == JsonValueKind.Null
            ? (Guid?)null : binding.GetProperty("identity").GetProperty("id").GetGuid(),
        etag = binding.GetProperty("etag").GetString()
    };

    private static async Task<JsonElement> Body(HttpResponseMessage response, int status)
    {
        Assert.Equal(status, (int)response.StatusCode);
        Private(response);
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task Error(HttpResponseMessage response, int status, string code)
    {
        var body = await Body(response, status);
        Assert.Equal("{\"error\":{\"code\":\"" + code + "\"}}", body.GetRawText());
    }

    private static void Private(HttpResponseMessage response)
    {
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    private static string[] Names(JsonElement element) => element.EnumerateObject()
        .Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();

    private sealed class UnknownLengthContent(byte[] bytes) : HttpContent
    {
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            stream.WriteAsync(bytes).AsTask();
    }

    private sealed class FailingStore(string detail) : IIdentityStore
    {
        public Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
        public Task<bool> TryCommitAsync(IReadOnlyList<IdentityWrite> writes, CancellationToken cancellationToken) =>
            throw new InvalidOperationException(detail);
    }
}

internal sealed class IdentityLogCollector : ILoggerProvider
{
    public ConcurrentQueue<string> Messages { get; } = new();
    public ILogger CreateLogger(string categoryName) => new Collector(Messages);
    public void Dispose() { }

    private sealed class Collector(ConcurrentQueue<string> messages) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter) =>
            messages.Enqueue(formatter(state, exception) + (exception?.ToString() ?? ""));
    }
}
