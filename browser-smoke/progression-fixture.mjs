import { test as base, expect } from '@playwright/test';
import { configureAutomatedIdentities } from './automated-identities.mjs';
import { provisionPlayer } from './identity-helpers.mjs';
import { installOriginGuard } from './origin-guard.mjs';

export const test = base.extend({
    players: async ({ browser, baseURL }, use) => {
        const opened = [];
        let sessionId;
        const players = {
            ownSession(id) { sessionId = id; },
            async open({ viewport = { width: 1280, height: 900 }, touch = false } = {}) {
                const context = await browser.newContext({
                    baseURL, viewport, hasTouch: touch, isMobile: touch, serviceWorkers: 'block',
                });
                context.setDefaultTimeout(15_000);
                await configureAutomatedIdentities(context);
                const tag = `XpPilot${opened.length + 1}`;
                await provisionPlayer(context, tag);
                const page = await context.newPage();
                const health = {
                    uncaught: 0, consoleErrors: 0, hubFrames: 0, scoreRequests: 0,
                    offOrigin: 0, redirects: 0, requestFailures: 0,
                };
                opened.push({ page, context, health });
                page.on('pageerror', () => health.uncaught++);
                page.on('console', message => {
                    if (message.type() === 'error') health.consoleErrors++;
                });
                page.on('request', request => {
                    if (new URL(request.url()).pathname === '/api/leaderboard/scores') health.scoreRequests++;
                });
                page.on('websocket', socket => {
                    if (new URL(socket.url()).pathname === '/sessionHub') {
                        socket.on('framereceived', () => health.hubFrames++);
                    }
                });
                await installOriginGuard(page, baseURL, health);
                await page.goto('/');
                await expect(page.locator('#btn-solo')).toBeEnabled();
                await expect(page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
                expect(await page.evaluate(() => PlayerIdentity.current()?.excludeFromLeaderboards))
                    .toBe(true);
                return { page, health };
            },
        };
        try {
            await use(players);
        } finally {
            const cleanup = [];
            for (const { page } of [...opened].reverse()) {
                try {
                    if (await page.evaluate(() => SessionClient.isInSession())) await leaveGame(page);
                } catch {
                    cleanup.push('Membership cleanup failed');
                }
            }
            if (sessionId && opened.length) {
                try {
                    await expect.poll(async () => {
                        const response = await opened[0].context.request.get('/api/sessions', { maxRedirects: 0 });
                        if (!response.ok()) return false;
                        const result = await response.json();
                        return Array.isArray(result.sessions)
                            && !result.sessions.some(session => session.id === sessionId);
                    }, { message: 'The isolated progression session has no remaining members' }).toBe(true);
                } catch {
                    cleanup.push('Progression session remained active');
                }
            }
            for (const { context } of opened) await context.close();
            expect(cleanup).toEqual([]);
            for (const { health } of opened) {
                expect(health.uncaught, 'No uncaught gameplay exceptions').toBe(0);
                expect(health.consoleErrors, 'No browser errors').toBe(0);
                expect(health.offOrigin, 'No requests leave the selected origin').toBe(0);
                expect(health.redirects, 'No redirects are followed').toBe(0);
                expect(health.requestFailures, 'No guarded request fails').toBe(0);
                expect(health.scoreRequests, 'Progression automation never submits durable leaderboard scores').toBe(0);
            }
        }
    },
});

export async function playing(page) {
    await expect(page.locator('#start-screen')).toBeHidden();
    await expect.poll(() => page.evaluate(() =>
        !!game.ship && ['playing', 'waveDelay'].includes(game.state)),
    { message: 'The live game owns a controllable ship' }).toBe(true);
}

export async function leaveGame(page) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => SessionClient.isInSession()),
        { message: 'Real UI leave clears SignalR membership' }).toBe(false);
}

export async function createSession(page) {
    await page.locator('#btn-leave-create').click();
    await expect.poll(() => page.evaluate(() =>
        !!SessionClient.getCurrentSession()?.id && !!game.sessionInfo?.memberId)).toBe(true);
    await expect(page.locator('#btn-start-enter')).toHaveText('Start');
    return page.evaluate(() => SessionClient.getCurrentSession().id);
}

export async function joinSession(page, id) {
    await page.locator(`.session-item[data-session-id="${id}"]`).click();
    await expect.poll(() => page.evaluate(id => {
        const session = SessionClient.getCurrentSession();
        return session?.id === id && game.sessionInfo?.id === id
            && game.sessionInfo.memberId === SessionClient.getCurrentMember()?.id;
    }, id), { message: 'The independent browser really joins the selected session' }).toBe(true);
}

export async function enterSession(page) {
    await expect(page.locator('#btn-start-enter')).toBeEnabled();
    await page.locator('#btn-start-enter').click();
    await playing(page);
    await expect.poll(() => page.evaluate(() => !!game.ship?.syncObjectId
        && !!ObjectSync.getObject(game.ship.syncObjectId)),
    { message: 'The player ship is an accepted SignalR object, not a local fallback' }).toBe(true);
}

export async function fireOnce(page) {
    await expect.poll(() => page.evaluate(() => game.ship.shootCooldown <= 0)).toBe(true);
    const before = await page.evaluate(() => game.bullets.map(bullet => bullet.damageId));
    await page.keyboard.down('Space');
    try {
        await page.waitForFunction(ids => game.bullets.some(bullet =>
            !bullet.pendingHit && !ids.includes(bullet.damageId)), before, { polling: 'raf' });
    } finally {
        await page.keyboard.up('Space');
    }
    return page.evaluate(ids => game.bullets.filter(bullet =>
        !ids.includes(bullet.damageId)).map(bullet => bullet.damageId), before);
}
