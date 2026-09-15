using System.Collections.Concurrent;
using System.IO.Compression;
using Microsoft.AspNetCore.StaticFiles;

namespace AstervoidsWeb.Services;

/// <summary>
/// Holds maximum-quality Brotli encodings of the static startup assets.
///
/// <para>
/// The response-compression middleware defaults to <see cref="CompressionLevel.Fastest"/>
/// (Brotli quality 1) because it compresses on the request path, where a slow encoder
/// would show up directly as latency. On this asset set quality 11 is 28% smaller than
/// quality 1 — 296.6 KiB drops to 213.2 KiB, with <c>index.html</c> alone going from
/// 143.0 KiB to 101.4 KiB — but costs about 1.4 s of CPU for the whole set, which is
/// far too slow to pay per request.
/// </para>
///
/// <para>
/// The assets never change while the process is running, so the encoding is done once
/// and reused. It runs in the background <b>after</b> the server is already listening,
/// not during startup: the regional endpoints are deliberately registered first so they
/// can answer cold-start RTT probes immediately, and blocking startup on ~1.4 s of
/// compression would defeat that. Until an entry is ready, requests simply fall through
/// to the normal static-file path and are compressed at quality 1 as before — the cache
/// is an optimisation, never a dependency.
/// </para>
/// </summary>
public sealed class StaticAssetCompressionCache
{
    /// <summary>Compressible startup assets. Media is already compressed.</summary>
    private static readonly HashSet<string> CompressibleExtensions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ".html", ".htm", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest", ".map"
        };

    /// <summary>
    /// Below this, transfer is dominated by request overhead and the quality-1 encoding
    /// is already within a few hundred bytes of optimal.
    /// </summary>
    private const int MinimumFileBytes = 1024;

    /// <summary>
    /// Defensive ceiling so an unexpectedly large asset cannot balloon resident memory.
    /// The real set is ~213 KiB.
    /// </summary>
    private const int MaximumTotalBytes = 8 * 1024 * 1024;

    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    private readonly ConcurrentDictionary<string, Asset> _assets =
        new(StringComparer.OrdinalIgnoreCase);

    /// <param name="Body">Brotli-encoded bytes, ready to write to the response.</param>
    /// <param name="ContentType">Content type of the <i>uncompressed</i> representation.</param>
    public readonly record struct Asset(ReadOnlyMemory<byte> Body, string ContentType);

    /// <summary>
    /// Returns the precompressed encoding for a request path (e.g. <c>/js/app.js</c>),
    /// if one has been built.
    /// </summary>
    public bool TryGet(string requestPath, out Asset asset) =>
        _assets.TryGetValue(requestPath, out asset);

    /// <summary>
    /// Whether <paramref name="requestPath"/> is worth precompressing at all. Used to
    /// skip the work for assets the middleware would never serve from this cache.
    /// </summary>
    public static bool IsCompressible(string requestPath) =>
        CompressibleExtensions.Contains(Path.GetExtension(requestPath));

    /// <summary>
    /// Compresses the given request paths, largest first so the dominant asset
    /// (<c>index.html</c>) becomes available soonest. Individual failures are skipped:
    /// a missing or unreadable file only means that asset keeps the quality-1 path.
    /// </summary>
    /// <param name="webRoot">Absolute path of the web root.</param>
    /// <param name="requestPaths">Root-relative request paths, e.g. <c>/js/app.js</c>.</param>
    public void Warm(
        string webRoot,
        IEnumerable<string> requestPaths,
        ILogger? logger = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(webRoot);
        ArgumentNullException.ThrowIfNull(requestPaths);

        var candidates = new List<(string RequestPath, string FilePath, long Length)>();
        foreach (var requestPath in requestPaths)
        {
            if (!IsCompressible(requestPath)) continue;

            var filePath = Path.Combine(webRoot, requestPath.TrimStart('/'));
            var info = new FileInfo(filePath);
            if (!info.Exists || info.Length < MinimumFileBytes) continue;

            candidates.Add((requestPath, filePath, info.Length));
        }

        candidates.Sort((left, right) => right.Length.CompareTo(left.Length));

        var totalBytes = 0L;
        foreach (var (requestPath, filePath, _) in candidates)
        {
            if (cancellationToken.IsCancellationRequested) return;
            if (totalBytes >= MaximumTotalBytes) break;

            try
            {
                var compressed = Compress(filePath, cancellationToken);
                if (compressed.Length == 0) continue;

                if (!ContentTypes.TryGetContentType(requestPath, out var contentType))
                {
                    contentType = "application/octet-stream";
                }

                _assets[requestPath] = new Asset(compressed, contentType);
                totalBytes += compressed.Length;
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException)
            {
                logger?.LogDebug(exception,
                    "Skipped precompressing {RequestPath}", requestPath);
            }
        }

        logger?.LogInformation(
            "Precompressed {Count} static assets into {Bytes} bytes",
            _assets.Count, totalBytes);
    }

    private static byte[] Compress(string filePath, CancellationToken cancellationToken)
    {
        using var source = File.OpenRead(filePath);
        using var destination = new MemoryStream();
        using (var brotli = new BrotliStream(
            destination, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            source.CopyTo(brotli);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return destination.ToArray();
    }
}
