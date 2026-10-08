using System.Text.Json;
using AstervoidsWeb.Identity;
using Microsoft.Net.Http.Headers;

namespace AstervoidsWeb.Leaderboards;

internal static class LeaderboardEndpoints
{
    public const int MaximumBodyBytes = 4096;
    private const string Prefix = "/api/leaderboard";

    public static bool IsLeaderboardRequest(HttpContext context) =>
        context.Request.Path.StartsWithSegments(Prefix, StringComparison.OrdinalIgnoreCase);

    public static bool IsScoreWrite(HttpRequest request) =>
        HttpMethods.IsPost(request.Method) && NormalizedPath(request) == Prefix + "/scores";

    public static bool IsQuery(HttpRequest request) =>
        HttpMethods.IsPost(request.Method) && NormalizedPath(request) == Prefix + "/query";

    public static void MapLeaderboards(this IEndpointRouteBuilder endpoints)
    {
        Map<SubmitScoreRequest>(endpoints, "/scores", (service, context, request) =>
            service.SubmitAsync(context.Request.Headers[IdentityHosting.BrowserHeader].ToString(),
                request, context.RequestAborted));
        Map<LeaderboardQueryRequest>(endpoints, "/query", (service, context, request) =>
            service.QueryAsync(request, context.RequestAborted));
    }

    public static Task WriteAsync(HttpContext context, LeaderboardResult result, CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.StatusCode = result.StatusCode;
        return context.Response.WriteAsJsonAsync(result.Body, IdentityJson.Options, cancellationToken);
    }

    private static string NormalizedPath(HttpRequest request) =>
        (request.Path.Value ?? "").TrimEnd('/').ToLowerInvariant();

    private static void Map<T>(IEndpointRouteBuilder endpoints, string path,
        Func<LeaderboardService, HttpContext, T, Task<LeaderboardResult>> execute) where T : class
    {
        endpoints.MapPost(Prefix + path, (RequestDelegate)(async context =>
        {
            var cancellation = context.RequestAborted;
            var buffer = new byte[MaximumBodyBytes + 1];
            var length = 0;
            while (length < buffer.Length)
            {
                var read = await context.Request.Body.ReadAsync(buffer.AsMemory(length), cancellation);
                if (read == 0)
                    break;
                length += read;
            }
            if (length > MaximumBodyBytes)
            {
                await WriteAsync(context, LeaderboardResult.Failure("invalid_request", 413), cancellation);
                return;
            }

            T? request;
            try
            {
                using var json = JsonDocument.Parse(buffer.AsMemory(0, length),
                    new JsonDocumentOptions { MaxDepth = IdentityJson.Options.MaxDepth });
                if (json.RootElement.ValueKind != JsonValueKind.Object || IdentityJson.HasDuplicateProperties(json.RootElement))
                    throw new JsonException();
                request = json.RootElement.Deserialize<T>(IdentityJson.Options);
            }
            catch (JsonException)
            {
                await WriteAsync(context, LeaderboardResult.Failure("invalid_request"), cancellation);
                return;
            }
            if (request is null)
            {
                await WriteAsync(context, LeaderboardResult.Failure("invalid_request"), cancellation);
                return;
            }
            await WriteAsync(context, await execute(
                context.RequestServices.GetRequiredService<LeaderboardService>(), context, request), cancellation);
        })).RequireCors(IdentityHosting.CorsPolicy);
    }
}

internal sealed class LeaderboardRequestMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.OnStarting(() =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Task.CompletedTask;
        });
        try
        {
            await next(context);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            context.Abort();
        }
        catch (Exception)
        {
            if (context.Response.HasStarted)
            {
                context.Abort();
                return;
            }
            context.Response.Clear();
            await LeaderboardEndpoints.WriteAsync(context,
                LeaderboardResult.Failure("leaderboard_unavailable"), context.RequestAborted);
        }
    }
}

internal sealed class LeaderboardValidationMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IdentityOrigins origins)
    {
        var request = context.Request;
        var scoreWrite = LeaderboardEndpoints.IsScoreWrite(request);
        LeaderboardResult? rejection = null;
        if ((!scoreWrite && !LeaderboardEndpoints.IsQuery(request))
            || request.QueryString.HasValue || !origins.Allows(request))
            rejection = LeaderboardResult.Failure("invalid_request");
        else if (scoreWrite && (!request.Headers.TryGetValue(IdentityHosting.BrowserHeader, out var browser)
            || browser.Count != 1 || !IdentitySecrets.IsToken(browser[0])))
            rejection = LeaderboardResult.Failure("invalid_browser_credential");
        else if (request.ContentLength > LeaderboardEndpoints.MaximumBodyBytes)
            rejection = LeaderboardResult.Failure("invalid_request", 413);
        else if (!request.HasJsonContentType()
            || !MediaTypeHeaderValue.TryParse(request.ContentType, out var contentType)
            || contentType.Charset.HasValue
                && !contentType.Charset.Value!.Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase)
            || request.Headers.ContentEncoding.Count != 0)
            rejection = LeaderboardResult.Failure("invalid_request", 415);
        if (rejection is not null)
        {
            await LeaderboardEndpoints.WriteAsync(context, rejection, context.RequestAborted);
            return;
        }
        if (scoreWrite)
            context.Items[IdentityHosting.BrowserHashItem] =
                IdentitySecrets.Hash(request.Headers[IdentityHosting.BrowserHeader].ToString());
        await next(context);
    }
}
