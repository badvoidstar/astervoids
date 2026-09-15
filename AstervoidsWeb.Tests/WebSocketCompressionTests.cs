using System.Net.WebSockets;
using AstervoidsWeb.Hubs;
using FluentAssertions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
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
/// The test host does not implement RFC 7692 itself, so this asserts the negotiated
/// options rather than compressed bytes; the ratio itself was measured separately
/// against captured traffic.
/// </para>
/// </summary>
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
            "the ratio collapses to ~1.0 without a window shared across messages");
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
}
