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
/// message, which is exactly what a shared compression window exploits. Replaying
/// <c>OnObjectsUpdated</c> frames built by the production hub protocol and positional
/// codec, the payload compresses to ~0.30 at a batch of one and ~0.38 at a full
/// seven-object steady-state batch. Per <i>packet</i>
/// the saving is nearer −55% than −62%, because the ~46 B of IP/TCP/WebSocket framing
/// rides uncompressed; size bandwidth arguments off the packet figure, not the payload
/// ratio.</para>
///
/// <para><b>What it costs.</b> ~12 µs of server CPU per message to deflate (p99.9
/// ~35 µs, bounded) and ~1.4 µs for the client to inflate. Deflate runs once per
/// connection rather than once per broadcast, so a six-way fan-out costs ~76 µs. At
/// 20 Hz that is ~0.02% of a core per connection — three to four orders of magnitude
/// below a 20–80 ms round trip, which is why the trade is worth making even though the
/// bandwidth saving only converts into latency at a congested bottleneck.</para>
///
/// <para><b>Context takeover must stay enabled.</b> The saving comes almost entirely
/// from the window persisting across messages: with takeover disabled the same frames
/// compress to ~0.86 (−14%) rather than ~0.38 (−62%). The cost is one deflate stream
/// per direction per connection held for the connection's lifetime.</para>
///
/// <para><b>Window size.</b> <see cref="ServerMaxWindowBits"/> 12 (4 KiB) costs
/// nothing in ratio on this traffic, so the ~112 KiB per connection it saves is free.
/// Sweeping the window over a production-encoded stream is flat — 0.379 at 11 bits
/// through 0.379 at 15 — because gameplay state drifts continuously and so nothing
/// repeats at long range: the dominant match is against the previous frame a few
/// hundred bytes back, which fits inside even a 4 KiB window. A larger window still
/// weakly dominates in theory, but here there is nothing further back for it to find.
/// The memory it saves is real: zlib's deflate state is
/// <c>(1 &lt;&lt; (windowBits + 2)) + (1 &lt;&lt; (memLevel + 9))</c>, so 144 KiB at 12
/// against 256 KiB at 15, charged per connection because takeover holds the state for
/// the connection's lifetime. Note this bounds the server's <i>compressor</i> alone:
/// the client is granted <c>client_max_window_bits=15</c>, so the server's
/// decompressor stays at 15 (~39 KiB) either way.</para>
///
/// <para><b>On these numbers.</b> They are measurements, not budgets. The window and
/// takeover claims are now held by <c>websocket-deflate-window.test.mjs</c>, which
/// rebuilds the corpus from the production encoders on every run; the rest are
/// point-in-time and unguarded, so re-measure before relying on them. This comment has
/// a history of being wrong in both directions — it once recorded the CPU cost ~7x low
/// and the window comparison as favouring 12, and the revision that fixed those
/// over-corrected into claiming 15 compresses materially better, on a corpus that could
/// not be reproduced from the production encoders and disagreed with the batch sizes
/// <c>WireSizeBenchTests</c> asserts. Corpus fidelity is the whole game here: a
/// hand-built stream whose envelope is byte-identical every frame compresses to ~0.04
/// and reports whatever window behaviour you like.</para>
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
            // The window must persist across messages or the ratio falls from ~0.38
            // to ~0.86 — most of the saving is cross-message, not within a frame.
            context.DisableServerContextTakeover = false;
            context.ServerMaxWindowBits = ServerMaxWindowBits;

            return inner.AcceptAsync(context);
        }
    }
}
