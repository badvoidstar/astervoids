export const AUTOMATED_IDENTITY_HEADER = 'X-Astervoids-Test-Identity';

const contexts = new WeakMap();

export async function configureAutomatedIdentities(context, { isolatedLocalScores = false } = {}) {
    if (typeof isolatedLocalScores !== 'boolean'
        || (isolatedLocalScores && Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL'))) {
        throw new Error('Leaderboard-eligible automation requires the isolated local browser fixture.');
    }
    const existing = contexts.get(context);
    if (existing) {
        if (existing.isolatedLocalScores !== isolatedLocalScores) {
            throw new Error('Configure identity automation once, before creating any players.');
        }
        return existing.headers;
    }
    const headers = Object.freeze(isolatedLocalScores ? {} : { [AUTOMATED_IDENTITY_HEADER]: 'true' });
    await context.setExtraHTTPHeaders(headers);
    contexts.set(context, { isolatedLocalScores, headers });
    return headers;
}

export async function automatedIdentityHeaders(context) {
    return contexts.get(context)?.headers ?? configureAutomatedIdentities(context);
}
