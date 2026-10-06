import { test as base, expect } from '@playwright/test';
import { captureClipboard, completeIdentityAction, invitation, namePlayer } from './identity-helpers.mjs';
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

test('ten-character root naming survives reload, solo play, self recovery and new-browser confirmation', async ({ identities }) => {
    const original = await identities.open();
    const tag = 'A_b-123456';
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

test('identity entry enforces the ten-character limit when typing and submitting', async ({ identities }) => {
    const host = await identities.open();
    await namePlayer(host.page, 'Host');
    const friend = await identities.open(await invitation(host.page, 'friend'));
    const input = friend.page.locator('#identity-tag');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('maxlength', '10');
    await expect(friend.page.locator('label[for="identity-tag"]')).toContainText('1-10');
    const tag = 'A_b-123456';
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
