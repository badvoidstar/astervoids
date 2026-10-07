import { test as base, expect } from '@playwright/test';
import { installOriginGuard } from './origin-guard.mjs';
import { maximumLengthTag, provisionPlayer } from './identity-helpers.mjs';
import {
    rankedPersonalResults, personalRows, personalHudScores, personalScoreGeometry, personalViewResizeState,
} from './personal-scores.mjs';

const test = base.extend({
    players: async ({ browser, baseURL }, use) => {
        const opened = [];
        let ownedSessionId;
        const players = {
            ownSession(id) { ownedSessionId = id; },
            async open(options = {}) {
                const context = await browser.newContext({
                    baseURL,
                    viewport: options.viewport ?? { width: 1280, height: 900 },
                    hasTouch: options.hasTouch ?? false,
                    isMobile: options.isMobile ?? false,
                    serviceWorkers: 'block',
                });
                context.setDefaultTimeout(15_000);
                context.setDefaultNavigationTimeout(30_000);
                const tag = options.tag ?? `Pilot${opened.length + 1}`;
                await provisionPlayer(context, tag);
                const page = await context.newPage();
                const health = {
                    uncaught: 0, consoleErrors: 0, hubFrames: 0,
                    offOrigin: 0, redirects: 0, requestFailures: 0,
                };
                opened.push({ context, page, health, closed: false });
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
                await page.goto(options.path ?? '/');
                await expect(page.locator('#game')).toBeVisible();
                await expect(page.locator('#start-screen')).toBeVisible();
                await expect(page.locator('#btn-solo')).toBeEnabled();
                await expect(page.locator('#identity-dialog')).not.toBeVisible();
                await expect(page.locator('#identity-status')).toHaveText(`Playing as ${tag}`);
                return { page, health, tag };
            },
            async close(player) {
                const entry = opened.find(({ page }) => page === player.page);
                if (!entry || entry.closed) throw new Error('Only an open smoke context can be closed');
                if (await player.page.evaluate(() => SessionClient.isInSession())) {
                    await leave(player.page);
                }
                await entry.context.close();
                entry.closed = true;
            },
        };
        try {
            await use(players);
        } finally {
            const cleanupFailures = [];
            for (const { page } of opened.filter(entry => !entry.closed).reverse()) {
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
            for (const { context } of opened.filter(entry => !entry.closed)) await context.close();
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

async function sessionReady(page, sessionId = null) {
    await expect.poll(() => page.evaluate(id => {
        const session = SessionClient.getCurrentSession();
        const member = SessionClient.getCurrentMember();
        return !!session?.id && (id === null || session.id === id) && !!member?.id
            && session.members.some(candidate => candidate.id === member.id)
            && game.sessionInfo?.id === session.id && game.sessionInfo.memberId === member.id;
    }, sessionId), { message: 'Live membership and game session setup are ready' }).toBe(true);
}

async function create(page) {
    await page.locator('#btn-leave-create').click();
    await sessionReady(page);
    await expect(page.locator('#btn-start-enter')).toBeVisible();
    await expect(page.locator('#btn-start-enter')).toHaveText('Start');
    await expect(page.locator('#btn-start-enter')).toBeEnabled();
    await expect(page.locator('#create-region-row')).toBeHidden();
    await expect(page.locator('#create-region-select')).toBeHidden();
    return page.evaluate(() => SessionClient.getCurrentSession().id);
}

async function join(page, sessionId) {
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await expect.poll(() => page.evaluate(id => SessionClient.getCurrentSession()?.id === id, sessionId),
        { message: 'The selected session is joined through the picker' }).toBe(true);
    await sessionReady(page, sessionId);
    await expect(page.locator('#create-region-row')).toBeHidden();
    await expect(page.locator('#create-region-select')).toBeHidden();
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

async function swipeTouch(page, cdp, x, fromY, toY) {
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y: fromY, id: 1 }],
    });
    try {
        for (let step = 1; step <= 12; step++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove', touchPoints: [{ x, y: fromY + (toY - fromY) * step / 12, id: 1 }],
            });
            await page.waitForTimeout(20);
        }
        // End at rest so the next opposite swipe measures panning, not leftover inertia.
        await page.waitForTimeout(100);
    } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
}

test('page boots and solo play responds to keyboard input', async ({ players }) => {
    const { page } = await players.open();
    await page.locator('#btn-solo').click();
    await playing(page);
    await expect(page.locator('#session-indicator')).toBeHidden();
    await expect(page.locator('#instructions')).toContainText('P to pause (solo)');
    await expect(page.locator('#instructions')).not.toContainText('ESC to pause');
    await page.keyboard.press('p');
    await expect(page.locator('#pause-menu')).toBeVisible();
    await page.keyboard.press('Enter');
    await playing(page);
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

for (const touch of [false, true]) {
    test(`menu selectors cycle once per ${touch ? 'tap' : 'click'} and keep their shared row`, async ({ players }) => {
        const { page } = await players.open({ hasTouch: touch, isMobile: touch });
        const difficulty = page.locator('#btn-difficulty');
        const controls = page.locator('#btn-control-mode');
        const activate = locator => touch ? locator.tap() : locator.click();
        await expect(difficulty).toHaveText('🎯 : Survivor');
        await expect(controls).toHaveText('🕹️ : Polar');
        let controlLabel = 'Polar';
        for (const viewport of [{ width: 400, height: 300 }, { width: 320, height: 568 }]) {
            await page.setViewportSize(viewport);
            for (const [label, value] of [
                ['Shifter', 0.2], ['Dancer', 0.35], ['Raver', 0.5], ['Survivor', 0.65],
            ]) {
                await activate(difficulty);
                await expect(difficulty).toHaveText(`🎯 : ${label}`);
                expect(await page.evaluate(() => [
                    CONFIG.ASTEROID_DIFFICULTY_FACTOR, LOCAL_CONFIG_BASELINE.ASTEROID_DIFFICULTY_FACTOR,
                ])).toEqual([value, value]);
                await activate(controls);
                controlLabel = controlLabel === 'Polar' ? 'Boxy' : 'Polar';
                await expect(controls).toHaveText(`🕹️ : ${controlLabel}`);
                await expect(controls).toHaveCSS('text-transform', 'uppercase');
                expect(await page.evaluate(() => getAnalogControlScheme()))
                    .toBe(controlLabel === 'Boxy' ? 'rectilinear' : 'polar');
                const geometry = await page.evaluate(() => {
                    const controls = document.getElementById('btn-control-mode');
                    const difficulty = document.getElementById('btn-difficulty');
                    const left = controls.getBoundingClientRect();
                    const right = difficulty.getBoundingClientRect();
                    return {
                        sameRow: controls.parentElement === difficulty.parentElement,
                        gap: right.left - left.right, offset: right.top - left.top,
                        widthDifference: right.width - left.width,
                        clipped: [controls, difficulty].filter(button =>
                            button.scrollWidth > button.clientWidth || button.scrollHeight > button.clientHeight
                            || button.getBoundingClientRect().height !== 32
                            || button.getBoundingClientRect().left < 0
                            || button.getBoundingClientRect().right > innerWidth
                            || getComputedStyle(button).transform !== 'none').map(button => button.id),
                    };
                });
                expect(geometry.sameRow).toBe(true);
                expect(geometry.gap).toBeCloseTo(7.2, 1);
                expect(geometry.offset).toBeCloseTo(0, 1);
                expect(geometry.widthDifference).toBeCloseTo(0, 1);
                expect(geometry.clipped, `${controlLabel}/${label} at ${viewport.width}x${viewport.height}`).toEqual([]);
            }
        }
        await activate(difficulty);
        await activate(difficulty);
        await expect(difficulty).toHaveText('🎯 : Dancer');
        await activate(page.locator('#btn-solo'));
        await playing(page);
        expect(await page.evaluate(() => CONFIG.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.35);
        await page.keyboard.press('p');
        await expect(page.locator('#pause-menu')).toBeVisible();
        if (touch) {
            await page.locator('#pause-restart-btn').tap();
        } else {
            await page.keyboard.down('Escape');
            try {
                await expect(page.locator('#start-screen')).toBeVisible();
            } finally {
                await page.keyboard.up('Escape');
            }
        }
        await expect(page.locator('#start-screen')).toBeVisible();
        await expect(difficulty).toHaveText('🎯 : Dancer');
        await expect(difficulty).toBeEnabled();
    });
}

test('Raver difficulty follows the creator and leaving restores each local preset', async ({ players }) => {
    const host = await players.open();
    const guest = await players.open({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    await host.page.locator('#btn-difficulty').click();
    await host.page.locator('#btn-difficulty').click();
    await host.page.locator('#btn-difficulty').click();
    await guest.page.locator('#btn-difficulty').tap();
    await expect(host.page.locator('#btn-difficulty')).toHaveText('🎯 : Raver');
    await expect(guest.page.locator('#btn-difficulty')).toHaveText('🎯 : Shifter');
    const sessionId = await create(host.page);
    players.ownSession(sessionId);
    await join(guest.page, sessionId);
    for (const player of [host, guest]) {
        await expect(player.page.locator('#btn-difficulty')).toHaveText('🎯 : Raver');
        await expect(player.page.locator('#btn-difficulty')).toBeDisabled();
        await expect(player.page.locator('#btn-control-mode')).toBeEnabled();
        expect(await player.page.evaluate(() => CONFIG.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.5);
    }
    await guest.page.locator('#btn-control-mode').tap();
    await expect(guest.page.locator('#btn-control-mode')).toHaveText('🕹️ : Boxy');
    await guest.page.evaluate(() => document.getElementById('btn-difficulty').click());
    expect(await guest.page.evaluate(() => [
        CONFIG.ASTEROID_DIFFICULTY_FACTOR, LOCAL_CONFIG_BASELINE.ASTEROID_DIFFICULTY_FACTOR,
    ])).toEqual([0.5, 0.2]);
    await host.page.locator('#btn-start-enter').click();
    await guest.page.locator('#btn-start-enter').tap();
    await Promise.all([playing(host.page), playing(guest.page)]);
    for (const player of [host, guest]) {
        expect(await player.page.evaluate(() => CONFIG.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.5);
    }
    await leave(guest.page);
    await expect(guest.page.locator('#btn-difficulty')).toHaveText('🎯 : Shifter');
    await expect(guest.page.locator('#btn-difficulty')).toBeEnabled();
    await guest.page.locator('#btn-difficulty').tap();
    await expect(guest.page.locator('#btn-difficulty')).toHaveText('🎯 : Dancer');
    await leave(host.page);
    await expect(host.page.locator('#btn-difficulty')).toHaveText('🎯 : Raver');
    await expect(host.page.locator('#btn-difficulty')).toBeEnabled();
});

test('custom difficulty from URL and live debug tuning stays honest until a preset click', async ({ players }) => {
    const { page } = await players.open({ path: '/?cfg.ASTEROID_DIFFICULTY_FACTOR=0.75' });
    const difficulty = page.locator('#btn-difficulty');
    await expect(difficulty).toHaveText('🎯 : Custom');
    await expect(difficulty).toHaveAttribute('aria-label', /Custom \(0\.75\)/);
    expect(await page.evaluate(() => CONFIG.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.75);
    await page.evaluate(() => {
        const channel = new BroadcastChannel('astervoids-debug');
        channel.postMessage({ type: 'config-update', key: 'ASTEROID_DIFFICULTY_FACTOR', value: 1.4 });
        channel.close();
    });
    await expect(difficulty).toHaveAttribute('aria-label', /Custom \(1\.4\)/);
    await difficulty.click();
    await expect(difficulty).toHaveText('🎯 : Shifter');
    expect(await page.evaluate(() => CONFIG.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.2);
});

test('main-menu buttons share size and brightness with compact spacing in portrait, landscape and lobbies', async ({ players }) => {
    const { page } = await players.open();
    async function expectMatchingButtons(inSession) {
        const ids = [
            'btn-leave-create', ...(inSession ? ['btn-start-enter'] : []), 'btn-solo',
            'btn-fullscreen', 'btn-control-mode', 'btn-difficulty', 'btn-invite-self', 'btn-invite-friend',
        ];
        for (const viewport of [
            { width: 1280, height: 900 }, { width: 900, height: 550 },
            { width: 568, height: 320 }, { width: 400, height: 300 },
            { width: 360, height: 800 }, { width: 320, height: 568 },
        ]) {
            await page.setViewportSize(viewport);
            await page.mouse.move(0, 0);
            const buttons = await page.evaluate(() => {
                const elements = [...document.querySelectorAll('#menu-columns .picker-btn')]
                    .filter(button => button.getClientRects().length > 0);
                return elements.map(button => {
                    const box = button.getBoundingClientRect();
                    const style = getComputedStyle(button);
                    return {
                        id: button.id, width: box.width, height: box.height,
                        disabled: button.disabled,
                        paired: button.parentElement.classList.contains('button-row')
                            && [...button.parentElement.children].filter(sibling => sibling.getClientRects().length).length === 2,
                        fontSize: style.fontSize, nativeText: style.transform === 'none',
                        fits: box.left >= 0 && box.right <= innerWidth
                            && button.scrollWidth <= button.clientWidth
                            && button.scrollHeight <= button.clientHeight,
                    };
                });
            });
            expect(buttons.map(button => button.id)).toEqual(ids);
            const solo = buttons.find(button => button.id === 'btn-solo');
            for (const button of buttons) {
                const label = `${button.id} at ${viewport.width}x${viewport.height}`;
                const invite = button.id.startsWith('btn-invite-');
                const paired = button.paired;
                expect(button.width, `${label} ${paired ? 'shares its row equally' : 'matches Solo Play width'}`)
                    .toBeCloseTo(paired ? (solo.width - 7.2) / 2 : solo.width, 1);
                expect(button.height, `${label} matches Solo Play height`).toBeCloseTo(solo.height, 1);
                expect(button.fontSize, `${label} uses Solo Play native font size`).toBe(solo.fontSize);
                expect(button.nativeText && button.fits, `${label} fits without stretching or clipping`).toBe(true);
                if (button.id === 'btn-difficulty') {
                    expect(button.disabled, `${label} is locked only for the shared session`).toBe(inSession);
                }
                if (!button.disabled) {
                    await expect(page.locator(`#${button.id}`), `${label} has a full-bright label`)
                        .toHaveCSS('color', 'rgb(255, 255, 255)');
                    await expect(page.locator(`#${button.id}`), `${label} is not dimmed`)
                        .toHaveCSS('opacity', '1');
                }
                if (invite) {
                    await expect(page.locator(`#${button.id}`), `${label} keeps its neutral border`)
                        .toHaveCSS('border-color', 'rgb(136, 136, 136)');
                    await expect(page.locator(`#${button.id}`), `${label} keeps its transparent background`)
                        .toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
                }
            }
            expect(solo.height, 'Solo Play retains its compact reference height').toBe(32);
            const spacing = await page.evaluate(() => {
                const box = selector => document.querySelector(selector).getBoundingClientRect();
                const banner = box('#region-banner');
                const statusNext = banner.height ? banner : box('#menu-columns');
                const utilityButtons = [...document.querySelectorAll('#menu-utilities .picker-btn')]
                    .filter(button => button.getBoundingClientRect().height);
                const utilityRows = utilityButtons.filter((button, index) => index === 0
                    || Math.abs(button.getBoundingClientRect().top
                        - utilityButtons[index - 1].getBoundingClientRect().top) > 0.05);
                const utilities = utilityRows.map(button => button.getBoundingClientRect());
                return {
                    title: box('#identity-status').top - box('#start-screen h1').bottom,
                    identity: box('#picker-status').top - box('#identity-status').bottom,
                    status: statusNext.top - box('#picker-status').bottom,
                    sessions: box('#picker-buttons').top - box('#session-list').bottom,
                    solo: box('#btn-solo').top - box('#picker-buttons .button-row').bottom,
                    utilities: utilities.slice(1).map((rect, index) => ({
                        gap: rect.top - utilities[index].bottom,
                        sharedGroup: utilityRows[index].closest('.menu-utility-group')
                            === utilityRows[index + 1].closest('.menu-utility-group'),
                    })),
                    utilityRowCount: utilities.length,
                    firstDevice: utilityRows[0].id,
                    groups: innerWidth > innerHeight
                        ? box('#menu-utilities').left - box('#menu-play').right
                        : utilities[0].top - box('#btn-solo').bottom,
                    actionRowHeight: box('#picker-buttons .button-row').height,
                    actionRowWidth: box('#picker-buttons .button-row').width,
                    lobbyGap: box('#btn-start-enter').left - box('#btn-leave-create').right,
                    lobbyOffset: box('#btn-start-enter').top - box('#btn-leave-create').top,
                    lobbySpan: box('#btn-start-enter').right - box('#btn-leave-create').left,
                    topAlignment: utilities[0].top - box('#session-list').top,
                    bottomAlignment: utilities.at(-1).bottom - box('#btn-solo').bottom,
                    inviteAlignment: box('#btn-invite-self').top - box('#btn-solo').top,
                    inviteGap: box('#btn-invite-friend').left - box('#btn-invite-self').right,
                    inviteOffset: box('#btn-invite-friend').top - box('#btn-invite-self').top,
                    inviteSpan: box('#btn-invite-friend').right - box('#btn-invite-self').left,
                    settingsGap: box('#btn-difficulty').left - box('#btn-control-mode').right,
                    settingsOffset: box('#btn-difficulty').top - box('#btn-control-mode').top,
                    settingsSpan: box('#btn-difficulty').right - box('#btn-control-mode').left,
                };
            });
            expect(spacing.utilityRowCount, 'Device settings and invitations each share one utility row').toBe(3);
            expect(spacing.firstDevice, 'Fullscreen is the first visible device action').toBe('btn-fullscreen');
            expect(spacing.inviteGap, 'Invitations use the same horizontal gap as lobby actions').toBeCloseTo(7.2, 1);
            expect(spacing.inviteOffset, 'Invitations sit side by side').toBeCloseTo(0, 1);
            expect(spacing.inviteSpan, 'Invitations share one full-width row').toBeCloseTo(solo.width, 1);
            expect(spacing.settingsGap, 'Settings use the same horizontal gap as lobby actions').toBeCloseTo(7.2, 1);
            expect(spacing.settingsOffset, 'Controller mode and difficulty sit side by side').toBeCloseTo(0, 1);
            expect(spacing.settingsSpan, 'Settings share one full-width row').toBeCloseTo(solo.width, 1);
            const landscape = viewport.width > viewport.height;
            const titleMargin = Math.min(27, Math.max(14, Math.min(viewport.width, viewport.height) * 0.027));
            for (const [name, previous] of [
                ['title', titleMargin], ['identity', 10], ['status', 14],
                ['solo', 14],
            ]) {
                expect(spacing[name], `${name} gap is 20% smaller`).toBeCloseTo(previous * 0.8, 1);
            }
            if (landscape) {
                expect(spacing.sessions, 'Extra space aligns the play actions at the bottom')
                    .toBeGreaterThanOrEqual(18 * 0.8 - 0.05);
                for (const name of ['topAlignment', 'bottomAlignment', 'inviteAlignment']) {
                    expect(spacing[name], name).toBeCloseTo(0, 1);
                }
            } else {
                expect(spacing.sessions, 'Portrait session gap stays compact').toBeCloseTo(18 * 0.8, 1);
            }
            for (const { gap, sharedGroup } of spacing.utilities) {
                if (landscape && !sharedGroup) {
                    expect(gap, 'Extra space separates device and invitation groups').toBeGreaterThanOrEqual(11.2 - 0.05);
                } else {
                    expect(gap, 'Gaps within utility groups stay compact').toBeCloseTo(14 * 0.8, 1);
                }
            }
            expect(spacing.groups, 'Only vertical spacing between groups is reduced')
                .toBeCloseTo(viewport.width > viewport.height ? 12 : 19 * 0.8, 1);
            expect(spacing.actionRowHeight, 'Create and the lobby pair occupy one 32px row').toBe(32);
            expect(spacing.actionRowWidth, 'The action row retains the full Create width').toBeCloseTo(solo.width, 1);
            if (inSession) {
                expect(spacing.lobbyGap, 'Leave and Start/Enter have a compact horizontal gap').toBeCloseTo(7.2, 1);
                expect(spacing.lobbyOffset, 'Leave and Start/Enter sit side by side').toBeCloseTo(0, 1);
                expect(spacing.lobbySpan, 'The pair fills the former Create footprint').toBeCloseTo(solo.width, 1);
            }
        }
    }

    await expectMatchingButtons(false);
    await page.locator('#btn-control-mode').click();
    const sessionId = await create(page);
    players.ownSession(sessionId);
    try {
        await expectMatchingButtons(true);
    } finally {
        await page.locator('#btn-leave-create').click();
        await expect.poll(() => page.evaluate(() => SessionClient.isInSession())).toBe(false);
    }
    await expectMatchingButtons(false);
});

test('landscape menu stays balanced across deployment, fullscreen and multiplayer visibility states', async ({ players }) => {
    const { page } = await players.open();
    await expect(page.locator('#btn-leave-create')).toBeEnabled();
    await page.locator('#btn-control-mode').click();
    for (const viewport of [
        { width: 1280, height: 900 }, { width: 900, height: 550 },
        { width: 568, height: 320 }, { width: 400, height: 300 },
    ]) {
        await page.setViewportSize(viewport);
        const cases = await page.evaluate(() => {
            const saved = { ...sessionPicker };
            const container = document.getElementById('game-container');
            const originalClass = container.className;
            const invites = ['btn-invite-self', 'btn-invite-friend'].map(id => document.getElementById(id));
            const disabledInvites = invites.map(button => button.disabled);
            const region = saved.regions.find(candidate => candidate.id === getCreateRegionId());
            if (!region) throw new Error('Menu layout coverage requires an assessed create region');
            const box = id => document.getElementById(id).getBoundingClientRect();
            const cases = [];
            // Project display states through production renderers in one browser turn,
            // then restore the live picker before any transport callbacks can run.
            try {
                for (const mode of ['', 'fullscreen-active', 'standalone-mode', 'pseudo-fullscreen'])
                for (const multiRegion of [false, true])
                for (const sessionCount of [0, 6])
                for (const role of ['outside', 'host', 'waiting-member', 'running-member'])
                for (const unavailable of [false, true]) {
                    container.className = `${originalClass} ${mode}`;
                    Object.assign(sessionPicker, {
                        regions: multiRegion ? [
                            { ...region, displayName: 'Northwestern Europe' },
                            { id: 'layout-secondary', displayName: 'Secondary Region' },
                        ] : [region],
                        selectedCreateRegion: region.id,
                        sessions: Array.from({ length: sessionCount }, (_, index) => ({
                            id: `layout-${index}`, name: `Layout ${index + 1}`,
                            regionId: region.id, memberCount: index + 1, maxMembers: 6,
                        })),
                        currentSessionId: role === 'outside' ? null : 'layout-0',
                        isServer: role === 'host',
                        gameStarted: role === 'running-member',
                        canCreate: !unavailable,
                        connected: !unavailable,
                    });
                    for (const button of invites) button.disabled = unavailable;
                    renderCreateRegionSelector();
                    renderSessionList();
                    updatePickerButtons();
                    const buttons = [...document.querySelectorAll('#menu-columns .picker-btn')]
                        .filter(button => button.getBoundingClientRect().height);
                    const firstDevice = document.querySelector('#menu-utilities .menu-utility-group')
                        .querySelectorAll('button');
                    const firstVisibleDevice = [...firstDevice].find(button => button.getBoundingClientRect().height);
                    const solo = box('btn-solo');
                    cases.push({
                        mode, multiRegion, sessionCount, role, unavailable,
                        firstDevice: firstVisibleDevice.id,
                        top: firstVisibleDevice.getBoundingClientRect().top - box('session-list').top,
                        bottom: box('btn-invite-friend').bottom - solo.bottom,
                        invite: box('btn-invite-self').top - solo.top,
                        inviteGap: box('btn-invite-friend').left - box('btn-invite-self').right,
                        inviteOffset: box('btn-invite-friend').top - box('btn-invite-self').top,
                        inviteWidthError: box('btn-invite-friend').right - box('btn-invite-self').left - solo.width,
                        columnGap: box('menu-utilities').left - box('menu-play').right,
                        fullscreenVisible: box('btn-fullscreen').height > 0,
                        regionVisible: box('create-region-row').height > 0,
                        startVisible: box('btn-start-enter').height > 0,
                        startDisabled: sessionPicker.btnStartEnter.disabled,
                        difficultyDisabled: document.getElementById('btn-difficulty').disabled,
                        actionRowHeight: sessionPicker.btnLeaveCreate.parentElement.getBoundingClientRect().height,
                        lobbyGap: box('btn-start-enter').left - box('btn-leave-create').right,
                        lobbyOffset: box('btn-start-enter').top - box('btn-leave-create').top,
                        lobbyWidthError: box('btn-start-enter').right - box('btn-leave-create').left - solo.width,
                        destination: sessionPicker.btnLeaveCreate.getAttribute('aria-label'),
                        createText: sessionPicker.btnLeaveCreate.textContent,
                        clipped: buttons.filter(button => {
                            const rect = button.getBoundingClientRect();
                            const paired = button.parentElement.classList.contains('button-row')
                                && [...button.parentElement.children].filter(sibling => sibling.getClientRects().length).length === 2;
                            const expectedWidth = paired ? (solo.width - 7.2) / 2 : solo.width;
                            return Math.abs(rect.width - expectedWidth) > 0.05 || rect.height !== 32
                                || rect.left < 0 || rect.right > innerWidth
                                || button.scrollWidth > button.clientWidth
                                || button.scrollHeight > button.clientHeight
                                || getComputedStyle(button).transform !== 'none';
                        }).map(button => button.id),
                    });
                }
            } finally {
                const btnLeaveCreate = sessionPicker.btnLeaveCreate;
                Object.assign(sessionPicker, saved, { btnLeaveCreate });
                container.className = originalClass;
                invites.forEach((button, index) => { button.disabled = disabledInvites[index]; });
                renderCreateRegionSelector();
                renderSessionList();
                updatePickerButtons();
            }
            return cases;
        });
        expect(cases).toHaveLength(128);
        for (const state of cases) {
            const label = `${viewport.width}x${viewport.height} ${state.mode || 'windowed'}`
                + ` regions=${state.multiRegion ? 2 : 1} sessions=${state.sessionCount}`
                + ` ${state.role} unavailable=${state.unavailable}`;
            for (const edge of ['top', 'bottom', 'invite']) {
                expect(state[edge], `${label} ${edge} alignment`).toBeCloseTo(0, 1);
            }
            expect(state.columnGap, `${label} column gap`).toBeCloseTo(12, 1);
            expect(state.fullscreenVisible, label).toBe(state.mode === '');
            expect(state.firstDevice, `${label} has no empty slot above the first device action`)
                .toBe(state.mode === '' ? 'btn-fullscreen' : 'btn-control-mode');
            expect(state.regionVisible, label).toBe(state.multiRegion && state.role === 'outside');
            expect(state.startVisible, label).toBe(state.role !== 'outside');
            expect(state.difficultyDisabled, `${label} locks only the shared difficulty`).toBe(state.role !== 'outside');
            expect(state.actionRowHeight, `${label} keeps the single-row Create footprint`).toBe(32);
            expect(state.inviteGap, `${label} invitations keep the lobby action gap`).toBeCloseTo(7.2, 1);
            expect(state.inviteOffset, `${label} invitations stay side by side`).toBeCloseTo(0, 1);
            expect(state.inviteWidthError, `${label} invitations fill one row`).toBeCloseTo(0, 1);
            if (state.role !== 'outside') {
                expect(state.lobbyGap, `${label} has a horizontal action gap`).toBeCloseTo(7.2, 1);
                expect(state.lobbyOffset, `${label} has side-by-side actions`).toBeCloseTo(0, 1);
                expect(state.lobbyWidthError, `${label} actions fill the Create width`).toBeCloseTo(0, 1);
                expect(state.startDisabled, label).toBe(state.role === 'waiting-member');
                expect(state.destination, `${label} Leave has no stale create label`).toBeNull();
            } else if (state.multiRegion && !state.unavailable) {
                expect(state.destination, `${label} full destination remains accessible`)
                    .toBe('Create Multiplayer in Northwestern Europe');
                expect(state.createText, label).toBe(state.destination);
            }
            expect(state.clipped, `${label} buttons retain their dimensions without clipping`).toEqual([]);
        }
    }
    await page.setViewportSize({ width: 900, height: 550 });
    await page.locator('#btn-fullscreen').click();
    try {
        await expect(page.locator('#btn-fullscreen')).toBeHidden();
        const offsets = await page.evaluate(() => {
            const box = id => document.getElementById(id).getBoundingClientRect();
            const firstVisibleDevice = [...document.querySelectorAll('#menu-utilities .menu-utility-group:first-child button')]
                .find(button => button.getBoundingClientRect().height);
            return [
                firstVisibleDevice.getBoundingClientRect().top - box('session-list').top,
                box('btn-invite-self').top - box('btn-solo').top,
                box('btn-invite-friend').bottom - box('btn-solo').bottom,
            ];
        });
        for (const offset of offsets) expect(offset, 'Live fullscreen transition keeps alignment').toBeCloseTo(0, 1);
    } finally {
        await page.evaluate(() => toggleFullscreen());
    }
    await expect(page.locator('#btn-fullscreen')).toBeVisible();
});

for (const viewport of [
    { width: 568, height: 320 }, { width: 400, height: 300 },
    { width: 360, height: 480 }, { width: 320, height: 320 },
]) {
    test(`session list touch scrolling stays bounded at ${viewport.width}x${viewport.height}`, async ({ players }) => {
        const { page } = await players.open({ viewport, hasTouch: true, isMobile: true });
        await expect(page.locator('#btn-leave-create')).toBeEnabled();
        const cdp = await page.context().newCDPSession(page);
        await page.evaluate(async () => {
            window.menuLayoutSaved = { ...sessionPicker };
            // Freeze discovery only for these display projections, not fabricated hub/HTTP responses.
            await teardownMultiRegionPicker();
            window.menuTouchAudit = { moves: 0, prevented: 0, anchors: 0 };
            window.auditMenuTouch = event => {
                if (!event.target.closest('#start-screen-content')) return;
                if (event.type === 'touchmove') menuTouchAudit.moves++;
                if (event.defaultPrevented) menuTouchAudit.prevented++;
                if (stickInput.moveTouchId !== null || stickInput.fireTouchId !== null) menuTouchAudit.anchors++;
            };
            document.addEventListener('touchstart', auditMenuTouch, { passive: true });
            document.addEventListener('touchmove', auditMenuTouch, { passive: true });
        });
        try {
            const emptyMenus = new Map();
            for (const multiRegion of [false, true])
            for (const count of [0, 2, 30]) {
                const geometry = await page.evaluate(async ({ count, multiRegion }) => {
                    const region = menuLayoutSaved.regions[0];
                    sessionPicker.regions = [
                        { ...region, displayName: 'Northwestern Europe with a long regional label' },
                        ...(multiRegion ? [{ id: 'layout-secondary', displayName: 'Secondary Region' }] : []),
                    ];
                    sessionPicker.sessions = Array.from({ length: count }, (_, index) => ({
                        id: `layout-${index}`, name: `LongUnbrokenSessionLabel${index}`.repeat(3),
                        regionId: region.id, memberCount: index % 5 + 1, maxMembers: 6,
                    }));
                    renderCreateRegionSelector();
                    renderSessionList();
                    updatePickerButtons();
                    // Let layout observation and its queued fitting frame finish.
                    await new Promise(resolve => requestAnimationFrame(() =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    const list = sessionPicker.listEl;
                    const content = document.getElementById('start-screen-content');
                    const box = id => document.getElementById(id).getBoundingClientRect();
                    return {
                        listHeight: box('session-list').height,
                        scrollable: list.scrollHeight > list.clientHeight,
                        listFits: list.scrollWidth <= list.clientWidth
                            && box('session-list').right <= box('menu-play').right,
                        rootFits: content.scrollWidth <= content.clientWidth
                            && document.documentElement.scrollWidth <= innerWidth,
                        actionsBelow: box('picker-buttons').top >= box('session-list').bottom,
                        groupsSeparate: innerWidth > innerHeight
                            ? box('menu-utilities').left > box('menu-play').right
                            : box('menu-utilities').top > box('menu-play').bottom,
                        needsMenuScroll: content.scrollHeight > content.clientHeight,
                        buttonsVisible: [...document.querySelectorAll('#menu-columns button')]
                            .filter(button => button.getBoundingClientRect().height)
                            .every(button => {
                                const rect = button.getBoundingClientRect();
                                return rect.top >= 0 && rect.bottom <= innerHeight;
                            }),
                    };
                }, { count, multiRegion });
                const label = `${count} sessions, ${multiRegion ? 2 : 1} regions`;
                expect(geometry.listHeight, label).toBeLessThanOrEqual(Math.min(135, viewport.height / 4));
                expect(geometry.listFits && geometry.rootFits, `${label}: no horizontal spill`).toBe(true);
                expect(geometry.actionsBelow && geometry.groupsSeparate, `${label}: groups never overlap`).toBe(true);
                if (count === 0) emptyMenus.set(multiRegion, geometry.needsMenuScroll);
                if (!emptyMenus.get(multiRegion)) {
                    expect(geometry.needsMenuScroll, `${label}: sessions must not push otherwise visible actions off-screen`)
                        .toBe(false);
                    expect(geometry.buttonsVisible, label).toBe(true);
                }
                if (count === 30) expect(geometry.scrollable, `${label}: rows, not the menu, take the overflow`).toBe(true);
            }
            const list = page.locator('#session-list');
            const rect = await list.boundingBox();
            const padding = Math.min(12, rect.height / 8);
            const top = rect.y + padding;
            const bottom = rect.y + rect.height - padding;
            const x = rect.x + rect.width / 2;
            const before = await list.evaluate(element => element.scrollTop);
            await swipeTouch(page, cdp, x, bottom, top);
            await expect.poll(() => list.evaluate(element => element.scrollTop),
                { message: 'A real upward finger gesture scrolls the long list down' }).toBeGreaterThan(before);
            const afterUp = await list.evaluate(element => element.scrollTop);
            await swipeTouch(page, cdp, x, top, bottom);
            await expect.poll(() => list.evaluate(element => element.scrollTop),
                { message: 'A real downward finger gesture scrolls the long list back up' }).toBeLessThan(afterUp);
            const afterDown = await list.evaluate(element => element.scrollTop);
            const content = page.locator('#start-screen-content');
            expect(await content.evaluate(element => element.scrollTop),
                'List gestures do not drag the surrounding action groups').toBe(0);
            const needsMenuScroll = await content.evaluate(element => element.scrollHeight > element.clientHeight);
            if (needsMenuScroll) {
                await swipeTouch(page, cdp, 4, viewport.height - 20, 40);
                await expect.poll(() => content.evaluate(element => element.scrollTop),
                    { message: 'Menu padding also allows native scrolling on very short screens' }).toBeGreaterThan(0);
            }
            for (const id of ['btn-invite-self', 'btn-invite-friend']) {
                await expect(page.locator(`#${id}`), 'The last action row is reachable by touch').toBeInViewport({ ratio: 1 });
            }
            const outer = await content.evaluate(element => element.scrollTop);
            if (needsMenuScroll) {
                await swipeTouch(page, cdp, 4, 40, viewport.height - 20);
                await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeLessThan(outer);
            }
            const audit = await page.evaluate(() => menuTouchAudit);
            expect(audit.moves, 'Native touchmove events reached the document').toBeGreaterThan(0);
            expect(audit.prevented, 'The container does not cancel menu gestures').toBe(0);
            expect(audit.anchors, 'Neither list nor menu-padding gestures steer or fire').toBe(0);
            console.info(`Touch ${viewport.width}x${viewport.height}: list ${before} -> ${afterUp} -> ${afterDown}; menu ${outer}`);
            await page.setViewportSize({ width: viewport.width, height: 800 });
            await expect.poll(() => list.evaluate(element => element.getBoundingClientRect().height),
                { message: 'A taller viewport restores the full list height instead of retaining a stale cap' }).toBe(135);
            await page.setViewportSize(viewport);
            await expect.poll(() => list.evaluate((element, previous) =>
                Math.abs(element.getBoundingClientRect().height - previous), rect.height),
            { message: 'Returning to the short viewport reserves control space again' }).toBeLessThan(1);
        } finally {
            await cdp.detach();
            await page.evaluate(async () => {
                document.removeEventListener('touchstart', auditMenuTouch);
                document.removeEventListener('touchmove', auditMenuTouch);
                const btnLeaveCreate = sessionPicker.btnLeaveCreate;
                Object.assign(sessionPicker, menuLayoutSaved, { btnLeaveCreate });
                delete window.menuLayoutSaved;
                delete window.menuTouchAudit;
                delete window.auditMenuTouch;
                await activateSessionPickerUpdates();
            });
        }
    });
}

test('menu touch taps join real sessions and canvas gestures retain both control modes', async ({ players }) => {
    const host = await players.open();
    const sessionId = await create(host.page);
    players.ownSession(sessionId);
    for (const mode of ['Polar', 'Boxy']) {
        const guest = await players.open({
            viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true,
        });
        if (mode === 'Boxy') await guest.page.locator('#btn-control-mode').tap();
        await expect(guest.page.locator('#btn-control-mode')).toContainText(mode);
        await guest.page.locator(`.session-item[data-session-id="${sessionId}"]`).tap();
        await sessionReady(guest.page, sessionId);
        if (mode === 'Polar') {
            await host.page.locator('#btn-start-enter').click();
            await playing(host.page);
        }
        await expect(guest.page.locator('#btn-start-enter')).toHaveText('Enter');
        await guest.page.locator('#btn-start-enter').tap();
        await playing(guest.page);
        const rect = await guest.page.locator('#game').boundingBox();
        const before = await guest.page.evaluate(() => ({ x: game.ship.x, y: game.ship.y }));
        const move = { x: rect.x + rect.width / 4, y: rect.y + rect.height * 0.7, id: 1 };
        const cdp = await guest.page.context().newCDPSession(guest.page);
        try {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [move] });
            move.y -= rect.height * 0.3;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [move] });
            await expect.poll(() => guest.page.evaluate(before =>
                stickInput.moveTouchId !== null
                && Math.hypot(game.ship.x - before.x, game.ship.y - before.y) > 0.00001, before),
            { message: `${mode}: a held canvas drag still moves the live player ship` }).toBe(true);
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart', touchPoints: [
                    move, { x: rect.x + rect.width * 0.75, y: rect.y + rect.height * 0.7, id: 2 },
                ],
            });
            await expect.poll(() => guest.page.evaluate(() =>
                stickInput.moveTouchId !== null && stickInput.fireTouchId !== null && game.bullets.length > 0),
            { message: `${mode}: simultaneous right-side touch still fires while steering` }).toBe(true);
        } finally {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
        }
        await expect.poll(() => guest.page.evaluate(() =>
            stickInput.moveTouchId === null && stickInput.fireTouchId === null),
        { message: `${mode}: releasing both fingers clears the gameplay anchors` }).toBe(true);
        await players.close(guest);
    }
});

test('independent players create, join, play, leave and rejoin', async ({ players }) => {
    const host = await players.open({ tag: maximumLengthTag() });
    const guest = await players.open({ tag: maximumLengthTag('Z_9-') });
    let sessionId;
    await test.step('create and join an isolated session through the UI', async () => {
        sessionId = await create(host.page);
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
        expect(await guest.page.evaluate(id => ObjectSync.getObject(id).data.participantTag, hostShip)).toBe(host.tag);
        expect(await host.page.evaluate(id => ObjectSync.getObject(id).data.participantTag, guestShip)).toBe(guest.tag);
        await expect.poll(() => guest.page.evaluate(() => {
            const state = ObjectSync.getObjectByType('gameState');
            return state ? Object.values(AstervoidsWireCodec.unpackTagMap(state.data.participantTags)).sort() : [];
        }), { message: 'Maximum-length names survive the replicated participant ledger' })
            .toEqual([host.tag, guest.tag].sort());
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

for (const touch of [false, true]) {
    test(`Create retains a foreground ${touch ? 'tap' : 'click'} while real identity verification is pending`, async ({ players }) => {
        const host = await players.open(touch
            ? { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } } : {});
        await expect(host.page.locator('#btn-leave-create')).toBeEnabled();
        await host.page.locator('#btn-difficulty').click();
        await expect(host.page.locator('#btn-difficulty')).toHaveText('🎯 : Shifter');
        let releaseVerification;
        const verification = new Promise(resolve => { releaseVerification = resolve; });
        let verificationStarted;
        const started = new Promise(resolve => { verificationStarted = resolve; });
        const delayVerification = async route => {
            verificationStarted();
            await verification;
            await route.fallback();
        };
        await host.page.route('**/api/identity/resolve', delayVerification);
        try {
            await host.page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await started;
            expect(await host.page.evaluate(() => game.identityChanging)).toBe(true);
            if (touch) await host.page.locator('#btn-leave-create').tap();
            else await host.page.locator('#btn-leave-create').click();
            await expect(host.page.locator('#btn-leave-create')).toBeDisabled();
            await expect(host.page.locator('#btn-difficulty')).toBeDisabled();
            expect(await host.page.evaluate(() => cycleDifficulty())).toBe(false);
            expect(await host.page.evaluate(() => LOCAL_CONFIG_BASELINE.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.2);
            expect(await host.page.evaluate(() => sessionPicker.currentSessionId)).toBeNull();
            releaseVerification();
            await sessionReady(host.page);
            players.ownSession(await host.page.evaluate(() => SessionClient.getCurrentSession().id));
            await expect(host.page.locator('#btn-start-enter')).toBeEnabled();
            await expect(host.page.locator('#btn-difficulty')).toHaveText('🎯 : Shifter');
            expect(await host.page.evaluate(() => CONFIG.ASTEROID_DIFFICULTY_FACTOR)).toBe(0.2);
            await host.page.locator('#btn-start-enter').click();
            await playing(host.page);
            expect(host.health.hubFrames, 'Create still uses the real hub connection').toBeGreaterThan(0);
        } finally {
            releaseVerification();
            await host.page.unroute('**/api/identity/resolve', delayVerification);
        }
    });
}

test('foreground identity verification resumes a connected session instead of stranding recovery', async ({ players }) => {
    const host = await players.open();
    const guest = await players.open();
    const sessionId = await create(host.page);
    players.ownSession(sessionId);
    await join(guest.page, sessionId);
    await host.page.locator('#btn-start-enter').click();
    await guest.page.locator('#btn-start-enter').click();
    await Promise.all([playing(host.page), playing(guest.page)]);
    const oldMember = await guest.page.evaluate(() => SessionClient.getCurrentMember().id);
    const oldShip = await shipId(guest.page);

    // Model a long background interval without dropping the real hub socket.
    // Visibility capture starts the real identity request before game recovery.
    const interrupted = await guest.page.evaluate(() => {
        hiddenTimestamp = Date.now() - 6000;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        return {
            connected: SessionClient.isConnected(),
            verifying: game.identityChanging,
            frozen: game.connectionLost,
        };
    });
    expect(interrupted).toEqual({ connected: true, verifying: true, frozen: true });
    await expect.poll(() => guest.page.evaluate(previous => {
        const member = SessionClient.getCurrentMember();
        return !!member && member.id !== previous && !game.identityChanging
            && !game.connectionLost && !rejoinInProgress;
    }, oldMember), { message: 'Verified identity resumes deferred session entry despite a live transport' }).toBe(true);

    await expect(guest.page.locator('#reconnecting-overlay')).toBeHidden();
    await playing(guest.page);
    await sessionReady(guest.page, sessionId);
    await Promise.all([membership(host.page, sessionId, 2), membership(guest.page, sessionId, 2)]);
    const recoveredShip = await shipId(guest.page);
    expect(recoveredShip !== oldShip, 'Recovery creates a fresh network-backed ship').toBe(true);
    await expect.poll(() => host.page.evaluate(id => !!ObjectSync.getObject(id), oldShip),
        { message: 'The former member ship does not survive session recovery' }).toBe(false);
    await replicatedThrust(guest.page, host.page, recoveredShip);
});

async function personalState(page) {
    return page.evaluate(() => {
        const record = ObjectSync.getObjectByType('gameState');
        if (!record) return null;
        const data = record.data;
        const available = data.participantScores instanceof Uint8Array
            && data.participantNumbers instanceof Uint8Array && data.participantTags instanceof Uint8Array;
        const confirmation = available ? {
            groupScore: data.groupScore,
            participantScores: data.participantScores,
            participantNumbers: data.participantNumbers,
            participantTags: data.participantTags,
        } : null;
        return {
            available,
            scores: available ? AstervoidsWireCodec.unpackCounterMap(data.participantScores) : null,
            numbers: available ? AstervoidsWireCodec.unpackCounterMap(data.participantNumbers) : null,
            tags: available ? AstervoidsWireCodec.unpackTagMap(data.participantTags) : null,
            counted: AstervoidsWireCodec.unpackCounterMap(data.countedParticipants),
            groupScore: data.groupScore,
            lives: data.lives,
            scoreLifeAwardCount: data.scoreLifeAwardCount,
            owner: record.ownerMemberId,
            ownerConfirmed: available && (record.ownerMemberId !== SessionClient.getCurrentMember().id
                || ObjectSync.isDataConfirmed(record.id, confirmation)),
            version: record.version,
            gameOverAt: data.gameOverAt,
            terminalAt: data.terminalAt,
            terminalShipId: data.terminalShipId,
        };
    });
}

function expectedPersonalState(participants) {
    return {
        available: true,
        scores: Object.fromEntries(participants.map(({ id, score }) => [id, score])),
        numbers: Object.fromEntries(participants.map(({ id, number }) => [id, number])),
        tags: Object.fromEntries(participants.map(({ id, tag }) => [id, tag])),
        counted: Object.fromEntries(participants.map(({ id }) => [id, 1])),
        groupScore: participants.reduce((sum, { score }) => sum + score, 0),
        ownerConfirmed: true,
    };
}

async function personalConvergence(pages, participants) {
    const expected = expectedPersonalState(participants);
    await expect.poll(async () => Promise.all(pages.map(async page => {
        const state = await personalState(page);
        if (!state) return null;
        return Object.fromEntries(Object.keys(expected).map(key => [key, state[key]]));
    })), { message: 'Server-confirmed durable personal ledgers and team totals converge on every peer' })
        .toEqual(pages.map(() => expected));
}

async function personalPoints(page, points) {
    await page.evaluate(async points => {
        if (!game.ship?.syncObjectId) throw new Error('A real owned ship is required for score setup');
        // Exercise the production event handler, relay and authority calculation;
        // never inject the expected ledgers or replace a transport implementation.
        game.ship.score += points;
        const accepted = await ObjectSync.emitEvent(
            game.ship.syncObjectId, EVENT_KIND.SHIP_STATE_CHANGED,
            { score: game.ship.score, hitCount: game.ship.hitCount || 0 });
        if (accepted !== true) throw new Error('The owned ship score event was rejected by the hub');
    }, points);
}

async function personalResults(page, expected, teamScore, yourScore = null) {
    const overlay = page.locator('#gameover-overlay');
    await expect(overlay).toBeVisible();
    await expect.poll(async () => personalRows(await overlay.innerText()),
        { message: 'Actual rendered result rows match the converged durable ranking' }).toEqual(expected);
    await expect(page.locator('#gameover-score')).toHaveText(`Team Score: ${teamScore}`);
    await expect(page.locator('#gameover-personal-score')).toHaveText(`Your Score: ${yourScore ?? '--'}`);
    await expect(page.locator('#gameover-personal-score')).toHaveAttribute('aria-label',
        yourScore === null ? 'No personal score: spectating' : `Your Score ${yourScore}`);
    expect(await overlay.innerText(), 'Public results never display raw participant identities')
        .not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
}

function boxInViewport(box, viewport, message) {
    boxInRegion(box, {
        left: 0, top: 0, right: viewport.width, bottom: viewport.height,
    }, message);
}

function boxInRegion(box, region, message) {
    expect(box, message).not.toBeNull();
    expect(region, 'The actual containing rectangle is measured').not.toBeNull();
    const evidence = `${message}: ${JSON.stringify({ box, region })}`;
    expect(box.left, evidence).toBeGreaterThanOrEqual(region.left - 1);
    expect(box.right, evidence).toBeLessThanOrEqual(region.right + 1);
    expect(box.top, evidence).toBeGreaterThanOrEqual(region.top - 1);
    expect(box.bottom, evidence).toBeLessThanOrEqual(region.bottom + 1);
}

async function resizePersonalView(page, viewport, creatorAspect) {
    await page.setViewportSize(viewport);
    // CSS can scale the old canvas before resizeCanvas synchronously updates the HUD and overlays.
    await expect.poll(() => page.evaluate(personalViewResizeState), {
        message: 'Canvas backing size and creator viewport finish resizing before layout is measured',
    }).toEqual({
        canvas: { width: viewport.width, height: viewport.height },
        gameViewport: {
            width: Math.min(viewport.width, viewport.height * creatorAspect),
            height: Math.min(viewport.height, viewport.width / creatorAspect),
        },
    });
}

function personalLayoutEvidence(stage, geometry) {
    const bounds = box => box && [box.left, box.top, box.right, box.bottom]
        .map(value => Math.round(value * 100) / 100);
    console.info(`Creator-view ${stage}: ${JSON.stringify({
        view: bounds(geometry.gameView),
        hud: bounds(geometry.hud), compact: geometry.compactHud,
        score: bounds(geometry.score), player: bounds(geometry.player), session: bounds(geometry.session),
        wave: bounds(geometry.wave), lives: bounds(geometry.lives),
        overlay: bounds(geometry.overlay), title: bounds(geometry.title),
        personalTotal: bounds(geometry.personalTotal),
        total: bounds(geometry.total), prompt: bounds(geometry.prompt),
        results: bounds(geometry.results),
        scroll: geometry.results && [
            geometry.results.clientHeight, geometry.results.scrollHeight, geometry.results.scrollTop,
        ],
    })}`);
}

async function containedPersonalHud(page, yourScore, teamScore, playerTag) {
    const longName = 'A remarkably long multiplayer session name';
    await page.evaluate(name => {
        game.sessionInfo.name = name;
        updateHUD();
    }, longName);
    await expect(page.locator('#session-indicator')).toHaveText(longName);
    await expect(page.locator('#player-indicator')).toHaveText(playerTag);
    const rows = page.locator('#multiplayer-scores .score-row');
    await expect(rows.nth(0)).toHaveText(new RegExp(`^\\s*Your Score:\\s*${yourScore}\\s*:\\s*${playerTag}\\s*$`));
    await expect(rows.nth(1)).toHaveText(new RegExp(`^\\s*Team Score:\\s*${teamScore}\\s*:\\s*${longName}\\s*$`));
    await expect.poll(async () => personalHudScores(await page.locator('#hud').innerText()),
        { message: 'The capitalized individual and team HUD counters display the accepted totals' })
        .toEqual({ your: yourScore, team: teamScore });
    await expect(page.locator('#wave')).toHaveText(/^Wave: [1-9]\d*$/);
    await expect(page.locator('#lives')).toHaveText(/^Lives: [1-9]\d*$/);
    const geometry = await page.evaluate(personalScoreGeometry);
    personalLayoutEvidence('HUD', geometry);
    expect(geometry.your, 'The individual counter has real rendered geometry').not.toBeNull();
    expect(geometry.team, 'The team counter has real rendered geometry').not.toBeNull();
    expect(geometry.your.bottom, 'Your Score stays above Team Score')
        .toBeLessThanOrEqual(geometry.team.top + 1);
    const boxes = [geometry.scoreColumn, geometry.wave, geometry.lives];
    boxInRegion(geometry.hud, geometry.gameView, 'The whole HUD stays inside the creator game-view');
    for (const box of boxes) {
        boxInRegion(box, geometry.gameView, 'Every HUD item fits the creator game-view, not its letterbox');
        expect(box.right - box.left, 'No HUD item collapses to zero width').toBeGreaterThan(0);
    }
    for (let index = 0; index < boxes.length; index++) {
        for (const other of boxes.slice(index + 1)) {
            const box = boxes[index];
            expect(box.right <= other.left + 1 || other.right <= box.left + 1
                || box.bottom <= other.top + 1 || other.bottom <= box.top + 1,
            'Named score rows, Wave and Lives never overlap even in a compact creator view').toBe(true);
        }
        for (const box of [geometry.your, geometry.team, geometry.player, geometry.session]) {
            boxInRegion(box, geometry.scoreColumn, 'Each named score field stays inside the score column');
        }
        expect(geometry.your.right, 'The player name follows Your Score in its row')
            .toBeLessThanOrEqual(geometry.player.left + 1);
        expect(geometry.team.right, 'The session name follows Team Score in its row')
            .toBeLessThanOrEqual(geometry.session.left + 1);
        expect(geometry.player.bottom, 'The player and session names stay on separate score rows')
            .toBeLessThanOrEqual(geometry.session.top + 1);
        boxInRegion(geometry.playerText, geometry.player, 'The complete durable player tag remains readable');
        expect(Math.max(geometry.your.top, geometry.player.top), 'The player name shares the personal-score line')
            .toBeLessThan(Math.min(geometry.your.bottom, geometry.player.bottom));
        expect(Math.max(geometry.team.top, geometry.session.top), 'The session name shares the team-score line')
            .toBeLessThan(Math.min(geometry.team.bottom, geometry.session.bottom));
    }
    if (!geometry.compactHud) {
        for (let index = 1; index < boxes.length; index++) {
            expect(boxes[index - 1].right, 'The normal horizontal HUD retains its original order')
                .toBeLessThanOrEqual(boxes[index].left + 1);
        }
        expect(Math.max(...boxes.map(box => box.top)), 'The normal HUD still occupies one horizontal row')
            .toBeLessThan(Math.min(...boxes.map(box => box.bottom)) + 1);
    }
    expect(geometry.session.height, 'Long session names do not stack the shared HUD composition')
        .toBeLessThanOrEqual(Math.max(geometry.wave.height, geometry.lives.height) * 1.5);
    if (geometry.sessionClips) {
        expect(['hidden', 'clip'], 'A long name is clipped rather than drawn over its neighbors')
            .toContain(geometry.sessionOverflow);
        expect(geometry.sessionEllipsis, 'Clipped session text visibly indicates truncation').toBe('ellipsis');
    }
    expect(geometry.documentWidth, 'HUD stress does not introduce horizontal page scrolling')
        .toBeLessThanOrEqual(geometry.viewport.width + 1);
}

async function readablePersonalResults(page, expected, requireScroll = false) {
    const results = page.locator('#gameover-results');
    // Check the desktop prompt as well as touch controls in this same real session.
    await page.locator('#game-container').evaluate(element => element.classList.remove('touch-enabled'));
    await expect(page.locator('#gameover-prompt')).toBeVisible();
    await results.evaluate(element => { element.scrollTop = 0; });
    let geometry = await page.evaluate(personalScoreGeometry);
    personalLayoutEvidence('results at first row', geometry);
    expect(geometry.rows.map(({ tag, score }) => ({ tag, score }))).toEqual(expected);
    for (const box of [geometry.overlay, geometry.title, geometry.personalTotal, geometry.total,
        geometry.prompt, geometry.results]) {
        boxInRegion(box, geometry.gameView, 'Final title, personal and team totals, prompt and results stay in the creator view');
    }
    expect(geometry.title.fontSize, 'The game-over heading remains readable').toBeGreaterThanOrEqual(20);
    expect(geometry.personalTotal.fontSize, 'The complete six-digit personal total remains readable')
        .toBeGreaterThanOrEqual(12);
    expect(geometry.total.fontSize, 'The complete six-digit team total remains readable').toBeGreaterThanOrEqual(12);
    expect(geometry.title.bottom, 'The personal summary does not overlap the title')
        .toBeLessThanOrEqual(geometry.personalTotal.top + 1);
    expect(geometry.personalTotal.bottom, 'Your Score stays above Team Score at game over')
        .toBeLessThanOrEqual(geometry.total.top + 1);
    expect(geometry.total.bottom, 'The score summary does not overlap the scrollable standings')
        .toBeLessThanOrEqual(geometry.results.top + 1);
    expect(geometry.prompt.fontSize, 'The desktop menu instruction remains readable').toBeGreaterThanOrEqual(10);
    expect(['auto', 'scroll'], 'Only the bounded results region scrolls').toContain(geometry.results.overflowY);
    expect(geometry.results.scrollWidth, 'Results require no horizontal scrolling')
        .toBeLessThanOrEqual(geometry.results.clientWidth + 1);
    const scrolls = geometry.results.scrollHeight > geometry.results.clientHeight;
    if (requireScroll) {
        expect(scrolls, 'Historical rows exercise vertical scrolling in the small creator view').toBe(true);
    }
    for (const header of geometry.headers) {
        boxInRegion(header, geometry.results.clip, 'The initial caption and column headers are revealed inside results');
        expect(header.fontSize, 'Results headers stay readable').toBeGreaterThanOrEqual(12);
    }
    for (let index = 0; index < geometry.rows.length; index++) {
        const row = geometry.rows[index];
        expect(row.label.fontSize, 'Stable player labels remain readable on mobile').toBeGreaterThanOrEqual(12);
        expect(row.value.fontSize, 'Six-digit and zero scores remain readable on mobile').toBeGreaterThanOrEqual(12);
        expect(row.label.right <= row.value.left + 1 || row.value.right <= row.label.left + 1
            || row.label.bottom <= row.value.top + 1 || row.value.bottom <= row.label.top + 1,
        'Each player label remains distinct from its score value').toBe(true);
        if (index > 0) {
            expect(geometry.rows[index - 1].box.bottom, 'Final result rows do not overlap')
                .toBeLessThanOrEqual(row.box.top + 1);
        }
    }
    for (const box of [geometry.rows[0].box, geometry.rows[0].label, geometry.rows[0].value]) {
        boxInRegion(box, geometry.results.clip, 'The first historical row is fully revealed inside the scroll region');
    }
    await results.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => {
        const measured = await page.evaluate(personalScoreGeometry);
        return (!scrolls || measured.results.scrollTop > 0)
            && measured.rows.at(-1).box.bottom <= measured.results.clip.bottom + 1;
    }, { message: 'Native End scrolling reaches the last ranked player, not only the first screenful' }).toBe(true);
    geometry = await page.evaluate(personalScoreGeometry);
    personalLayoutEvidence('results at last row', geometry);
    for (const box of [geometry.rows.at(-1).box, geometry.rows.at(-1).label, geometry.rows.at(-1).value]) {
        boxInRegion(box, geometry.results.clip, 'The last historical row is fully revealed inside the scroll region');
    }
    await page.locator('#game-container').evaluate(element => element.classList.add('touch-enabled'));
    geometry = await page.evaluate(personalScoreGeometry);
    await expect(page.locator('#touch-restart')).toBeVisible();
    boxInViewport(geometry.restart, geometry.viewport, 'The mobile return control remains on screen');
    expect(geometry.restart.width, 'The return control retains a usable touch target').toBeGreaterThanOrEqual(44);
    expect(geometry.restart.height, 'The return control retains a usable touch target').toBeGreaterThanOrEqual(44);
    expect(geometry.restartReachable, 'The result overlay does not intercept the return control').toBe(true);
}

const personalLayouts = [
    {
        name: 'portrait creator, wide guest',
        creator: { width: 360, height: 800 },
        guest: { width: 960, height: 540 },
        resized: { width: 640, height: 360 },
    },
    {
        name: 'wide creator, portrait guest',
        creator: { width: 1280, height: 720 },
        guest: { width: 360, height: 800 },
        resized: { width: 320, height: 568 },
    },
];
for (const { mode, layout } of ['deterministic', 'buffered']
    .flatMap(mode => personalLayouts.map(layout => ({ mode, layout })))) {
    test(`personal scores survive departure, authority migration and late spectators (${mode}; ${layout.name})`, async ({ players }) => {
        test.setTimeout(180_000);
        const path = `/?cfg.SIM_MODE=${mode}&cfg.INVULNERABILITY_TIME=60000`;
        const mobile = {
            path, hasTouch: true, isMobile: true,
        };
        const host = await players.open({ ...mobile, viewport: layout.creator });
        const guest = await players.open({ ...mobile, viewport: layout.guest });
        const creatorAspect = layout.creator.width / layout.creator.height;
        const participants = [];
        let sessionId;
        let maxMembers;
        let scoreThreshold;
        let startingLives;
        let hostMember;
        let hostShip;
        let guestShip;
        let watcher;
        let late;

        await test.step('start independent players and derive capacity from the real session advertisement', async () => {
            sessionId = await create(host.page);
            hostMember = await host.page.evaluate(() => SessionClient.getCurrentMember().id);
            players.ownSession(sessionId);
            const response = await host.page.request.get('/api/sessions', { maxRedirects: 0 });
            expect(response.ok(), 'The owning app advertises the isolated session').toBe(true);
            const advertisement = (await response.json()).sessions.find(session => session.id === sessionId);
            expect(advertisement, 'The advertised capacity belongs to this real session').toBeDefined();
            maxMembers = advertisement.maxMembers;
            expect(Number.isInteger(maxMembers), 'Capacity is a real integer advertisement').toBe(true);
            expect(maxMembers, 'This multi-peer scenario needs room for two players and a watcher')
                .toBeGreaterThanOrEqual(3);
            await join(guest.page, sessionId);
            for (const page of [host.page, guest.page]) {
                expect(await page.evaluate(() => ({
                    session: SessionClient.getCurrentSession().metadata.aspectRatio,
                    game: game.sessionInfo.metadata.aspectRatio,
                })), 'Both independent peers use the creator metadata, never the guest window aspect')
                    .toEqual({ session: creatorAspect, game: creatorAspect });
            }
            const view = (await guest.page.evaluate(personalScoreGeometry)).gameView;
            expect(view.left > 0 || view.top > 0,
                'This real guest has a nonzero creator-view offset within its fullscreen canvas').toBe(true);
            expect(view.width / view.height, 'Rendered guest geometry adopts the creator aspect').toBeCloseTo(creatorAspect);
            await host.page.locator('#btn-start-enter').click();
            await playing(host.page);
            hostShip = await shipId(host.page);
            participants.push({
                id: await host.page.evaluate(() => SessionClient.getParticipantId()),
                number: 1, score: 0, tag: host.tag,
            });
            await personalConvergence([host.page, guest.page], participants);
            await expect(host.page.locator('#player-indicator')).toHaveText(host.tag);
            await expect(guest.page.locator('#player-indicator')).toHaveText(guest.tag);
            await expect(guest.page.locator('#your-score')).toHaveText('--');
            await guest.page.locator('#btn-start-enter').click();
            await playing(guest.page);
            for (const page of [host.page, guest.page]) {
                expect(await page.evaluate(() => isDeterministicMode()),
                    'The actual session simulation mode matches this regression scenario')
                    .toBe(mode === 'deterministic');
            }
            guestShip = await shipId(guest.page);
            participants.push({
                id: await guest.page.evaluate(() => SessionClient.getParticipantId()),
                number: 2, score: 0, tag: guest.tag,
            });
            const config = await host.page.evaluate(() => ({
                threshold: CONFIG.EXTRA_LIFE_SCORE_THRESHOLD, lives: CONFIG.MULTIPLAYER_LIVES,
            }));
            scoreThreshold = config.threshold;
            startingLives = config.lives;
            await personalConvergence([host.page, guest.page], participants);
            await expect(guest.page.locator('#player-indicator')).toHaveText(guest.tag);
            await expect(guest.page.locator('#your-score')).toHaveText('0');
            await guest.page.evaluate(() => enableTouchControls());
        });

        await test.step('credit equal six-digit scores once through accepted ship events', async () => {
            const before = await personalState(guest.page);
            await personalPoints(host.page, 123456);
            participants[0].score = 123456;
            await personalConvergence([host.page, guest.page], participants);
            await personalPoints(host.page, 0);
            await personalPoints(guest.page, 123456);
            participants[1].score = 123456;
            await personalConvergence([host.page, guest.page], participants);
            expect((await personalState(guest.page)).version, 'A real accepted GameState version reaches the peer')
                .toBeGreaterThan(before.version);
        });

        await test.step('persist departed zero-score players and a high scorer beyond the row limit', async () => {
            const historicalCount = Math.floor(maxMembers * 1.5) + 2;
            while (participants.length < historicalCount) {
                const visitor = await players.open({ path });
                await join(visitor.page, sessionId);
                await visitor.page.locator('#btn-start-enter').click();
                await playing(visitor.page);
                const visitorShip = await shipId(visitor.page);
                const participant = {
                    id: await visitor.page.evaluate(() => SessionClient.getParticipantId()),
                    number: participants.length + 1,
                    tag: visitor.tag,
                    score: 0,
                };
                participants.push(participant);
                await personalConvergence([host.page, guest.page, visitor.page], participants);
                if (participants.length === historicalCount) {
                    await personalPoints(visitor.page, 70000);
                    participant.score = 70000;
                    await personalConvergence([host.page, guest.page, visitor.page], participants);
                }
                await leave(visitor.page);
                await membership(host.page, sessionId, 2);
                await expect.poll(() => host.page.evaluate(id => !!ObjectSync.getObject(id), visitorShip),
                    { message: 'A departed ship disappears without removing its personal history' }).toBe(false);
                await personalConvergence([host.page, guest.page], participants);
                await players.close(visitor);
            }
            expect(participants.filter(({ score }) => score === 0).length,
                'The real history contains departed players who never scored').toBeGreaterThan(0);
            const state = await personalState(guest.page);
            const lifeAwards = scoreThreshold > 0 ? Math.floor(state.groupScore / scoreThreshold) : 0;
            expect(state.scoreLifeAwardCount, 'Team score still drives the existing extra-life calculation')
                .toBe(lifeAwards);
            expect(state.lives, 'Historical entry lives and score lives remain unchanged')
                .toBe(startingLives + participants.length - 1 + lifeAwards);
        });

        await test.step('rejoin with a zero-score ship without resetting personal totals or labels', async () => {
            await leave(guest.page);
            await membership(host.page, sessionId, 1);
            await join(guest.page, sessionId);
            await guest.page.locator('#btn-start-enter').click();
            await playing(guest.page);
            const rejoinedShip = await shipId(guest.page);
            expect(rejoinedShip, 'A rejoined player owns a fresh ship').not.toBe(guestShip);
            expect(await guest.page.evaluate(() => game.ship.score), 'New ships still start at zero').toBe(0);
            expect(await guest.page.evaluate(() => SessionClient.getParticipantId()),
                'Session participant identity survives voluntary rejoin').toBe(participants[1].id);
            guestShip = rejoinedShip;
            await personalConvergence([host.page, guest.page], participants);
            await containedPersonalHud(guest.page, participants[1].score,
                participants.reduce((sum, participant) => sum + participant.score, 0), participants[1].tag);
        });

        await test.step('exclude a pure watcher and continue score updates after the original authority departs', async () => {
            watcher = await players.open({ path });
            await join(watcher.page, sessionId);
            await membership(host.page, sessionId, 3);
            await expect.poll(() => watcher.page.evaluate(() => game.ship == null),
                { message: 'A joined lobby watcher has no player ship' }).toBe(true);
            await personalConvergence([host.page, guest.page, watcher.page], participants);
            await expect(watcher.page.locator('#player-indicator')).toHaveText(watcher.tag);
            const watchingParticipant = await watcher.page.evaluate(() => SessionClient.getParticipantId());
            expect(participants.some(({ id }) => id === watchingParticipant),
                'A pure spectator is not a historical scoring participant').toBe(false);
            expect(await host.page.evaluate(() => isGameStateOwner()),
                'The departing creator owns the durable scoring authority').toBe(true);
            await leave(host.page);
            await membership(guest.page, sessionId, 2);
            await expect.poll(() => guest.page.evaluate(() => SessionClient.getCurrentMember().role),
                { message: 'The oldest surviving player is promoted by the actual server' }).toBe('Server');
            await expect.poll(() => guest.page.evaluate(({ memberId, shipId }) => {
                const record = ObjectSync.getObjectByType('gameState');
                return !!record && record.ownerMemberId !== memberId
                    && SessionClient.getCurrentSession().members
                        .some(member => member.id === record.ownerMemberId)
                    && !ObjectSync.getObject(shipId);
            }, { memberId: hostMember, shipId: hostShip }),
            { message: 'Departure migrates GameState authority and removes the old member ship' }).toBe(true);
            await personalPoints(guest.page, 20);
            participants[1].score += 20;
            await personalConvergence([guest.page, watcher.page], participants);
            await resizePersonalView(guest.page, layout.resized, creatorAspect);
            expect(await guest.page.evaluate(() => game.sessionInfo.metadata.aspectRatio),
                'Resizing a guest never rewrites creator viewport metadata').toBe(creatorAspect);
            await containedPersonalHud(guest.page, participants[1].score,
                participants.reduce((sum, participant) => sum + participant.score, 0), participants[1].tag);
        });

        let terminal;
        await test.step('settle personal and team totals together including an accepted late game-over award', async () => {
            await guest.page.evaluate(async () => {
                const record = ObjectSync.getObjectByType('gameState');
                game.ship.hitCount += record.data.lives;
                const accepted = await ObjectSync.emitEvent(
                    game.ship.syncObjectId, EVENT_KIND.SHIP_STATE_CHANGED,
                    { score: game.ship.score, hitCount: game.ship.hitCount });
                if (accepted !== true) throw new Error('The owned terminal hit event was rejected by the hub');
            });
            for (const page of [guest.page, watcher.page]) {
                await expect.poll(async () => {
                    const state = await personalState(page);
                    return state?.lives === 0 && Number.isFinite(state.gameOverAt);
                }, { message: 'The authority publishes a real terminal GameState to every peer' }).toBe(true);
            }
            terminal = await personalState(guest.page);
            await personalPoints(guest.page, 37);
            participants[1].score += 37;
            await personalConvergence([guest.page, watcher.page], participants);
            const after = await personalState(watcher.page);
            expect(after.lives, 'Late points do not resurrect the shared lives pool').toBe(0);
            expect(after.gameOverAt, 'Late points do not mint a new terminal epoch').toBe(terminal.gameOverAt);
            expect(after.terminalAt, 'Late points preserve the canonical terminal time').toBe(terminal.terminalAt);
            expect(after.terminalShipId, 'The actual fatal ship remains the immutable terminal identity')
                .toBe(guestShip);
        });

        await test.step('render identical top-ranked historical rows and bootstrap a new terminal spectator', async () => {
            const expected = rankedPersonalResults(participants, maxMembers);
            const teamScore = participants.reduce((sum, participant) => sum + participant.score, 0);
            expect(expected).toHaveLength(Math.floor(maxMembers * 1.5));
            expect(expected[0].tag, 'A continued positive delta changes rank without changing the player tag')
                .toBe(participants[1].tag);
            expect(expected.some(({ score }) => score === 0), 'Departed zero-score players occupy eligible rows')
                .toBe(true);
            expect(expected.some(({ tag }) => tag === participants.at(-1).tag),
                'The last historical arrival is included because top-K keeps the highest scorers').toBe(true);
            await personalResults(guest.page, expected, teamScore, participants[1].score);
            await personalResults(watcher.page, expected, teamScore);
            await readablePersonalResults(guest.page, expected, creatorAspect > 1);
            await resizePersonalView(guest.page, layout.guest, creatorAspect);
            await personalResults(guest.page, expected, teamScore, participants[1].score);
            await readablePersonalResults(guest.page, expected);
            await resizePersonalView(guest.page, layout.resized, creatorAspect);
            await personalResults(guest.page, expected, teamScore, participants[1].score);
            await readablePersonalResults(guest.page, expected, creatorAspect > 1);
            late = await players.open({ path });
            await join(late.page, sessionId);
            await membership(guest.page, sessionId, 3);
            await personalConvergence([guest.page, watcher.page, late.page], participants);
            await personalResults(late.page, expected, teamScore);
            expect(await late.page.evaluate(() => game.ship == null),
                'A terminal spectator does not create a score participant or ship').toBe(true);
            expect((await personalState(late.page)).gameOverAt,
                'A newly opened browser receives the persisted terminal result, not a replayed local total')
                .toBe(terminal.gameOverAt);
            for (const peer of [host, guest, watcher, late]) {
                expect(peer.health.hubFrames, 'Every independent browser receives actual hub WebSocket frames')
                    .toBeGreaterThan(0);
            }
            if (creatorAspect < 1) {
                await guest.page.locator('#touch-restart').tap();
                await expect(guest.page.locator('#start-screen')).toBeVisible();
            } else {
                await guest.page.keyboard.down('Enter');
                try {
                    await expect(guest.page.locator('#start-screen')).toBeVisible();
                } finally {
                    await guest.page.keyboard.up('Enter');
                }
            }
            await expect.poll(() => guest.page.evaluate(() => SessionClient.isInSession()),
                { message: 'The reachable touch or keyboard return control really leaves the session' }).toBe(false);
            await personalConvergence([watcher.page, late.page], participants);
            await personalResults(watcher.page, expected, teamScore);
            await personalResults(late.page, expected, teamScore);
        });
    });
}

test('player tags preserve solo scoring and game-over controls', async ({ players }) => {
    const { page } = await players.open({
        path: '/?cfg.INVULNERABILITY_TIME=60000',
        viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true,
    });
    await page.locator('#btn-solo').tap();
    await playing(page);
    await expect(page.locator('#score')).toHaveText('Score: 0 : Pilot1');
    await expect(page.locator('#session-indicator')).toBeHidden();
    await page.evaluate(() => {
        game.score = 654321;
        game.lives = 1;
        updateHUD();
        enableTouchControls();
    });
    await expect(page.locator('#score')).toHaveText('Score: 654321 : Pilot1');
    expect(personalHudScores(await page.locator('#hud').innerText())).toEqual({ your: null, team: null });
    await page.evaluate(() => handleShipHit(game.ship));
    await expect(page.locator('#gameover-overlay')).toBeVisible();
    await expect(page.locator('#gameover-score')).toHaveText('Final Score: 654321');
    await expect(page.locator('#gameover-personal-score')).toBeHidden();
    expect(personalRows(await page.locator('#gameover-overlay').innerText())).toEqual([]);
    expect(await page.evaluate(() => SessionClient.isInSession()),
        'Solo play still has no multiplayer membership').toBe(false);
    await expect(page.locator('#touch-restart')).toBeVisible();
    const geometry = await page.evaluate(personalScoreGeometry);
    boxInViewport(geometry.restart, geometry.viewport, 'The solo return control stays on screen');
    expect(geometry.restartReachable, 'Solo game-over display does not cover its return control').toBe(true);
    await page.locator('#touch-restart').tap();
    await expect(page.locator('#start-screen')).toBeVisible();
});
