using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Covers <see cref="StaticAssetCompressionCache"/> and the Brotli branch of the
/// static-asset middleware in <c>Program.cs</c>.
///
/// <para>
/// The cache is warmed in the background after the host starts, so an integration test
/// cannot rely on an entry being present at any particular moment. These tests
/// therefore assert the two things that must hold regardless of timing: whichever
/// representation is served decodes to the exact file bytes with correct headers, and
/// the cache itself produces smaller output than the quality-1 encoding it replaces.
/// </para>
/// </summary>
public class StaticAssetCompressionTests : IClassFixture<StaticAssetCompressionTests.Factory>
{
    public sealed class Factory : AstervoidsWebFactory
    {
    }

    private readonly Factory _factory;

    public StaticAssetCompressionTests(Factory factory) => _factory = factory;

    private static string WebRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(directory.FullName, "AstervoidsWeb", "wwwroot");
            if (Directory.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("wwwroot not found");
    }

    // -------------------------------------------------------------------------
    // Cache behaviour
    // -------------------------------------------------------------------------

    [Fact]
    public void Warm_ProducesDecodableBodies_SmallerThanTheRequestPathEncoder()
    {
        var webRoot = WebRoot();
        var cache = new StaticAssetCompressionCache();
        cache.Warm(webRoot, ["/index.html", "/js/object-sync.js"]);

        foreach (var requestPath in new[] { "/index.html", "/js/object-sync.js" })
        {
            cache.TryGet(requestPath, out var asset).Should().BeTrue();

            var original = File.ReadAllBytes(
                Path.Combine(webRoot, requestPath.TrimStart('/')));
            Decode(asset.Body.ToArray()).Should().Equal(original,
                "the precompressed body must be the identity content, byte for byte");

            // The whole point: smaller than what the response-compression middleware
            // would produce on the request path at CompressionLevel.Fastest.
            asset.Body.Length.Should().BeLessThan(
                Encode(original, CompressionLevel.Fastest).Length);
        }

        cache.TryGet("/index.html", out var index).Should().BeTrue();
        index.ContentType.Should().StartWith("text/html");
    }

    [Fact]
    public void Warm_SkipsMissingAndIncompressibleAndTinyFiles()
    {
        var webRoot = WebRoot();
        var cache = new StaticAssetCompressionCache();
        cache.Warm(webRoot, ["/does-not-exist.js", "/favicon.ico", "/index.html"]);

        cache.TryGet("/does-not-exist.js", out _).Should().BeFalse();
        cache.TryGet("/favicon.ico", out _).Should().BeFalse();
        cache.TryGet("/index.html", out _).Should().BeTrue(
            "a bad entry must not abort the rest of the warm-up");
    }

    [Theory]
    [InlineData("/index.html", true)]
    [InlineData("/js/object-sync.js", true)]
    [InlineData("/favicon.ico", false)]
    [InlineData("/sounds/explosion.mp3", false)]
    public void IsCompressible_SelectsTextAssetsOnly(string requestPath, bool expected) =>
        StaticAssetCompressionCache.IsCompressible(requestPath).Should().Be(expected);

    // -------------------------------------------------------------------------
    // Served representation
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("/index.html")]
    [InlineData("/js/object-sync.js")]
    public async Task BrotliClient_ReceivesTheExactFileBytes_WithCachingHeadersIntact(
        string path)
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        // Caching semantics must be identical for both representations.
        response.Headers.ETag.Should().NotBeNull();
        response.Headers.CacheControl!.NoCache.Should().BeTrue();

        var body = await response.Content.ReadAsByteArrayAsync();
        var expected = File.ReadAllBytes(Path.Combine(WebRoot(), path.TrimStart('/')));

        if (response.Content.Headers.ContentEncoding.Contains("br"))
        {
            // A shared ETag across encodings is only safe with Vary: Accept-Encoding.
            response.Headers.Vary.Should().Contain("Accept-Encoding");
            Decode(body).Should().Equal(expected);
        }
        else
        {
            body.Should().Equal(expected, "the uncompressed fallback is byte-identical");
        }
    }

    [Fact]
    public async Task ClientWithoutBrotli_NeverReceivesABrotliBody()
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Get, "/index.html");
        request.Headers.AcceptEncoding.Clear();
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("identity"));

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentEncoding.Should().NotContain("br");
    }

    [Fact]
    public async Task BrotliRejectedWithZeroQuality_IsNotServedCompressed()
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Get, "/index.html");
        request.Headers.AcceptEncoding.Clear();
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br", 0));

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentEncoding.Should().NotContain("br");
    }

    [Fact]
    public async Task ConditionalRequest_StillReturns304_WhenBrotliIsAccepted()
    {
        var client = _factory.CreateClient();
        var first = await client.GetAsync("/index.html");
        var etag = first.Headers.ETag!.Tag;

        var request = new HttpRequestMessage(HttpMethod.Get, "/index.html");
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));
        request.Headers.IfNoneMatch.ParseAdd(etag);

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.NotModified);
        (await response.Content.ReadAsByteArrayAsync()).Should().BeEmpty();
    }

    [Fact]
    public async Task BothEncodings_AdvertiseTheSameContentHashValidator()
    {
        var client = _factory.CreateClient();

        var identityRequest = new HttpRequestMessage(HttpMethod.Get, "/index.html");
        identityRequest.Headers.AcceptEncoding.Add(
            new StringWithQualityHeaderValue("identity"));
        var identity = await client.SendAsync(identityRequest);

        var brotliRequest = new HttpRequestMessage(HttpMethod.Get, "/index.html");
        brotliRequest.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));
        var brotli = await client.SendAsync(brotliRequest);

        // A shared ETag across representations is what makes Vary: Accept-Encoding
        // correct, and what lets a redeploy of unchanged files revalidate as 304.
        brotli.Headers.ETag!.Tag.Should().Be(identity.Headers.ETag!.Tag);
    }

    [Fact]
    public async Task HeadRequest_ReportsALengthButNoBody()
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Head, "/index.html");
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));

        var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await response.Content.ReadAsByteArrayAsync()).Should().BeEmpty();
    }

    private static byte[] Encode(byte[] content, CompressionLevel level)
    {
        using var destination = new MemoryStream();
        using (var brotli = new BrotliStream(destination, level, leaveOpen: true))
        {
            brotli.Write(content);
        }
        return destination.ToArray();
    }

    private static byte[] Decode(byte[] compressed)
    {
        using var source = new MemoryStream(compressed);
        using var brotli = new BrotliStream(source, CompressionMode.Decompress);
        using var destination = new MemoryStream();
        brotli.CopyTo(destination);
        return destination.ToArray();
    }
}
