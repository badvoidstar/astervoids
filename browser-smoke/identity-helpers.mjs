import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';

const { IDENTITY_TAG_MAX_LENGTH } = createRequire(import.meta.url)('../AstervoidsWeb/wwwroot/js/game-config.js');

export function maximumLengthTag(pattern = 'A_b-') {
    return pattern.repeat(IDENTITY_TAG_MAX_LENGTH).slice(0, IDENTITY_TAG_MAX_LENGTH);
}

// Gameplay fixtures use real durable identities without repeating the welcome
// dialog in every scenario. The identity spec exercises that UI separately.
export async function provisionPlayer(context, tag) {
    const credential = randomBytes(32).toString('base64url');
    const headers = { 'X-Astervoids-Browser': credential };
    const resolve = await context.request.post('/api/identity/resolve', {
        headers, data: {}, maxRedirects: 0,
    });
    expect(resolve.status(), 'Real identity resolution succeeds').toBe(200);
    const view = await resolve.json();
    const create = await context.request.post('/api/identity/root', {
        headers, maxRedirects: 0,
        data: {
            requestId: randomUUID(), expectedBinding: {
                identityId: null, etag: view.binding.etag,
            }, tag,
        },
    });
    expect(create.status(), 'Real backend persists the gameplay fixture identity').toBe(201);
    await context.addInitScript(value => {
        localStorage.setItem('astervoids.browser-binding', value);
    }, credential);
}

export async function completeIdentityAction(page, action = 'accept') {
    await Promise.all([
        page.waitForEvent('domcontentloaded'),
        page.locator(`#identity-${action}`).click(),
    ]);
}

export async function namePlayer(page, tag) {
    await expect.poll(() => page.evaluate(() =>
        !document.getElementById('identity-name-field').hidden
        || document.getElementById('identity-status').textContent === 'Playing as guest'),
    { message: 'A fresh browser receives naming or the configured guest menu' }).toBe(true);
    if (!await page.locator('#identity-tag').isVisible()) {
        await page.locator('#btn-invite-self').click();
    }
    await expect(page.locator('#identity-tag')).toBeVisible();
    await page.locator('#identity-tag').fill(tag);
    await completeIdentityAction(page);
    await expect.poll(() => page.evaluate(() =>
        location.pathname === '/' && location.search === '' && location.hash === ''),
    { message: 'Onboarding replaces the invitation URL with the site root' }).toBe(true);
    await expect(page.locator('#identity-dialog')).not.toBeVisible();
    await expect(page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
}

export async function captureClipboard(page) {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async value => { window.smokeClipboard = value; } },
        });
    });
}

export async function invitation(page, kind) {
    await page.evaluate(() => { window.smokeClipboard = null; });
    await page.locator(`#btn-invite-${kind}`).click();
    await expect.poll(() => page.evaluate(() => typeof window.smokeClipboard === 'string'),
        { message: 'The current invite operation completes its clipboard write' }).toBe(true);
    await expect(page.locator('#identity-notice')).toContainText('Ready to share');
    const link = await page.evaluate(() => window.smokeClipboard);
    expect(typeof link === 'string' && new URL(link).hash.startsWith('#invite='),
        'The clipboard receives a private fragment capability').toBe(true);
    return link;
}
