import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { captureClipboard, completeIdentityAction, invitation, maximumLengthTag, namePlayer, openIdentityNaming } from './identity-helpers.mjs';
import { installOriginGuard } from './origin-guard.mjs';
import { configureAutomatedIdentities } from './automated-identities.mjs';

const { INITIAL_RESOLVE_POLICY: startupPolicy } =
    createRequire(import.meta.url)('../AstervoidsWeb/wwwroot/js/player-identity.js');

const test = base.extend({
    identities: async ({ browser, baseURL }, use) => {
        const contexts = [];
        const guards = [];
        let uncaught = 0;
        const identities = {
            async open(path = '/', context = null, beforeNavigate = null, guardOptions = {}) {
                if (!context) {
                    context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
                    contexts.push(context);
                }
                await configureAutomatedIdentities(context);
                const page = await context.newPage();
                page.on('pageerror', () => { uncaught++; });
                const health = { offOrigin: 0, redirects: 0, requestFailures: 0, scoreRequests: 0 };
                page.on('request', request => {
                    if (new URL(request.url()).pathname === '/api/leaderboard/scores') health.scoreRequests++;
                });
                guards.push(health);
                await installOriginGuard(page, baseURL, health, guardOptions);
                await captureClipboard(page);
                if (beforeNavigate) await beforeNavigate(page);
                await page.goto(path);
                await expect(page.locator('#game')).toBeVisible();
                return { page, context };
            },
        };
        try { await use(identities); }
        finally {
            for (const context of contexts.reverse()) await context.close();
            expect(uncaught, 'Identity flows have no uncaught script exceptions').toBe(0);
            for (const health of guards) {
                expect(health, 'Identity flows stay on the selected origin without redirects, failures or score writes')
                    .toEqual({ offOrigin: 0, redirects: 0, requestFailures: 0, scoreRequests: 0 });
            }
        }
    },
});

const publicIdentity = page => page.evaluate(() => PlayerIdentity.current());
const atRoot = page => expect.poll(() => page.evaluate(() =>
    location.pathname === '/' && location.hash === '' && location.search === ''),
{ message: 'Only the site root remains in the address bar' }).toBe(true);

test('static multiregion cold startup overlaps full assessment with automatic initial identity recovery', async ({
    baseURL, identities,
}) => {
    test.skip(Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL'), 'Controlled startup faults are loopback-only.');
    const servers = [];
    const delayed = [];
    const early = new Set();
    const measured = new Set();
    const identityOrigins = new Set();
    let resolves = 0;
    let releaseIdentity;
    let releaseRegion = false;
    let player;
    const identityReady = new Promise(resolve => { releaseIdentity = resolve; });
    try {
        for (let index = 0; index < 2; index++) {
            const server = createServer((request, reply) => {
                const path = new URL(request.url, baseURL).pathname;
                const headers = {
                    'Access-Control-Allow-Origin': baseURL,
                    'Access-Control-Allow-Credentials': 'true',
                    'Access-Control-Allow-Headers': request.headers['access-control-request-headers']
                        || 'Content-Type,X-Astervoids-Test-Identity,X-SignalR-User-Agent',
                    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                    'Content-Type': 'application/json',
                };
                if (request.method === 'OPTIONS') {
                    reply.writeHead(204, headers).end();
                } else if (path === '/api/ping') {
                    const send = () => { if (!reply.destroyed) reply.writeHead(200, headers).end('{"now":0}'); };
                    if (index === 1 && !releaseRegion) delayed.push(send);
                    else send();
                } else if (path === '/api/sessions') {
                    reply.writeHead(200, headers).end(JSON.stringify({
                        sessions: [], maxSessions: 6, canCreateSession: true,
                    }));
                } else {
                    // These owned fixtures model regional HTTP readiness, not
                    // gameplay transport. No identity or membership is accepted.
                    reply.writeHead(503, headers).end('{"error":"fixture_unavailable"}');
                }
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            servers.push(server);
        }
        const origins = [baseURL, ...servers.map(server => `http://127.0.0.1:${server.address().port}`)];
        player = await identities.open('/', null, async page => {
            page.on('request', request => {
                const url = new URL(request.url());
                if (url.pathname === '/api/ping' && request.method() === 'GET') {
                    if (url.search) measured.add(url.origin);
                    else {
                        early.add(url.origin);
                        expect(request.headers()['x-astervoids-browser']).toBeUndefined();
                        expect(request.headers().cookie).toBeUndefined();
                        expect(request.headers().referer).toBeUndefined();
                        expect(request.postData()).toBeNull();
                    }
                }
                if (url.pathname.startsWith('/api/identity/')) {
                    identityOrigins.add(url.origin);
                    expect(url.pathname, 'Startup never submits an identity mutation').toBe('/api/identity/resolve');
                }
            });
            await page.route(`${baseURL}/region-bootstrap.js`, route => route.fulfill({
                contentType: 'application/javascript',
                body: `window.ASTERVOIDS_REGION_BOOTSTRAP = ${JSON.stringify({
                    regionId: null,
                    regions: origins.map((hostname, index) => ({ id: `r${index}`, displayName: `Local ${index}`, hostname })),
                })};`,
            }));
            await page.route(`${baseURL}/api/identity/resolve`, async route => {
                if (++resolves <= 3) {
                    await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>Starting</html>' });
                } else {
                    await identityReady;
                    await route.fallback();
                }
            });
        }, { loopbackOrigins: origins.slice(1) });
        await expect.poll(() => resolves, { message: 'Repeated cold HTML 503 responses are automatically retried' }).toBe(4);
        await expect.poll(() => early.size, { message: 'Every region starts credential-free preparation' }).toBe(3);
        await expect.poll(() => measured.size, { message: 'Every RTT burst starts before identity completes' }).toBe(3);
        expect([...identityOrigins]).toEqual([baseURL]);
        await expect(player.page.locator('#identity-title')).toHaveText('Getting ready');
        await expect(player.page.locator('#identity-dialog').getByRole('button')).toHaveCount(0);
        expect(await player.page.evaluate(() => ({
            started: identityStarted, identity: PlayerIdentity.current(),
            member: SessionClient.isInSession(), create: getCreateEligibility().canCreateNow,
        }))).toEqual({ started: false, identity: null, member: false, create: false });
        await expect.poll(() => player.page.evaluate(() => RegionService.isRegionAvailable('r0'))).toBe(true);

        releaseIdentity();
        await expect.poll(() => player.page.evaluate(() => !identityBusy)).toBe(true);
        expect(resolves, 'Recovery required no manual Retry click').toBe(4);
        if (await player.page.locator('#identity-dialog').isVisible()) {
            await expect(player.page.locator('#identity-tag')).toBeVisible();
            await player.page.locator('#identity-ignore').click();
        }
        expect(await player.page.evaluate(() => ({
            all: RegionService.areAllRegionsAssessed(),
            create: getCreateEligibility().canCreateNow,
            connected: Boolean(SessionClient.isConnected()),
        }))).toEqual({ all: false, create: false, connected: false });
        releaseRegion = true;
        for (const send of delayed.splice(0)) send();
        await expect.poll(() => player.page.evaluate(() => RegionService.areAllRegionsAssessed())).toBe(true);
        await expect.poll(() => player.page.evaluate(() => getCreateEligibility().canCreateNow)).toBe(true);
        expect(await player.page.evaluate(() => SessionClient.isInSession())).toBe(false);
    } finally {
        releaseIdentity();
        releaseRegion = true;
        for (const send of delayed.splice(0)) send();
        if (player) await player.context.close();
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    }
});

test('static entry prepares its single configured region before delayed game scripts without trusting a binding', async ({
    browser, baseURL, identities,
}) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const probes = [];
    const responses = [];
    let identityRequests = 0;
    let scriptsBlocked = false;
    let release;
    const scriptsReady = new Promise(resolve => { release = resolve; });
    let opening;
    context.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/ping') {
            probes.push({
                method: request.method(),
                noCredential: !request.headers()['x-astervoids-browser'],
                noReferrer: !request.headers().referer,
                noBody: request.postData() === null,
            });
        }
        if (path.startsWith('/api/identity/')) identityRequests++;
    });
    context.on('response', response => {
        if (new URL(response.url()).pathname === '/api/ping') responses.push(response.status());
    });
    try {
        opening = identities.open('/', context, async page => {
            await page.route(`${baseURL}/region-bootstrap.js`, route => route.fulfill({
                contentType: 'application/javascript',
                body: `window.ASTERVOIDS_REGION_BOOTSTRAP = ${JSON.stringify({
                    regionId: null,
                    regions: [{ id: 'local', displayName: 'Local', hostname: baseURL }],
                })};`,
            }));
            await page.route(`${baseURL}/js/signalr.min.js`, async route => {
                scriptsBlocked = true;
                await scriptsReady;
                await route.fallback();
            });
        });
        await expect.poll(() => scriptsBlocked, {
            message: 'Game script loading is deliberately paused',
        }).toBe(true);
        await expect.poll(() => responses.length, {
            message: 'The identity region answers while game scripts are still blocked',
            timeout: 5_000,
        }).toBe(1);
        expect(responses).toEqual([200]);
        expect(probes).toEqual([{ method: 'GET', noCredential: true, noReferrer: true, noBody: true }]);
        expect(identityRequests, 'Preparation is not an identity resolution or mutation').toBe(0);
        expect(await context.pages()[0].evaluate(() => ({
            identity: PlayerIdentity.current(),
            noCredential: localStorage.getItem(PlayerIdentity.STORAGE_KEY) === null,
        }))).toEqual({ identity: null, noCredential: true });
    } finally {
        release();
        try {
            if (opening) {
                const player = await opening;
                await openIdentityNaming(player.page);
            }
        } finally {
            await context.close();
        }
    }
});

async function expectDialogComposition(page, selector) {
    const layout = await page.locator(selector).evaluate(dialog => {
        const box = dialog.getBoundingClientRect();
        const body = dialog.querySelector('.dialog-body');
        const buttons = [...dialog.querySelectorAll('button')].filter(button => button.getClientRects().length);
        const rects = buttons.map(button => button.getBoundingClientRect());
        return {
            contained: box.left >= 8 && box.top >= 8
                && box.right <= innerWidth - 8 && box.bottom <= innerHeight - 8,
            noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth + 1
                && !!body && body.scrollWidth <= body.clientWidth + 1,
            actionsVisible: rects.every(rect => rect.top >= box.top
                && rect.bottom <= box.bottom - 8 && rect.left >= box.left
                && rect.right <= box.right),
            consistentTargets: rects.every(rect => rect.height >= 44
                && Math.abs(rect.height - rects[0].height) < 1
                && Math.abs(rect.width - rects[0].width) < 1),
            aligned: rects.length < 2 || Math.abs(rects[0].top - rects[1].top) < 1
                || rects[1].top >= rects[0].bottom + 7,
            readableLabels: buttons.every(button => {
                const range = document.createRange();
                range.selectNodeContents(button);
                return range.getClientRects().length === 1
                    && parseFloat(getComputedStyle(button).fontSize) >= 13;
            }),
            nativeText: getComputedStyle(dialog).transform === 'none',
        };
    });
    expect(layout, 'Dialog content scrolls without clipping or misaligning its native-text actions').toEqual({
        contained: true, noHorizontalOverflow: true, actionsVisible: true,
        consistentTargets: true, aligned: true, readableLabels: true, nativeText: true,
    });
}

test('cold root entry waits for identity and services without offering unavailable choices', async ({ identities }) => {
    let release;
    let resolving = false;
    const pending = new Promise(resolve => { release = resolve; });
    let player;
    try {
        player = await identities.open('/', null, async page => {
            await page.setViewportSize({ width: 320, height: 568 });
            await page.route('**/api/identity/resolve', async route => {
                resolving = true;
                await pending;
                await route.fallback();
            });
        });
        await expect.poll(() => resolving).toBe(true);
        await expect(player.page.locator('#identity-ignore')).not.toBeVisible();
        await expect(player.page.locator('#identity-title')).toHaveText('Getting ready');
        await expect(player.page.locator('#identity-description')).toHaveText(
            'Determining your player identity and warming up services. Please wait...');
        await expect(player.page.locator('#identity-dialog').getByRole('button')).toHaveCount(0);
        await expect(player.page.locator('#identity-dialog .dialog-actions')).not.toBeVisible();
        await expect(player.page.locator('#identity-tag')).not.toBeVisible();
        await expect(player.page.locator('#identity-title')).toBeFocused();
        await expectDialogComposition(player.page, '#identity-dialog');
        await player.page.keyboard.press('Escape');
        await player.page.keyboard.press('Enter');
        await expect(player.page.locator('#identity-dialog')).toBeVisible();
        expect(await player.page.evaluate(() => ({
            changing: game.identityChanging,
            started: identityStarted,
        }))).toEqual({ changing: true, started: false });
    } finally {
        release();
    }
    await openIdentityNaming(player.page);
    await expect(player.page.locator('#identity-dialog .dialog-actions')).toBeVisible();
    await expect(player.page.locator('#identity-ignore')).toHaveText('Play as guest');
    await expect(player.page.locator('#identity-ignore')).toBeEnabled();
    await expect(player.page.locator('#identity-tag')).toBeFocused();
    await player.page.locator('#identity-ignore').click();
    await expect(player.page.locator('#identity-dialog')).not.toBeVisible();
    await expect(player.page.locator('#identity-status')).toHaveText('Playing as guest');
});

for (const viewport of [
    { width: 1280, height: 900 },
    { width: 320, height: 568 },
    { width: 568, height: 320 },
]) {
    test(`identity dialogs and sharing stay composed at ${viewport.width}x${viewport.height}`, async ({ identities }) => {
        const player = await identities.open();
        await player.page.setViewportSize(viewport);
        await openIdentityNaming(player.page);
        await expectDialogComposition(player.page, '#identity-dialog');
        await expect(player.page.locator('label[for="identity-tag"]')).toHaveText('Player tag');
        await expect(player.page.locator('#identity-tag')).toHaveAttribute(
            'aria-describedby', 'identity-tag-hint identity-error');
        await namePlayer(player.page, maximumLengthTag());
        const self = await invitation(player.page, 'self');
        await expect(player.page.locator('#btn-invite-self')).toBeFocused();
        const notice = await player.page.locator('#identity-notice').boundingBox();
        expect(notice.width).toBeCloseTo(Math.min(440, viewport.width - 32), 0);
        expect(notice.x + notice.width / 2).toBeCloseTo(viewport.width / 2, 0);
        const friend = await invitation(player.page, 'friend');

        await player.page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
                writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
            } });
        });
        for (const [kind, title] of [['self', 'Share your identity'], ['friend', 'Invite a friend']]) {
            await player.page.locator(`#btn-invite-${kind}`).click();
            await expect(player.page.locator('#invite-share-title')).toHaveText(title);
            await expect(player.page.locator('#identity-notice')).not.toBeVisible();
            await expectDialogComposition(player.page, '#invite-share-dialog');
            await expect(player.page.locator('#invite-share-url')).toHaveAttribute(
                'aria-describedby', 'invite-share-description invite-share-warning invite-share-error');
            await player.page.locator('#invite-share-copy').click();
            await expect(player.page.locator('#invite-share-error')).toContainText('denied');
            await expect(player.page.locator('#invite-share-error')).toBeInViewport({ ratio: 0.99 });
            await expect(player.page.locator('#invite-share-url')).toBeInViewport({ ratio: 0.99 });
            await expectDialogComposition(player.page, '#invite-share-dialog');
            await player.page.locator('#invite-share-close').click();
            await expect(player.page.locator(`#btn-invite-${kind}`)).toBeFocused();
        }

        const confirmation = await identities.open(self);
        await confirmation.page.setViewportSize(viewport);
        await expect(confirmation.page.locator('#identity-title')).toHaveText('Confirm player identity');
        await expectDialogComposition(confirmation.page, '#identity-dialog');

        const replacement = await identities.open(friend, player.context);
        await replacement.page.setViewportSize(viewport);
        await expect(replacement.page.locator('#identity-description')).toContainText('replaces');
        await expectDialogComposition(replacement.page, '#identity-dialog');

        const invalid = await identities.open('/#invite=invalid');
        await invalid.page.setViewportSize(viewport);
        await expect(invalid.page.locator('#identity-title')).toHaveText('Invitation unavailable');
        await expectDialogComposition(invalid.page, '#identity-dialog');
    });
}

test('identity failure and busy states keep their actions accessible in a reduced-height viewport', async ({ identities }) => {
    const player = await identities.open();
    await player.page.setViewportSize({ width: 360, height: 300 });
    let failedAttempts = 0;
    await player.page.route('**/api/identity/resolve', route => {
        failedAttempts++;
        return route.fulfill({
            status: 503, contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'identity_unavailable' } }),
        });
    });
    await player.page.reload();
    await expect(player.page.locator('#identity-title')).toHaveText('Player identity unavailable', {
        timeout: startupPolicy.budgetMs + 5_000,
    });
    expect(failedAttempts, 'Persistent cold failures exhaust only the bounded startup attempts')
        .toBe(startupPolicy.maxAttempts);
    await expectDialogComposition(player.page, '#identity-dialog');
    await player.page.unroute('**/api/identity/resolve');

    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await player.page.route('**/api/identity/resolve', async route => {
        await pending;
        await route.continue();
    });
    try {
        await player.page.locator('#identity-accept').click();
        await expect(player.page.locator('#identity-description')).toContainText(
            'Determining your player identity and warming up services');
        await expect(player.page.locator('#identity-dialog .dialog-actions')).not.toBeVisible();
        await expect(player.page.locator('#identity-ignore')).not.toBeVisible();
        await expect(player.page.locator('#identity-ignore')).toBeDisabled();
        await expect(player.page.locator('#identity-title')).toBeFocused();
        await expectDialogComposition(player.page, '#identity-dialog');
    } finally {
        release();
    }
    await openIdentityNaming(player.page);
    await expectDialogComposition(player.page, '#identity-dialog');
    await player.page.locator('#identity-tag').scrollIntoViewIfNeeded();
    await expect(player.page.locator('#identity-tag')).toBeInViewport();
    await player.page.unroute('**/api/identity/resolve');

    await player.page.route('**/api/identity/root', route => route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'identity_unavailable' } }),
    }));
    const tag = maximumLengthTag();
    await player.page.locator('#identity-tag').fill(tag);
    await player.page.locator('#identity-accept').click();
    await expect(player.page.locator('#identity-accept')).toHaveText('Retry last request');
    await expect(player.page.locator('#identity-ignore')).toBeDisabled();
    await expect(player.page.locator('#identity-tag')).toHaveJSProperty('readOnly', true);
    await expect(player.page.locator('#identity-error')).toBeInViewport({ ratio: 0.99 });
    await expectDialogComposition(player.page, '#identity-dialog');
    await player.page.unroute('**/api/identity/root');
    await completeIdentityAction(player.page);
    await expect(player.page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);

    await player.page.route('**/api/identity/invites', route => route.fulfill({
        status: 429, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'rate_limited' } }),
    }));
    await player.page.locator('#btn-invite-friend').click();
    await expect(player.page.locator('#identity-title')).toHaveText('Invitation not confirmed');
    await expect(player.page.locator('#identity-ignore')).toHaveText('Back to menu');
    await expectDialogComposition(player.page, '#identity-dialog');
    await player.page.locator('#identity-ignore').click();
    await expect(player.page.locator('#identity-dialog')).not.toBeVisible();
    await expect(player.page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
    await expect(player.page.locator('#btn-invite-friend')).toBeFocused();
});

test('maximum-length root naming survives reload, solo play, self recovery and new-browser confirmation', async ({ identities }) => {
    const original = await identities.open();
    const tag = maximumLengthTag();
    await namePlayer(original.page, tag);
    const identity = await publicIdentity(original.page);
    expect(identity.excludeFromLeaderboards, 'Automated UI creation persists leaderboard exclusion').toBe(true);
    await original.page.reload();
    await expect(original.page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
    await expect(original.page.locator('#identity-dialog')).not.toBeVisible();
    expect(await publicIdentity(original.page)).toEqual(identity);
    const self = await invitation(original.page, 'self');
    await original.page.locator('#btn-solo').click();
    await expect(original.page.locator('#score')).toContainText(tag);
    await original.page.keyboard.press('Escape');
    const same = await identities.open(self, original.context);
    await expect(same.page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
    await expect(same.page.locator('#identity-dialog')).not.toBeVisible();
    await atRoot(same.page);
    const recovered = await identities.open(self);
    await expect(recovered.page.locator('#identity-title')).toHaveText('Confirm player identity');
    await expect(recovered.page.locator('#identity-description')).toContainText(tag);
    expect(await publicIdentity(recovered.page)).toBeNull();
    await completeIdentityAction(recovered.page);
    await expect(recovered.page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
    expect(await publicIdentity(recovered.page)).toEqual(identity);
    expect((await invitation(recovered.page, 'self')) === self, 'Self always returns the original private link').toBe(true);
    await recovered.page.reload();
    await expect(recovered.page.locator('#identity-dialog')).not.toBeVisible();
    await atRoot(recovered.page);
});

test('automated identities and invitation descendants stay off public boards before, during and after real play', async ({ identities }) => {
    const original = await identities.open();
    await namePlayer(original.page, maximumLengthTag(randomUUID().replaceAll('-', '')));
    await original.context.setExtraHTTPHeaders({});
    await verifyPlayExclusion(original.page);

    const self = await invitation(original.page, 'self');
    const recovered = await identities.open(self, null, page => page.context().setExtraHTTPHeaders({}));
    await completeIdentityAction(recovered.page);
    await expect(recovered.page.locator('#identity-dialog')).not.toBeVisible();
    await verifyPlayExclusion(recovered.page);

    const friend = await identities.open(await invitation(recovered.page, 'friend'), null,
        page => page.context().setExtraHTTPHeaders({}));
    await namePlayer(friend.page, maximumLengthTag(randomUUID().replaceAll('-', '')));
    await verifyPlayExclusion(friend.page);

    async function verifyPlayExclusion(page) {
        let scoreRequests = 0;
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/leaderboard/scores') scoreRequests++;
        });
        expect(await page.evaluate(() => PlayerIdentity.current()?.excludeFromLeaderboards === true),
            'Eligibility is durable, not a current-request marker').toBe(true);
        const publiclyVisible = () => page.evaluate(async () => (await PlayerIdentity.queryLeaderboard())
            .entries.some(entry => entry.name === PlayerIdentity.current().tag));
        expect(await publiclyVisible(), 'Excluded identities are absent before play').toBe(false);
        await page.locator('#btn-solo').click();
        await expect(page.locator('#start-screen')).toBeHidden();
        await expect.poll(() => page.evaluate(() => !!game.ship && game.wave >= 1)).toBe(true);
        expect(await page.evaluate(() => game.leaderboardRun === null),
            'Real named gameplay does not open an excluded score run').toBe(true);
        expect(await publiclyVisible(), 'Excluded identities are absent during play').toBe(false);
        await page.keyboard.press('p');
        await expect(page.locator('#pause-menu')).toBeVisible();
        await page.keyboard.down('Escape');
        try {
            await expect(page.locator('#start-screen')).toBeVisible();
        } finally {
            await page.keyboard.up('Escape');
        }
        expect(await publiclyVisible(), 'Excluded identities are absent after play, without cleanup').toBe(false);
        expect(scoreRequests, 'No automated gameplay checkpoint was submitted').toBe(0);
    }
});

test('identity entry enforces the shared limit when typing and submitting', async ({ identities }) => {
    const host = await identities.open();
    await namePlayer(host.page, 'Host');
    const friend = await identities.open(await invitation(host.page, 'friend'));
    const input = friend.page.locator('#identity-tag');
    const tag = maximumLengthTag();
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('maxlength', String(tag.length));
    await expect(friend.page.locator('#identity-tag-hint')).toContainText(`1-${tag.length}`);
    expect(await friend.page.evaluate(() => AstervoidsConfig.IDENTITY_TAG_MAX_LENGTH)).toBe(tag.length);
    await input.pressSequentially(`${tag}7`);
    await expect(input).toHaveValue(tag);
    expect(await input.evaluate(element => element.checkValidity())).toBe(true);

    let submissions = 0;
    friend.page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/identity/invites/accept') submissions++;
    });
    for (const invalid of [`${tag}7`, 'bad tag', '']) {
        await input.evaluate((element, value) => { element.value = value; }, invalid);
        expect(await input.evaluate(element => element.checkValidity())).toBe(false);
        await friend.page.locator('#identity-accept').click();
        await expect(friend.page.locator('#identity-dialog')).toBeVisible();
        expect(submissions, 'Native validation blocks invalid names before an HTTP mutation').toBe(0);
    }
    await input.fill(tag);
    await completeIdentityAction(friend.page);
    await expect(friend.page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
    expect((await publicIdentity(friend.page)).tag).toBe(tag);
    expect(submissions).toBe(1);
});

test('friend invitations claim a name once and reconcile browser bindings with ignore or atomic replacement', async ({ identities }) => {
    const host = await identities.open();
    await namePlayer(host.page, 'Host');
    const hostIdentity = await publicIdentity(host.page);
    const friendLink = await invitation(host.page, 'friend');
    const secondFriendLink = await invitation(host.page, 'friend');
    expect(friendLink !== secondFriendLink, 'Every friend invitation is unique').toBe(true);
    expect(await publicIdentity(host.page)).toEqual(hostIdentity);
    const friend = await identities.open(friendLink);
    await namePlayer(friend.page, 'Friend');
    const friendIdentity = await publicIdentity(friend.page);
    expect(friendIdentity.id !== hostIdentity.id).toBe(true);
    expect((await invitation(friend.page, 'self')) === friendLink, 'The claimed friend link becomes their recovery link').toBe(true);

    const ignore = await identities.open(friendLink, host.context);
    await expect(ignore.page.locator('#identity-description')).toContainText('Replace Host');
    await completeIdentityAction(ignore.page, 'ignore');
    await expect(ignore.page.locator('#identity-status')).toHaveText('Playing as Host');
    await atRoot(ignore.page);
    expect(await publicIdentity(ignore.page)).toEqual(hostIdentity);

    await host.page.locator('#btn-solo').click();
    await expect(host.page.locator('#score')).toContainText('Host');
    const replace = await identities.open(friendLink, host.context);
    await expect(replace.page.locator('#identity-description')).toContainText('Friend');
    await completeIdentityAction(replace.page);
    await expect(replace.page.locator('#identity-status')).toHaveText('Playing as Friend');
    await expect(host.page.locator('#start-screen')).toBeVisible();
    await expect(host.page.locator('#identity-status')).toHaveText('Playing as Friend');
    expect(await publicIdentity(host.page)).toEqual(friendIdentity);
    await host.page.reload();
    await expect(host.page.locator('#identity-status')).toHaveText('Playing as Friend');
    await expect(host.page.locator('#identity-dialog')).not.toBeVisible();
});

test('a claimed-in-another-browser invitation requires fresh confirmation rather than silently renaming', async ({ identities }) => {
    const host = await identities.open();
    await namePlayer(host.page, 'Host');
    const link = await invitation(host.page, 'friend');
    const first = await identities.open(link);
    const second = await identities.open(link);
    await expect(first.page.locator('#identity-tag')).toBeVisible();
    await expect(second.page.locator('#identity-tag')).toBeVisible();
    await namePlayer(first.page, 'Winner');
    await second.page.locator('#identity-tag').fill('Other');
    await second.page.locator('#identity-accept').click();
    await expect(second.page.locator('#identity-title')).toHaveText('Confirm player identity');
    await expect(second.page.locator('#identity-description')).toContainText('Winner');
    expect(await publicIdentity(second.page)).toBeNull();
    await completeIdentityAction(second.page, 'ignore');
    await atRoot(second.page);
    expect(await publicIdentity(first.page)).toMatchObject({ tag: 'Winner' });
});

test('a pending invitation can replace a bound browser without deleting its previous identity', async ({ identities }) => {
    const original = await identities.open();
    await namePlayer(original.page, 'Original');
    const oldIdentity = await publicIdentity(original.page);
    const originalLink = await invitation(original.page, 'self');
    const pendingLink = await invitation(original.page, 'friend');
    const candidate = await identities.open(pendingLink, original.context);
    await expect(candidate.page.locator('#identity-description')).toContainText('replaces Original');
    await completeIdentityAction(candidate.page, 'ignore');
    await expect(candidate.page.locator('#identity-status')).toHaveText('Playing as Original');
    await candidate.page.goto(pendingLink);
    await namePlayer(candidate.page, 'NewPilot');
    expect((await publicIdentity(candidate.page)).id !== oldIdentity.id).toBe(true);
    await expect(original.page.locator('#identity-status')).toHaveText('Playing as NewPilot');
    const recovery = await identities.open(originalLink);
    await expect(recovery.page.locator('#identity-description')).toContainText('Original');
    await completeIdentityAction(recovery.page);
    await expect(recovery.page.locator('#identity-status')).toHaveText('Playing as Original');
    expect(await publicIdentity(recovery.page)).toEqual(oldIdentity);
});

test('a stale reconciliation dialog cannot replace a newer binding without another explicit decision', async ({ identities }) => {
    const original = await identities.open();
    await namePlayer(original.page, 'Original');
    const other = await identities.open();
    await namePlayer(other.page, 'Other');
    const otherLink = await invitation(other.page, 'self');
    const target = await identities.open();
    await namePlayer(target.page, 'Target');
    const targetLink = await invitation(target.page, 'self');
    const stale = await identities.open(targetLink, original.context);
    await expect(stale.page.locator('#identity-description')).toContainText('Replace Original');
    const fresh = await identities.open(otherLink, original.context);
    await completeIdentityAction(fresh.page);
    await expect(fresh.page.locator('#identity-status')).toHaveText('Playing as Other');
    await stale.page.locator('#identity-accept').click();
    await expect(stale.page.locator('#identity-description')).toContainText('Replace Other');
    await expect(stale.page.locator('#identity-error')).toContainText('changed');
    expect((await publicIdentity(stale.page)).tag).toBe('Other');
    await completeIdentityAction(stale.page, 'ignore');
    await expect(stale.page.locator('#identity-status')).toHaveText('Playing as Other');
});

test('clipboard rejection offers the same selectable link and responsive menu groups preserve native text', async ({ identities }) => {
    const player = await identities.open();
    await namePlayer(player.page, 'Pilot_1');
    await player.page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
        } });
    });
    let generated = 0;
    player.page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/identity/invites') generated++;
    });
    await player.page.locator('#btn-invite-friend').click();
    await expect(player.page.locator('#invite-share-dialog')).toBeVisible();
    await expect(player.page.locator('#identity-notice')).not.toBeVisible();
    const original = await player.page.locator('#invite-share-url').inputValue();
    await player.page.locator('#invite-share-copy').click();
    await expect(player.page.locator('#invite-share-error')).toContainText('denied');
    expect((await player.page.locator('#invite-share-url').inputValue()) === original).toBe(true);
    expect(generated).toBe(1);
    await player.page.locator('#invite-share-close').click();
    for (const viewport of [
        { width: 900, height: 550 }, { width: 568, height: 320 },
        { width: 360, height: 800 }, { width: 320, height: 568 },
    ]) {
        await player.page.setViewportSize(viewport);
        const boxes = await player.page.evaluate(() => {
            const left = document.getElementById('menu-play').getBoundingClientRect();
            const right = document.getElementById('menu-utilities').getBoundingClientRect();
            const solo = document.getElementById('btn-solo').getBoundingClientRect();
            return {
                sideBySide: right.left >= left.right,
                stacked: right.top >= left.bottom,
                nativeText: getComputedStyle(document.getElementById('start-screen-content')).transform === 'none',
                matchesRows: [...document.querySelectorAll('#menu-utilities button')]
                    .every(button => {
                        const box = button.getBoundingClientRect();
                        const paired = button.parentElement.classList.contains('button-row')
                            && [...button.parentElement.children].filter(sibling => sibling.getClientRects().length).length === 2;
                        const width = paired ? (solo.width - 7.2) / 2 : solo.width;
                        return Math.abs(box.width - width) < 0.05 && box.height === solo.height;
                    }),
                fits: right.right <= innerWidth && left.left >= 0,
            };
        });
        expect(boxes.nativeText && boxes.matchesRows && boxes.fits).toBe(true);
        expect(viewport.width > viewport.height ? boxes.sideBySide : boxes.stacked).toBe(true);
    }
});
