using System.Net.WebSockets;
using Microsoft.AspNetCore.Http.Features;

namespace AstervoidsWeb.Hubs;

/// <summary>
/// Enables WebSocket <c>permessage-deflate</c> (RFC 7692) on the SignalR hub endpoint.
///
/// <para>
/// SignalR's own options (<c>WebSocketOptions</c> in
/// <c>Microsoft.AspNetCore.Http.Connections</c>) expose only <c>SubProtocolSelector</c>
/// and <c>CloseTimeout</c>, so compression cannot be switched on there. It is reachable
/// anyway: SignalR's WebSocket transport accepts through
/// <see cref="IHttpWebSocketFeature"/> like any other consumer, so decorating that
/// feature for the hub path lets the accept options be set without SignalR's
/// cooperation and without touching the hub, the DTOs, or the client.
/// </para>
///
/// <para>
/// This is a pure transport-layer concern: the wire contract, the game-agnostic hub
/// surface, and every client layer above it are unchanged. Payload byte counts reported
/// by <c>srvmon</c> are pre-compression estimates and therefore do not move.
/// </para>
///
/// <para><b>Why it pays.</b> Hot-path hub frames are envelope-dominated — roughly
/// two-thirds SignalR/hub metadata — and that metadata is near-identical on every
/// message, which is exactly what a shared compression window exploits. Measured on
/// captured traffic: about −60% downlink and −54% uplink, for ~1.6 µs of server CPU per
/// message.</para>
///
/// <para><b>Context takeover must stay enabled.</b> The saving comes almost entirely
/// from the window persisting across messages; disabling takeover measured a 0.99
/// ratio, i.e. no compression at all. The cost is one deflate stream per direction per
/// connection held for the connection's lifetime.</para>
///
/// <para><b>Window size.</b> <see cref="ServerMaxWindowBits"/> 12 (4 KiB) measured
/// <i>better</i> than the 15-bit default (0.358 vs 0.366) on this traffic — the frames
/// are small and their redundancy is local — while using an eighth of the memory per
/// connection. Bounding it matters because context takeover means the window is
/// retained per connection.</para>
///
/// <para><b>Security.</b> <c>DangerousEnableCompression</c> is named for the
/// CRIME/BREACH class of attack: an attacker who can inject chosen plaintext into the
/// same compression stream as a secret can recover the secret from compressed lengths.
/// The stream here carries session reconnect tokens alongside gameplay state. The
/// exposure is accepted because the hub carries no cross-origin ambient authority —
/// there are no cookies and no bearer credentials on the socket, so an attacker cannot
/// make a victim's browser inject chosen plaintext into the victim's stream the way
/// BREACH does against cookie-authenticated HTTP.</para>
///
/// <para><b>Deployment.</b> If an intermediary (Azure Container Apps' Envoy ingress)
/// strips <c>Sec-WebSocket-Extensions</c>, negotiation simply does not happen and
/// traffic stays uncompressed; nothing breaks either way.</para>
/// </summary>
public static class WebSocketCompressionExtensions
{
    /// <summary>
    /// Deflate history window, in bits. 12 = 4 KiB. See the type remarks.
    /// </summary>
    public const int ServerMaxWindowBits = 12;

    /// <summary>
    /// Negotiates <c>permessage-deflate</c> for WebSocket upgrades under
    /// <paramref name="path"/>. Must be registered before the endpoint that accepts
    /// the socket. Requests outside the path are passed through untouched.
    /// </summary>
    public static IApplicationBuilder UseWebSocketCompression(
        this IApplicationBuilder app, PathString path)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Branch on the path so neither the WebSocket middleware nor this decorator
        // costs anything on ordinary requests — /api/ping in particular is held to a
        // tight latency budget because it backs cold-start RTT measurement.
        return app.UseWhen(
            context => context.Request.Path.StartsWithSegments(path),
            branch =>
            {
                // Kestrel supplies only IHttpUpgradeFeature; IHttpWebSocketFeature is
                // created by UseWebSockets. MapHub runs its own UseWebSockets inside
                // the endpoint's sub-pipeline, which executes after all outer
                // middleware — so without this call there is no feature here to
                // decorate, the decorator below silently does nothing, and no
                // compression is negotiated. WebSocketMiddleware skips creation when a
                // feature is already present, so SignalR's copy becomes a no-op and the
                // decorator ends up wrapping the feature SignalR truly accepts through.
                branch.UseWebSockets();

                branch.Use(async (context, next) =>
                {
                    var webSockets = context.Features.Get<IHttpWebSocketFeature>();
                    if (webSockets is not null && webSockets.IsWebSocketRequest)
                    {
                        context.Features.Set<IHttpWebSocketFeature>(
                            new CompressingWebSocketFeature(webSockets));
                    }

                    await next(context);
                });
            });
    }

    /// <summary>
    /// Forwards to the server's real feature, setting the compression options on the
    /// accept context on the way through. SignalR builds that context itself, so this
    /// is the only place the options can be injected.
    /// </summary>
    internal sealed class CompressingWebSocketFeature(IHttpWebSocketFeature inner)
        : IHttpWebSocketFeature
    {
        public bool IsWebSocketRequest => inner.IsWebSocketRequest;

        public Task<WebSocket> AcceptAsync(WebSocketAcceptContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            context.DangerousEnableCompression = true;
            // The window must persist across messages or the ratio collapses to ~1.0.
            context.DisableServerContextTakeover = false;
            context.ServerMaxWindowBits = ServerMaxWindowBits;

            return inner.AcceptAsync(context);
        }
    }
}
