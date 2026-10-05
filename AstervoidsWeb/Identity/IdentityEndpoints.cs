using System.Text.Json;
using Microsoft.Net.Http.Headers;

namespace AstervoidsWeb.Identity;

internal static class IdentityEndpoints
{
    public const int MaximumBodyBytes = 4096;
    private const string Prefix = "/api/identity";

    public static bool IsIdentityRequest(HttpContext context) =>
        context.Request.Path.StartsWithSegments(Prefix, StringComparison.OrdinalIgnoreCase);

    public static bool IsLimitedMutation(HttpRequest request) => HttpMethods.IsPost(request.Method)
        && NormalizedPath(request) is "/api/identity/root" or "/api/identity/invites" or "/api/identity/invites/accept";

    public static bool IsKnownRoute(HttpRequest request) => NormalizedPath(request) is
        "/api/identity/resolve" or "/api/identity/root" or "/api/identity/invites"
        or "/api/identity/invites/accept" or "/api/identity/invites/self";

    public static void MapPlayerIdentity(this IEndpointRouteBuilder endpoints)
    {
        Map<ResolveIdentityRequest>(endpoints, "/resolve",
            (service, browser, request, cancellation) => service.ResolveAsync(browser, request, cancellation));
        Map<RootIdentityRequest>(endpoints, "/root",
            (service, browser, request, cancellation) => service.CreateRootAsync(browser, request, cancellation));
        Map<CreateInviteRequest>(endpoints, "/invites",
            (service, browser, request, cancellation) => service.CreateInviteAsync(browser, request, cancellation));
        Map<AcceptInviteRequest>(endpoints, "/invites/accept",
            (service, browser, request, cancellation) => service.AcceptInviteAsync(browser, request, cancellation));
        Map<SelfInviteRequest>(endpoints, "/invites/self",
            (service, browser, request, cancellation) => service.SelfInviteAsync(browser, request, cancellation));
    }

    public static Task WriteAsync(HttpContext context, IdentityResult result, CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.StatusCode = result.StatusCode;
        return context.Response.WriteAsJsonAsync(result.Body, IdentityJson.Options, cancellationToken);
    }

    private static string NormalizedPath(HttpRequest request) =>
        (request.Path.Value ?? "").TrimEnd('/').ToLowerInvariant();

    private static void Map<T>(IEndpointRouteBuilder endpoints, string path,
        Func<PlayerIdentityService, string, T, CancellationToken, Task<IdentityResult>> execute) where T : class
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
                await WriteAsync(context, IdentityResult.Failure("invalid_request", 413), cancellation);
                return;
            }

            T? request;
            try
            {
                using var document = JsonDocument.Parse(buffer.AsMemory(0, length),
                    new JsonDocumentOptions { MaxDepth = 16 });
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || IdentityJson.HasDuplicateProperties(document.RootElement))
                    throw new JsonException();
                request = document.RootElement.Deserialize<T>(IdentityJson.Options);
            }
            catch (JsonException)
            {
                await WriteAsync(context, IdentityResult.Failure("invalid_request"), cancellation);
                return;
            }
            if (request is null)
            {
                await WriteAsync(context, IdentityResult.Failure("invalid_request"), cancellation);
                return;
            }

            var result = await execute(context.RequestServices.GetRequiredService<PlayerIdentityService>(),
                context.Request.Headers[IdentityHosting.BrowserHeader].ToString(), request, cancellation);
            await WriteAsync(context, result, cancellation);
        })).RequireCors(IdentityHosting.CorsPolicy);
    }

}

internal sealed class IdentityRequestMiddleware(RequestDelegate next)
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
            // Never let exception diagnostics echo capability material, request
            // bodies, identity records, or storage endpoints into an error page.
            if (context.Response.HasStarted)
            {
                context.Abort();
                return;
            }
            context.Response.Clear();
            await IdentityEndpoints.WriteAsync(context,
                IdentityResult.Failure("identity_unavailable"), context.RequestAborted);
        }
    }

}

internal sealed class IdentityValidationMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IdentityOrigins origins)
    {
        var request = context.Request;
        IdentityResult? rejection = null;
        if (!IdentityEndpoints.IsKnownRoute(request) || !HttpMethods.IsPost(request.Method)
            || request.QueryString.HasValue || !origins.Allows(request))
            rejection = IdentityResult.Failure("invalid_request");
        else if (!request.Headers.TryGetValue(IdentityHosting.BrowserHeader, out var browser)
            || browser.Count != 1 || !IdentitySecrets.IsToken(browser[0]))
            rejection = IdentityResult.Failure("invalid_browser_credential");
        else if (request.ContentLength > IdentityEndpoints.MaximumBodyBytes)
            rejection = IdentityResult.Failure("invalid_request", 413);
        else if (!request.HasJsonContentType()
            || !MediaTypeHeaderValue.TryParse(request.ContentType, out var contentType)
            || (contentType.Charset.HasValue
                && !contentType.Charset.Value!.Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase))
            || request.Headers.ContentEncoding.Count != 0)
            rejection = IdentityResult.Failure("invalid_request", 415);
        if (rejection is not null)
        {
            await IdentityEndpoints.WriteAsync(context, rejection, context.RequestAborted);
            return;
        }
        context.Items[IdentityHosting.BrowserHashItem] =
            IdentitySecrets.Hash(request.Headers[IdentityHosting.BrowserHeader].ToString());
        await next(context);
    }
}
