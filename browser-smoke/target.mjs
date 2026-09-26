const invalidTarget = 'Browser smoke requires a root HTTPS URL on a default *.azurecontainerapps.io branch-preview hostname, without credentials, port, query, or fragment.';

export function remoteBaseURL(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(invalidTarget);
    }
    if (url.protocol !== 'https:'
        || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.azurecontainerapps\.io$/.test(url.hostname)
        || url.username || url.password || url.port
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(invalidTarget);
    }
    return url.origin;
}

export function assertSingleOriginRegions(manifest, baseURL) {
    if (!Array.isArray(manifest?.regions) || manifest.regions.length > 1) {
        throw new Error('Browser smoke supports single-region branch previews, not multi-region production.');
    }
    for (const region of manifest.regions) {
        if (region.hostname && region.hostname.replace(/\/$/, '') !== baseURL) {
            throw new Error('Browser smoke refuses a region manifest that routes outside the preview origin.');
        }
    }
}

export async function waitForPreview(baseURL, { timeout = 120_000, interval = 1_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        let response;
        try {
            response = await fetch(`${baseURL}/api/regions`, {
                redirect: 'manual',
                signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))),
            });
        } catch {
            // A new revision may still be starting. Only readiness is retried.
        }
        if (response?.ok) {
            let manifest;
            try {
                manifest = await response.json();
            } catch {
                throw new Error('Browser smoke target did not serve a region manifest.');
            }
            assertSingleOriginRegions(manifest, baseURL);
            return;
        }
        if (response && response.status < 500) {
            throw new Error('Browser smoke target rejected readiness or redirected away from its default origin.');
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('Browser smoke target unavailable within the readiness deadline; no gameplay checks ran.');
}
