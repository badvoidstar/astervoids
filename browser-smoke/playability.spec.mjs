import { test as base, expect } from '@playwright/test';
import { installOriginGuard } from './origin-guard.mjs';

const test = base.extend({
    players: async ({ browser, baseURL }, use) => {
        const opened = [];
        let ownedSessionId;
        const players = {
            ownSession(id) { ownedSessionId = id; },
            async open() {
                const context = await browser.newContext({
                    baseURL,
                    viewport: { width: 1280, height: 900 },
                    serviceWorkers: 'block',
                });
                context.setDefaultTimeout(15_000);
                context.setDefaultNavigationTimeout(30_000);
                const page = await context.newPage();
                const health = {
                    uncaught: 0, consoleErrors: 0, hubFrames: 0,
                    offOrigin: 0, redirects: 0, requestFailures: 0,
                };
                opened.push({ context, page, health });
                page.on('pageerror', () => health.uncaught++);
                page.on('console', message => {
                    if (message.type() === 'error') health.consoleErrors++;
                });
                page.on('websocket', socket => {
                    const url = new URL(socket.url());
                    if (url.pathname === '/sessionHub') {
                        socket.on('framereceived', () => health.hubFrames++);
                    }
                });
                // No fabricated responses: reject redirects before Chromium
                // follows them, keeping native HTTP and hub WebSockets intact.
                await installOriginGuard(page, baseURL, health);
                await page.goto('/');
                await expect(page.locator('#game')).toBeVisible();
                await expect(page.locator('#start-screen')).toBeVisible();
                await expect(page.locator('#btn-solo')).toBeEnabled();
                return { page, health };
            },
        };
        try {
            await use(players);
        } finally {
            const cleanupFailures = [];
            for (const { page } of [...opened].reverse()) {
                try {
                    if (await page.evaluate(() => window.SessionClient?.isInSession() ?? false)) {
                        await leave(page);
                    }
                } catch {
                    cleanupFailures.push('UI leave failed');
                }
            }
            if (ownedSessionId && opened.length) {
                try {
                    await expect.poll(async () => {
                        const response = await opened[0].context.request.get('/api/sessions', { maxRedirects: 0 });
                        if (!response.ok()) return false;
                        const result = await response.json();
                        return Array.isArray(result.sessions)
                            && !result.sessions.some(session => session.id === ownedSessionId);
                    }, { message: 'The isolated smoke session has no active members after cleanup' }).toBe(true);
                } catch {
                    cleanupFailures.push('Session remained active');
                }
            }
            for (const { context } of opened) await context.close();
            expect(cleanupFailures, 'All smoke clients leave; empty sessions expire normally').toEqual([]);
            for (const { health } of opened) {
                expect(health.uncaught, 'No uncaught browser exceptions').toBe(0);
                expect(health.consoleErrors, 'No browser console errors').toBe(0);
                expect(health.offOrigin, 'No requests leave the selected origin').toBe(0);
                expect(health.redirects, 'No HTTP redirects are followed').toBe(0);
                expect(health.requestFailures, 'No guarded HTTP requests fail').toBe(0);
            }
        }
    },
});

async function playing(page) {
    await expect(page.locator('#start-screen')).toBeHidden();
    await expect(page.locator('#hud')).toBeVisible();
    await expect(page.locator('#wave')).toHaveText(/^Wave: [1-9]\d*$/);
    await expect.poll(() => page.evaluate(() =>
        game.ship != null && ['playing', 'waveDelay'].includes(game.state)),
    { message: 'A live player ship exists in the running game' }).toBe(true);
}

async function leave(page) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => SessionClient.isInSession()),
        { message: 'Voluntary leave clears client membership' }).toBe(false);
}

async function join(page, sessionId) {
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await expect.poll(() => page.evaluate(id => SessionClient.getCurrentSession()?.id === id, sessionId),
        { message: 'The selected session is joined through the picker' }).toBe(true);
}

async function membership(page, sessionId, count) {
    await expect.poll(() => page.evaluate(({ id, count }) => {
        const session = SessionClient.getCurrentSession();
        return session?.id === id && session.members.length === count;
    }, { id: sessionId, count }), { message: 'Live membership converges through SignalR' }).toBe(true);
}

async function shipId(page) {
    await expect.poll(() => page.evaluate(() => ObjectSync.getObjectsByType('ship')
        .some(object => object.ownerMemberId === SessionClient.getCurrentMember()?.id)),
    { message: 'The local ship is network-backed, not the local-only fallback' }).toBe(true);
    return page.evaluate(() => ObjectSync.getObjectsByType('ship')
        .find(object => object.ownerMemberId === SessionClient.getCurrentMember()?.id).id);
}

async function replicatedThrust(sender, receiver, id) {
    await expect.poll(() => receiver.evaluate(id => !!ObjectSync.getObject(id), id),
        { message: 'The other browser receives the player ship' }).toBe(true);
    const before = await receiver.evaluate(id => {
        const object = ObjectSync.getObject(id);
        return { x: object.data.x, y: object.data.y, version: object.version };
    }, id);
    await sender.keyboard.down('ArrowUp');
    try {
        await expect.poll(() => receiver.evaluate(({ id, before }) => {
            const object = ObjectSync.getObject(id);
            return !!object?.data.thrusting && object.version > before.version
                && Math.hypot(object.data.x - before.x, object.data.y - before.y) > 0.00001;
        }, { id, before }), { message: 'Real keyboard thrust changes pose and version in the other browser' }).toBe(true);
    } finally {
        await sender.keyboard.up('ArrowUp');
    }
    await expect.poll(() => receiver.evaluate(id => ObjectSync.getObject(id)?.data.thrusting === false, id),
        { message: 'The other browser receives released thrust, not just a stale snapshot' }).toBe(true);
}

test('page boots and solo play responds to keyboard input', async ({ players }) => {
    const { page } = await players.open();
    await page.locator('#btn-solo').click();
    await playing(page);
    await expect(page.locator('#session-indicator')).toBeHidden();
    const before = await page.evaluate(() => ({ x: game.ship.x, y: game.ship.y }));
    await page.keyboard.down('ArrowUp');
    try {
        await expect.poll(() => page.evaluate(before =>
            Math.hypot(game.ship.x - before.x, game.ship.y - before.y) > 0.00001, before),
        { message: 'The solo simulation moves the ship after keyboard input' }).toBe(true);
    } finally {
        await page.keyboard.up('ArrowUp');
    }
    await page.keyboard.down('Space');
    try {
        await expect.poll(() => page.evaluate(() => game.bullets.length),
            { message: 'The solo player can fire' }).toBeGreaterThan(0);
    } finally {
        await page.keyboard.up('Space');
    }
});

test('independent players create, join, play, leave and rejoin', async ({ players }) => {
    const host = await players.open();
    const guest = await players.open();
    let sessionId;
    await test.step('create and join an isolated session through the UI', async () => {
        await host.page.locator('#btn-leave-create').click();
        await expect(host.page.locator('#btn-start-enter')).toBeVisible();
        await expect(host.page.locator('#btn-start-enter')).toHaveText('Start');
        sessionId = await host.page.evaluate(() => SessionClient.getCurrentSession().id);
        players.ownSession(sessionId);
        await join(guest.page, sessionId);
        await Promise.all([membership(host.page, sessionId, 2), membership(guest.page, sessionId, 2)]);
        const hostMember = await host.page.evaluate(() => SessionClient.getCurrentMember().id);
        expect(await guest.page.evaluate(id => SessionClient.getCurrentMember().id !== id, hostMember),
            'Independent contexts have distinct members').toBe(true);
    });
    let guestShip;
    await test.step('start both players and observe bidirectional live input replication', async () => {
        await host.page.locator('#btn-start-enter').click();
        await guest.page.locator('#btn-start-enter').click();
        await Promise.all([playing(host.page), playing(guest.page)]);
        await expect(guest.page.locator('#session-indicator')).toHaveText(
            await host.page.locator('#session-indicator').innerText());
        const hostShip = await shipId(host.page);
        guestShip = await shipId(guest.page);
        await replicatedThrust(host.page, guest.page, hostShip);
        await replicatedThrust(guest.page, host.page, guestShip);
        expect(host.health.hubFrames, 'Host receives real hub WebSocket frames').toBeGreaterThan(0);
        expect(guest.health.hubFrames, 'Guest receives real hub WebSocket frames').toBeGreaterThan(0);
    });
    await test.step('leave, remove the departed ship, then rejoin the same live game', async () => {
        await leave(guest.page);
        await membership(host.page, sessionId, 1);
        await expect.poll(() => host.page.evaluate(id => !!ObjectSync.getObject(id), guestShip),
            { message: 'Departure removes the member-scoped ship from the other player' }).toBe(false);
        await join(guest.page, sessionId);
        await guest.page.locator('#btn-start-enter').click();
        await playing(guest.page);
        await Promise.all([membership(host.page, sessionId, 2), membership(guest.page, sessionId, 2)]);
        const rejoinedShip = await shipId(guest.page);
        expect(rejoinedShip !== guestShip, 'Rejoin creates a fresh network-backed ship').toBe(true);
        await replicatedThrust(guest.page, host.page, rejoinedShip);
    });
});
