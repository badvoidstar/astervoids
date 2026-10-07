import { test as base, expect } from '@playwright/test';
import { captureClipboard, completeIdentityAction, invitation, maximumLengthTag, namePlayer, openIdentityNaming } from './identity-helpers.mjs';
import { installOriginGuard } from './origin-guard.mjs';

const test = base.extend({
    identities: async ({ browser, baseURL }, use) => {
        const contexts = [];
        const guards = [];
        let uncaught = 0;
        const identities = {
            async open(path = '/', context = null) {
                if (!context) {
                    context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
                    contexts.push(context);
                }
                const page = await context.newPage();
                page.on('pageerror', () => { uncaught++; });
                const health = { offOrigin: 0, redirects: 0, requestFailures: 0 };
                guards.push(health);
                await installOriginGuard(page, baseURL, health);
                await captureClipboard(page);
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
                expect(health, 'Identity flows stay on the selected origin without redirects or failed requests')
                    .toEqual({ offOrigin: 0, redirects: 0, requestFailures: 0 });
            }
        }
    },
});

const publicIdentity = page => page.evaluate(() => PlayerIdentity.current());
const atRoot = page => expect.poll(() => page.evaluate(() =>
    location.pathname === '/' && location.hash === '' && location.search === ''),
{ message: 'Only the site root remains in the address bar' }).toBe(true);

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
    await player.page.route('**/api/identity/resolve', route => route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'identity_unavailable' } }),
    }));
    await player.page.reload();
    await expect(player.page.locator('#identity-title')).toHaveText('Player identity unavailable');
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
        await expect(player.page.locator('#identity-description')).toContainText('Checking');
        await expect(player.page.locator('#identity-ignore')).toBeDisabled();
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
                matchesSolo: [...document.querySelectorAll('#menu-utilities button')]
                    .every(button => {
                        const box = button.getBoundingClientRect();
                        return Math.abs(box.width - solo.width) < 0.05 && box.height === solo.height;
                    }),
                fits: right.right <= innerWidth && left.left >= 0,
            };
        });
        expect(boxes.nativeText && boxes.matchesSolo && boxes.fits).toBe(true);
        expect(viewport.width > viewport.height ? boxes.sideBySide : boxes.stacked).toBe(true);
    }
});
