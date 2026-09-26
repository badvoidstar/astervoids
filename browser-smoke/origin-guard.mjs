export async function installOriginGuard(page, baseURL, health) {
    const context = page.context();
    const session = await context.newCDPSession(page);
    session.on('Fetch.requestPaused', async event => {
        try {
            const { requestId, responseStatusCode, responseErrorReason, responseHeaders, request } = event;
            if ([301, 302, 303, 307, 308].includes(responseStatusCode)) {
                health.redirects++;
                const location = responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
                if (location && new URL(location, request.url).origin !== baseURL) health.offOrigin++;
                await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
            } else {
                if (responseErrorReason && responseErrorReason !== 'BlockedByClient' && !context.isClosed()) {
                    health.requestFailures++;
                }
                await session.send('Fetch.continueRequest', { requestId });
            }
        } catch {
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

    await context.route('**/*', async route => {
        try {
            const url = route.request().url();
            if (new URL(url).origin !== baseURL) {
                health.offOrigin++;
                await route.abort('blockedbyclient');
                return;
            }
            // Each smoke context owns exactly one guarded page. Popups and
            // frameless worker requests must not bypass response interception.
            if (route.request().frame().page() !== page) {
                health.requestFailures++;
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
