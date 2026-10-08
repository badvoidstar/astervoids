import { test as base, expect } from '@playwright/test';
import { provisionPlayer } from './identity-helpers.mjs';
import { installOriginGuard } from './origin-guard.mjs';

const test = base.extend({
    boards: async ({ browser, baseURL }, use) => {
        const opened = [];
        const boards = {
            async open({ guest = false, viewport = { width: 960, height: 720 }, touch = false } = {}) {
                const context = await browser.newContext({
                    baseURL, viewport, hasTouch: touch, serviceWorkers: 'block',
                });
                const tag = `LB${Math.random().toString(36).slice(2, 9)}`;
                if (!guest) await provisionPlayer(context, tag);
                const page = await context.newPage();
                const health = { offOrigin: 0, redirects: 0, requestFailures: 0 };
                let uncaught = 0;
                let scoreRequests = 0;
                page.on('pageerror', () => { uncaught++; });
                page.on('request', request => {
                    if (new URL(request.url()).pathname === '/api/leaderboard/scores') scoreRequests++;
                });
                opened.push({ page, context, health, uncaught: () => uncaught });
                await installOriginGuard(page, baseURL, health);
                await page.goto('/');
                if (guest) {
                    await expect.poll(() => page.evaluate(() =>
                        document.getElementById('identity-tag').getClientRects().length > 0
                        || document.getElementById('identity-status').textContent === 'Playing as guest'))
                        .toBe(true);
                    if (await page.locator('#identity-tag').isVisible()) await page.locator('#identity-ignore').click();
                }
                await expect(page.locator('#identity-dialog')).not.toBeVisible();
                await expect(page.locator('#identity-status')).toHaveText(guest ? 'Playing as guest' : `Playing as ${tag}`);
                return { page, tag, scoreRequests: () => scoreRequests };
            },
        };
        try { await use(boards); }
        finally {
            for (const { page, context, health, uncaught } of opened.reverse()) {
                try {
                    if (!page.isClosed()) {
                        await page.evaluate(async () => {
                            if (game.leaderboardRun || SessionClient.isInSession()) await returnToStartScreen();
                        });
                        await expect.poll(() => page.evaluate(() => leaderboardSaveState.pending),
                            { message: 'Local fixture score deliveries finish before closing', timeout: 20_000 }).toBe(0);
                    }
                } finally {
                    await context.close();
                }
                expect(uncaught(), 'Leaderboard flows have no uncaught exceptions').toBe(0);
                expect(health, 'Leaderboard requests stay on the guarded origin').toEqual({
                    offOrigin: 0, redirects: 0, requestFailures: 0,
                });
            }
        }
    },
});

// Scripted high-score fixtures must not seed a real deployed leaderboard.
const localScores = { tag: '@local-score-fixture' };
test.beforeEach(async ({}, testInfo) => {
    test.skip(!!process.env.BROWSER_SMOKE_BASE_URL && testInfo.tags.includes(localScores.tag),
        'Synthetic high scores use only the isolated local File-provider browser fixture.');
});

async function playing(page) {
    await expect(page.locator('#start-screen')).toBeHidden();
    await expect.poll(() => page.evaluate(() => !!game.ship && game.wave >= 1
        && (!game.playerIdentity || !!game.leaderboardRun))).toBe(true);
}

async function openBoard(page) {
    await page.locator('#btn-leaderboards').click();
    await expect(page.locator('#leaderboard-screen')).toBeVisible();
    await expect(page.locator('#leaderboard-scroll')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#leaderboard-status')).not.toContainText('unavailable');
}

async function ownRow(page, tag, score) {
    await expect.poll(() => page.locator('#leaderboard-rows tr').evaluateAll((rows, expected) =>
        rows.some(row => row.cells[1].textContent === expected.tag
            && Number(row.cells[2].textContent) === expected.score), { tag, score }),
    { message: 'The durable board includes this fixture player and personal score', timeout: 20_000 }).toBe(true);
}

async function returnFromGameOver(page) {
    // Game-over input is sampled by the frame loop, not the keydown handler.
    await page.keyboard.down('Enter');
    try {
        await expect(page.locator('#start-screen')).toBeVisible();
    } finally {
        await page.keyboard.up('Enter');
    }
}

test('public Leaderboards screen is readable without playing and returns to the main menu', async ({ boards }) => {
    const player = await boards.open({ guest: true });
    const requested = player.page.waitForRequest(request =>
        new URL(request.url()).pathname === '/api/leaderboard/query');
    await openBoard(player.page);
    expect((await requested).headers()['x-astervoids-browser']).toBeUndefined();
    await expect(player.page.locator('#leaderboard-table th')).toHaveText(['Rank', 'Name', 'Score', 'Wave', 'Difficulty']);
    await expect(player.page.locator('#leaderboard-filters button')).toHaveText([
        'Team Size : Any', 'Aspect Ratio : Any', 'Difficulty : Any',
    ]);
    await expect(player.page.locator('#leaderboard-team')).toBeEnabled();
    expect(player.scoreRequests()).toBe(0);
    await player.page.locator('#leaderboard-back').click();
    await expect(player.page.locator('#start-screen')).toBeVisible();
    await expect(player.page.locator('#btn-leaderboards')).toBeFocused();
});

test('named solo checkpoints include zero, update one run and survive a page reload', localScores, async ({ boards }) => {
    const { page, tag } = await boards.open();
    await page.locator('#btn-solo').click();
    await playing(page);
    await expect.poll(() => page.evaluate(async () => {
        const result = await PlayerIdentity.queryLeaderboard({ teamSize: 1 });
        return result.entries.some(entry => entry.name === PlayerIdentity.current().tag && entry.score === 0);
    })).toBe(true);
    await page.evaluate(() => {
        // Deterministic score fixture; persistence, input and the HTTP service stay real.
        game.score = 1234;
        game.wave = 3;
        game.lives = 0;
        game.state = 'gameover';
    });
    await expect(page.locator('#gameover-overlay')).toBeVisible();
    await returnFromGameOver(page);
    await openBoard(page);
    await ownRow(page, tag, 1234);
    const own = await page.evaluate(async () => (await PlayerIdentity.queryLeaderboard({}))
        .entries.filter(entry => entry.name === PlayerIdentity.current().tag));
    expect(own.length).toBe(1);
    expect(own[0]).toMatchObject({ score: 1234, wave: 3, teamSize: 1, aspect: 'square', difficulty: 0.35 });
    await page.reload();
    await expect(page.locator('#identity-dialog')).not.toBeVisible();
    await openBoard(page);
    await ownRow(page, tag, 1234);
    await expect(page.locator('#leaderboard-table th')).toHaveText(['Rank', 'Name', 'Score', 'Wave', 'Difficulty']);
    await page.keyboard.press('Escape');
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#btn-leaderboards')).toBeFocused();
});

test('guest solo play creates no high-score request or pending entry but can view public scores', localScores, async ({ boards }) => {
    const player = await boards.open({ guest: true });
    await player.page.locator('#btn-solo').click();
    await playing(player.page);
    await player.page.evaluate(() => {
        game.score = 4321;
        game.lives = 0;
        game.state = 'gameover';
    });
    await expect(player.page.locator('#gameover-overlay')).toBeVisible();
    await returnFromGameOver(player.page);
    await openBoard(player.page);
    expect(player.scoreRequests()).toBe(0);
    expect(await player.page.evaluate(() => game.leaderboardRun)).toBe(null);
    expect(await player.page.evaluate(() => leaderboardSaveState.pending)).toBe(0);
    await expect(player.page.locator('#leaderboard-save-status')).toHaveText('Guest play is not recorded.');
    const request = player.page.waitForRequest(request => new URL(request.url()).pathname === '/api/leaderboard/query');
    await player.page.locator('#leaderboard-team').click();
    expect((await request).headers()['x-astervoids-browser']).toBeUndefined();
});

async function join(page, sessionId) {
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await expect.poll(() => page.evaluate(id => SessionClient.getCurrentSession()?.id === id
        && game.sessionInfo?.id === id, sessionId)).toBe(true);
}

async function awardPoints(page, score) {
    await page.evaluate(async score => {
        if (!game.ship?.syncObjectId) throw new Error('The score fixture requires an owned network ship');
        game.ship.invulnerable = 6000;
        game.ship.score += score;
        const accepted = await ObjectSync.emitEvent(
            game.ship.syncObjectId, EVENT_KIND.SHIP_STATE_CHANGED,
            { score: game.ship.score, hitCount: game.ship.hitCount || 0 });
        if (accepted !== true) throw new Error('The real hub rejected the score event');
    }, score);
}

test('multiplayer records each personal score and counts guest/spectator member slots without spectator entries', localScores, async ({ boards }) => {
    const host = await boards.open();
    const peer = await boards.open();
    const guest = await boards.open({ guest: true });
    const spectator = await boards.open();
    await expect(host.page.locator('#btn-difficulty')).toContainText('Dancer');
    await host.page.locator('#btn-leave-create').click();
    await expect.poll(() => host.page.evaluate(() => !!SessionClient.getCurrentSession()?.id
        && game.sessionInfo?.id === SessionClient.getCurrentSession().id)).toBe(true);
    await expect(host.page.locator('#btn-start-enter')).toBeVisible();
    await expect(host.page.locator('#btn-start-enter')).toBeEnabled();
    const sessionId = await host.page.evaluate(() => SessionClient.getCurrentSession().id);
    for (const player of [peer, guest, spectator]) await join(player.page, sessionId);
    await expect.poll(() => host.page.evaluate(() => SessionClient.getCurrentSession().members.length)).toBe(4);
    await host.page.locator('#btn-start-enter').click();
    await playing(host.page);
    await expect(peer.page.locator('#btn-start-enter')).toBeEnabled();
    await peer.page.locator('#btn-start-enter').click();
    await playing(peer.page);
    await awardPoints(host.page, 101);
    await awardPoints(peer.page, 303);
    await expect.poll(() => host.page.evaluate(() => getSessionScoreView()?.groupScore)).toBe(404);
    for (const player of [host, peer]) {
        await player.page.keyboard.press('Escape');
        await expect(player.page.locator('#start-screen')).toBeVisible();
    }
    await Promise.all([host, peer].map(player =>
        expect.poll(() => player.page.evaluate(() => leaderboardSaveState.pending)).toBe(0)));
    await openBoard(host.page);
    await ownRow(host.page, host.tag, 101);
    await ownRow(host.page, peer.tag, 303);
    const rows = await host.page.evaluate(async () =>
        (await PlayerIdentity.queryLeaderboard({ teamSize: 4, difficulty: 0.35 })).entries);
    expect(rows.find(row => row.name === host.tag)?.score).toBe(101);
    expect(rows.find(row => row.name === peer.tag)?.score).toBe(303);
    expect(rows.some(row => row.name === spectator.tag)).toBe(false);
    expect(guest.scoreRequests()).toBe(0);
    expect(spectator.scoreRequests()).toBe(0);
});

async function clickFilter(page, suffix, label, field, value) {
    const response = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/leaderboard/query'
        && response.request().postDataJSON()?.[field] === value);
    await page.locator(`#leaderboard-${suffix}`).click();
    await expect(page.locator(`#leaderboard-${suffix}`)).toHaveText(label);
    const result = await (await response).json();
    expect(Array.isArray(result.entries)).toBe(true);
    if (value !== null) expect(result.entries.every(entry => entry[field] === value)).toBe(true);
    await expect(page.locator('#leaderboard-scroll')).toHaveAttribute('aria-busy', 'false');
    return result;
}

async function mouseDrag(page) {
    const box = await page.locator('#leaderboard-scroll').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height - 20, 170);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 5; step++) {
        await page.mouse.move(x, y - step * 14);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();
}

test('top-50 view cycles every filter, fits narrow screens and supports mouse/touch inertia and keyboard scrolling', localScores, async ({ boards }) => {
    const { page } = await boards.open({ touch: true });
    const configuration = await page.evaluate(() => PlayerIdentity.queryLeaderboard({}));
    expect(configuration.limit).toBe(50);
    await page.evaluate(async ({ limit, maxTeamSize }) => {
        const playerId = PlayerIdentity.current().id;
        const baseScore = 3_000_000_000 + Math.floor(Date.now() / 1000) % 1_000_000_000;
        for (let index = 0; index < limit + 5; index++) {
            await PlayerIdentity.saveLeaderboardScore({
                playerId, runId: crypto.randomUUID(), score: baseScore + index, wave: index + 1,
                teamSize: index % maxTeamSize + 1, aspectRatio: [0.5, 1, 2][index % 3],
                difficulty: AstervoidsConfig.ASTEROID_DIFFICULTY_PRESETS[index % 4].value,
            });
        }
    }, configuration);
    expect(await page.locator('#menu-utilities .menu-utility-group').first().locator('button')
        .evaluateAll(buttons => buttons.map(button => button.id)))
        .toEqual(['btn-fullscreen', 'btn-leaderboards', 'btn-control-mode', 'btn-difficulty']);
    await openBoard(page);
    await expect(page.locator('#leaderboard-rows tr')).toHaveCount(50);
    await expect(page.locator('#leaderboard-filters button')).toHaveText([
        'Team Size : Any', 'Aspect Ratio : Any', 'Difficulty : Any',
    ]);
    const initial = await page.locator('#leaderboard-rows tr').evaluateAll(rows =>
        rows.map(row => ({ rank: Number(row.cells[0].textContent), score: Number(row.cells[2].textContent) })));
    expect(initial.map(row => row.rank)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(initial.every((row, index) => index === 0 || initial[index - 1].score >= row.score)).toBe(true);
    for (let size = 1; size <= configuration.maxTeamSize; size++) {
        await clickFilter(page, 'team', `Team Size : ${size}`, 'teamSize', size);
    }
    await clickFilter(page, 'team', 'Team Size : Any', 'teamSize', null);
    for (const [label, value] of [['Portrait', 'portrait'], ['Landscape', 'landscape'], ['Rectangle', 'square'], ['Any', null]]) {
        await clickFilter(page, 'aspect', `Aspect Ratio : ${label}`, 'aspect', value);
    }
    for (const [label, value] of [['Shifter', 0.2], ['Dancer', 0.35], ['Raver', 0.5], ['Survivor', 0.65], ['Any', null]]) {
        await clickFilter(page, 'difficulty', `Difficulty : ${label}`, 'difficulty', value);
    }
    const scroller = page.locator('#leaderboard-scroll');
    await mouseDrag(page);
    const released = await scroller.evaluate(element => element.scrollTop);
    expect(released).toBeGreaterThan(0);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(released + 5);
    await scroller.focus();
    await page.keyboard.press('End');
    await expect.poll(() => scroller.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    await page.keyboard.press('Home');
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => game.state === 'start' && !game.ship && !Object.values(keys).some(Boolean))).toBe(true);

    await page.setViewportSize({ width: 320, height: 568 });
    const geometry = await page.locator('#leaderboard-screen').evaluate(screen => {
        const scroll = document.getElementById('leaderboard-scroll');
        const back = document.getElementById('leaderboard-back').getBoundingClientRect();
        return {
            noHorizontalOverflow: screen.scrollWidth <= screen.clientWidth + 1
                && scroll.scrollWidth <= scroll.clientWidth + 1,
            rowsScroll: scroll.scrollHeight > scroll.clientHeight,
            backVisible: back.top >= 0 && back.bottom <= innerHeight,
            nativeText: getComputedStyle(document.getElementById('leaderboard-table')).transform === 'none',
        };
    });
    expect(geometry).toEqual({ noHorizontalOverflow: true, rowsScroll: true, backVisible: true, nativeText: true });
    const cdp = await page.context().newCDPSession(page);
    const box = await scroller.boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height - 20);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 5; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x, y: y - step * 14, id: 1 }],
        });
        await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const touchRelease = await scroller.evaluate(element => element.scrollTop);
    expect(touchRelease).toBeGreaterThan(0);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(touchRelease + 5);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await scroller.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
    await mouseDrag(page);
    const stopped = await scroller.evaluate(element => element.scrollTop);
    await page.waitForTimeout(150);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(stopped);
    await page.locator('#leaderboard-back').click();
    await expect(page.locator('#leaderboard-screen')).toBeHidden();
    await expect(page.locator('#btn-leaderboards')).toBeFocused();
});
