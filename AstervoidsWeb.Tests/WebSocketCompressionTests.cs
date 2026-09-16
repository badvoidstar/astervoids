using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using AstervoidsWeb.Hubs;
using FluentAssertions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Covers <c>UseWebSocketCompression</c>: that permessage-deflate options actually
/// reach the accept context SignalR builds, and that nothing outside the hub path is
/// affected.
///
/// <para>
/// The linkage is the part worth pinning. SignalR constructs the
/// <see cref="WebSocketAcceptContext"/> internally and exposes no option for
/// compression, so the middleware relies on SignalR accepting through
/// <see cref="IHttpWebSocketFeature"/>. That is an implementation detail of the
/// framework, and these tests fail loudly if a future version stops honouring it.
/// </para>
///
/// <para>
/// <b>Why there is a real-Kestrel test here.</b> The <see cref="AcceptRecorder"/> tests
/// below run on <c>TestServer</c>, which populates <see cref="IHttpWebSocketFeature"/>
/// in the outer pipeline itself. Kestrel does not: it supplies only
/// <c>IHttpUpgradeFeature</c>, and the WebSocket feature is created by
/// <c>UseWebSockets</c>. <c>MapHub</c> installs its own <c>UseWebSockets</c> inside the
/// endpoint sub-pipeline, which runs after all outer middleware — so if the application
/// does not call <c>UseWebSockets</c> itself, the decorator finds no feature to wrap and
/// silently does nothing, while every TestServer assertion still passes. That exact
/// false positive shipped once. The handshake tests assert the negotiated
/// <c>Sec-WebSocket-Extensions</c> response header over a real socket, which is the only
/// signal that distinguishes the two cases.
/// </para>
/// </summary>
[Collection(LatencySensitiveCollection.Name)]
public class WebSocketCompressionTests
{
    /// <summary>
    /// Records the accept context after the production decorator has mutated it, by
    /// installing itself ahead of the application's own pipeline. Because it wraps the
    /// real feature first, the production decorator ends up wrapping this one, so the
    /// forwarded call carries whatever the production code set.
    /// </summary>
    private sealed class AcceptRecorder : IStartupFilter
    {
        public WebSocketAcceptContext? Observed { get; private set; }
        public int Accepts { get; private set; }

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) =>
            app =>
            {
                app.Use(async (context, nextMiddleware) =>
                {
                    var inner = context.Features.Get<IHttpWebSocketFeature>();
                    if (inner is not null)
                    {
                        context.Features.Set<IHttpWebSocketFeature>(
                            new RecordingFeature(inner, this));
                    }

                    await nextMiddleware(context);
                });
                next(app);
            };

        private sealed class RecordingFeature(IHttpWebSocketFeature inner, AcceptRecorder owner)
            : IHttpWebSocketFeature
        {
            public bool IsWebSocketRequest => inner.IsWebSocketRequest;

            public Task<WebSocket> AcceptAsync(WebSocketAcceptContext context)
            {
                owner.Observed = context;
                owner.Accepts++;
                return inner.AcceptAsync(context);
            }
        }
    }

    private sealed class Factory(AcceptRecorder recorder) : AstervoidsWebFactory
    {
        protected override void ConfigureAstervoidsWeb(IWebHostBuilder builder) =>
            builder.ConfigureServices(services =>
                services.AddSingleton<IStartupFilter>(recorder));
    }

    private static async Task<AcceptRecorder> ConnectAsync(string path)
    {
        var recorder = new AcceptRecorder();
        using var factory = new Factory(recorder);
        // Materialises the pipeline; the client below drives the real middleware chain.
        _ = factory.CreateClient();

        var client = factory.Server.CreateWebSocketClient();
        var uri = new Uri(factory.Server.BaseAddress, path);
        try
        {
            using var socket = await client.ConnectAsync(uri, CancellationToken.None);
        }
        catch (Exception)
        {
            // A non-WebSocket endpoint simply refuses the upgrade. The assertions below
            // are about what the accept path did, not about whether a socket opened.
        }

        return recorder;
    }

    [Fact]
    public async Task HubSocket_NegotiatesPermessageDeflate_WithBoundedWindowAndContextTakeover()
    {
        var recorder = await ConnectAsync("/sessionHub");

        recorder.Accepts.Should().Be(1,
            "SignalR must still accept through IHttpWebSocketFeature for the middleware to reach it");
        recorder.Observed.Should().NotBeNull();
        recorder.Observed!.DangerousEnableCompression.Should().BeTrue();
        recorder.Observed.DisableServerContextTakeover.Should().BeFalse(
            "most of the saving is cross-message: without a shared window the ratio falls from ~0.38 to ~0.86");
        recorder.Observed.ServerMaxWindowBits.Should()
            .Be(WebSocketCompressionExtensions.ServerMaxWindowBits);
    }

    [Fact]
    public async Task NonHubRequests_AreNotDecorated()
    {
        var recorder = await ConnectAsync("/api/ping");

        recorder.Observed.Should().BeNull(
            "no WebSocket is accepted outside the hub path");
    }

    [Fact]
    public async Task Decorator_ForwardsToTheServerFeature_AfterSettingOptions()
    {
        // Guards the decorator in isolation: it must delegate, not replace.
        var forwarded = new List<WebSocketAcceptContext>();
        var inner = new DelegatingFeature(forwarded);
        var decorated = new WebSocketCompressionExtensions.CompressingWebSocketFeature(inner);
        var context = new WebSocketAcceptContext { SubProtocol = "messagepack" };

        decorated.IsWebSocketRequest.Should().BeTrue();
        await decorated.AcceptAsync(context);

        forwarded.Should().ContainSingle().Which.Should().BeSameAs(context);
        context.SubProtocol.Should().Be("messagepack", "the sub-protocol must survive");
        context.DangerousEnableCompression.Should().BeTrue();
        context.ServerMaxWindowBits.Should()
            .Be(WebSocketCompressionExtensions.ServerMaxWindowBits);
    }

    private sealed class DelegatingFeature(List<WebSocketAcceptContext> forwarded)
        : IHttpWebSocketFeature
    {
        public bool IsWebSocketRequest => true;

        public Task<WebSocket> AcceptAsync(WebSocketAcceptContext context)
        {
            forwarded.Add(context);
            return Task.FromResult<WebSocket>(null!);
        }
    }

    // -------------------------------------------------------------------------
    // Real-Kestrel handshake. See the type remarks for why TestServer cannot cover
    // this: it provides IHttpWebSocketFeature where Kestrel does not.
    // -------------------------------------------------------------------------

    /// <summary>
    /// Runs the production pipeline on a real Kestrel listener bound to an ephemeral
    /// port, so the actual RFC 7692 handshake can be observed.
    /// </summary>
    private sealed class KestrelFactory : AstervoidsWebFactory
    {
        private IHost? _kestrel;

        public string Origin { get; private set; } = "";

        protected override IHost CreateHost(IHostBuilder builder)
        {
            // Build the TestServer host first: WebApplicationFactory's internals cast
            // the returned host's server to TestServer, so it must be built before the
            // builder is switched over to Kestrel.
            var testHost = builder.Build();

            builder.ConfigureWebHost(web =>
                web.UseKestrel(options => options.Listen(IPAddress.Loopback, 0)));
            _kestrel = builder.Build();
            // Kestrel must start first, or the two hosts race over shared startup state.
            _kestrel.Start();

            Origin = _kestrel.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!
                .Addresses.Single();

            testHost.Start();
            return testHost;
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing) _kestrel?.Dispose();
        }
    }

    /// <summary>
    /// Performs a raw WebSocket upgrade and returns the response head. Raw TCP is used
    /// because <c>ClientWebSocket</c> exposes no way to read the negotiated extensions.
    /// </summary>
    private static async Task<string> HandshakeAsync(
        string origin, string path, string? offeredExtensions)
    {
        var uri = new Uri(origin);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var client = new TcpClient();
        await client.ConnectAsync(uri.Host, uri.Port, cts.Token);

        await using var stream = client.GetStream();
        var key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var request =
            $"GET {path} HTTP/1.1\r\n" +
            $"Host: {uri.Host}:{uri.Port}\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            $"Sec-WebSocket-Key: {key}\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            (offeredExtensions is null
                ? "" : $"Sec-WebSocket-Extensions: {offeredExtensions}\r\n") +
            "\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(request), cts.Token);

        var head = new StringBuilder();
        var buffer = new byte[1024];
        while (!head.ToString().Contains("\r\n\r\n", StringComparison.Ordinal))
        {
            var read = await stream.ReadAsync(buffer, cts.Token);
            if (read == 0) break;
            head.Append(Encoding.ASCII.GetString(buffer, 0, read));
        }
        return head.ToString();
    }

    [Fact]
    public async Task HubHandshake_OverRealKestrel_NegotiatesDeflateWithTheTunedWindow()
    {
        using var factory = new KestrelFactory();
        _ = factory.CreateClient(); // forces host startup, which assigns Origin

        var response = await HandshakeAsync(
            factory.Origin, "/sessionHub", "permessage-deflate; client_max_window_bits");

        response.Should().StartWith("HTTP/1.1 101",
            "the hub must still accept the upgrade");
        response.Should().Contain("permessage-deflate",
            "if this fails the decorator found no IHttpWebSocketFeature to wrap — "
            + "check that UseWebSockets runs in the outer pipeline before MapHub");
        response.Should().Contain(
            $"server_max_window_bits={WebSocketCompressionExtensions.ServerMaxWindowBits}");
        response.Should().NotContain("server_no_context_takeover",
            "most of the saving is cross-message: without a shared window the ratio falls from ~0.38 to ~0.86");
    }

    [Fact]
    public async Task HubHandshake_WhenClientOffersNoExtension_StaysUncompressed()
    {
        using var factory = new KestrelFactory();
        _ = factory.CreateClient(); // forces host startup, which assigns Origin

        var response = await HandshakeAsync(factory.Origin, "/sessionHub", null);

        response.Should().StartWith("HTTP/1.1 101");
        response.Should().NotContain("permessage-deflate",
            "compression is negotiated, never imposed");
    }
}
