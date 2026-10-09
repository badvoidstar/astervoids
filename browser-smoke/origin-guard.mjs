const guardedPages = new WeakMap();

export function allowedGuardOrigins(baseURL, loopbackOrigins = []) {
    const origins = new Set([baseURL]);
    if (!loopbackOrigins.length) return origins;
    for (const value of [baseURL, ...loopbackOrigins]) {
        let url;
        try { url = new URL(value); } catch { throw new Error('Only explicitly registered loopback origins are allowed.'); }
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
            || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('Only explicitly registered loopback origins are allowed.');
        }
        origins.add(url.origin);
    }
    return origins;
}

export async function installOriginGuard(page, baseURL, health, { loopbackOrigins = [] } = {}) {
    const allowedOrigins = allowedGuardOrigins(baseURL, loopbackOrigins);
    const context = page.context();
    const session = await context.newCDPSession(page);
    session.on('Fetch.requestPaused', async event => {
        try {
            const { requestId, responseStatusCode, responseErrorReason, responseHeaders, request } = event;
            if ([301, 302, 303, 307, 308].includes(responseStatusCode)) {
                health.redirects++;
                const location = responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
                if (location && !allowedOrigins.has(new URL(location, request.url).origin)) health.offOrigin++;
                await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
            } else {
                if (responseErrorReason && responseErrorReason !== 'BlockedByClient' && !context.isClosed()) {
                    health.requestFailures++;
                }
                await session.send('Fetch.continueRequest', { requestId });
            }
        } catch (error) {
            // Navigation or AbortController can remove a paused request before continuation.
            if (error.message?.includes('Invalid InterceptionId')) return;
            if (!context.isClosed() && !page.isClosed()) health.requestFailures++;
            await session.send('Fetch.failRequest', {
                requestId: event.requestId, errorReason: 'Aborted',
            }).catch(() => {});
        }
    });
    // Install before navigation starts, not inside its route callback: response
    // interception must already be enabled when Chromium creates the request.
    // Native response bodies (including streams) and WebSockets stay intact.
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    guardedPages.set(page, { allowedOrigins, health });

    await context.route('**/*', async route => {
        try {
            const url = route.request().url();
            // Only explicitly guarded tabs may share a browser binding.
            // Unguarded popups and frameless workers still cannot bypass interception.
            const policy = guardedPages.get(route.request().frame().page());
            if (!policy) {
                health.requestFailures++;
                await route.abort('blockedbyclient');
                return;
            }
            if (!policy.allowedOrigins.has(new URL(url).origin)) {
                policy.health.offOrigin++;
                await route.abort('blockedbyclient');
                return;
            }
            await route.continue();
        } catch {
            if (!context.isClosed()) health.requestFailures++;
            await route.abort('failed').catch(() => {});
        }
    });
}
