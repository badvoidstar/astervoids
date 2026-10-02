import { test as base, expect } from '@playwright/test';
import { installOriginGuard } from './origin-guard.mjs';
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
                return { page, health };
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
    return page.evaluate(() => SessionClient.getCurrentSession().id);
}

async function join(page, sessionId) {
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await expect.poll(() => page.evaluate(id => SessionClient.getCurrentSession()?.id === id, sessionId),
        { message: 'The selected session is joined through the picker' }).toBe(true);
    await sessionReady(page, sessionId);
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

async function personalState(page) {
    return page.evaluate(() => {
        const record = ObjectSync.getObjectByType('gameState');
        if (!record) return null;
        const data = record.data;
        const available = data.participantScores instanceof Uint8Array
            && data.participantNumbers instanceof Uint8Array;
        const confirmation = available ? {
            groupScore: data.groupScore,
            participantScores: data.participantScores,
            participantNumbers: data.participantNumbers,
        } : null;
        return {
            available,
            scores: available ? AstervoidsWireCodec.unpackCounterMap(data.participantScores) : null,
            numbers: available ? AstervoidsWireCodec.unpackCounterMap(data.participantNumbers) : null,
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

async function personalResults(page, expected, teamScore) {
    const overlay = page.locator('#gameover-overlay');
    await expect(overlay).toBeVisible();
    await expect.poll(async () => personalRows(await overlay.innerText()),
        { message: 'Actual rendered result rows match the converged durable ranking' }).toEqual(expected);
    await expect.poll(async () => {
        const text = (await page.locator('#gameover-score').innerText()).replaceAll(',', '');
        const values = text.match(/\d+/g);
        return values?.length === 1 ? Number(values[0]) : null;
    }, { message: 'The rendered final team score settles with the personal result rows' }).toBe(teamScore);
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
        score: bounds(geometry.score), session: bounds(geometry.session),
        wave: bounds(geometry.wave), lives: bounds(geometry.lives),
        overlay: bounds(geometry.overlay), title: bounds(geometry.title),
        total: bounds(geometry.total), prompt: bounds(geometry.prompt),
        results: bounds(geometry.results),
        scroll: geometry.results && [
            geometry.results.clientHeight, geometry.results.scrollHeight, geometry.results.scrollTop,
        ],
    })}`);
}

async function containedPersonalHud(page, yourScore, teamScore) {
    const longName = 'A remarkably long multiplayer session name';
    await page.evaluate(name => {
        game.sessionInfo.name = name;
        updateHUD();
    }, longName);
    await expect(page.locator('#session-indicator')).toContainText(longName);
    await expect.poll(async () => personalHudScores(await page.locator('#hud').innerText()),
        { message: 'The lowercase individual and team HUD counters display the accepted totals' })
        .toEqual({ your: yourScore, team: teamScore });
    await expect(page.locator('#wave')).toHaveText(/^Wave: [1-9]\d*$/);
    await expect(page.locator('#lives')).toHaveText(/^Lives: [1-9]\d*$/);
    const geometry = await page.evaluate(personalScoreGeometry);
    personalLayoutEvidence('HUD', geometry);
    expect(geometry.your, 'The individual counter has real rendered geometry').not.toBeNull();
    expect(geometry.team, 'The team counter has real rendered geometry').not.toBeNull();
    expect(geometry.your.bottom, 'your score stays above team score')
        .toBeLessThanOrEqual(geometry.team.top + 1);
    const boxes = [geometry.score, geometry.session, geometry.wave, geometry.lives];
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
            'Scores, session, Wave and Lives never overlap even in a compact creator view').toBe(true);
        }
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
    expect(geometry.rows.map(({ number, score }) => ({ number, score }))).toEqual(expected);
    for (const box of [geometry.overlay, geometry.title, geometry.total, geometry.prompt, geometry.results]) {
        boxInRegion(box, geometry.gameView, 'Final title, team total, prompt and results stay in the creator view');
    }
    expect(geometry.title.fontSize, 'The game-over heading remains readable').toBeGreaterThanOrEqual(20);
    expect(geometry.total.fontSize, 'The complete six-digit team total remains readable').toBeGreaterThanOrEqual(12);
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
                number: 1, score: 0,
            });
            await personalConvergence([host.page, guest.page], participants);
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
                number: 2, score: 0,
            });
            const config = await host.page.evaluate(() => ({
                threshold: CONFIG.EXTRA_LIFE_SCORE_THRESHOLD, lives: CONFIG.MULTIPLAYER_LIVES,
            }));
            scoreThreshold = config.threshold;
            startingLives = config.lives;
            await personalConvergence([host.page, guest.page], participants);
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
                participants.reduce((sum, participant) => sum + participant.score, 0));
        });

        await test.step('exclude a pure watcher and continue score updates after the original authority departs', async () => {
            watcher = await players.open({ path });
            await join(watcher.page, sessionId);
            await membership(host.page, sessionId, 3);
            await expect.poll(() => watcher.page.evaluate(() => game.ship == null),
                { message: 'A joined lobby watcher has no player ship' }).toBe(true);
            await personalConvergence([host.page, guest.page, watcher.page], participants);
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
                participants.reduce((sum, participant) => sum + participant.score, 0));
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
            expect(expected[0].number, 'A continued positive delta changes rank without changing the player label')
                .toBe(2);
            expect(expected.some(({ score }) => score === 0), 'Departed zero-score players occupy eligible rows')
                .toBe(true);
            expect(expected.some(({ number }) => number === participants.length),
                'The last historical arrival is included because top-K keeps the highest scorers').toBe(true);
            await personalResults(guest.page, expected, teamScore);
            await personalResults(watcher.page, expected, teamScore);
            await readablePersonalResults(guest.page, expected, creatorAspect > 1);
            await resizePersonalView(guest.page, layout.guest, creatorAspect);
            await personalResults(guest.page, expected, teamScore);
            await readablePersonalResults(guest.page, expected);
            await resizePersonalView(guest.page, layout.resized, creatorAspect);
            await personalResults(guest.page, expected, teamScore);
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

test('personal scores leave solo score and game-over controls unchanged', async ({ players }) => {
    const { page } = await players.open({
        path: '/?cfg.INVULNERABILITY_TIME=60000',
        viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true,
    });
    await page.locator('#btn-solo').tap();
    await playing(page);
    await expect(page.locator('#score')).toHaveText('Score: 0');
    await expect(page.locator('#session-indicator')).toBeHidden();
    await page.evaluate(() => {
        game.score = 654321;
        game.lives = 1;
        updateHUD();
        enableTouchControls();
    });
    await expect(page.locator('#score')).toHaveText('Score: 654321');
    expect(personalHudScores(await page.locator('#hud').innerText())).toEqual({ your: null, team: null });
    await page.evaluate(() => handleShipHit(game.ship));
    await expect(page.locator('#gameover-overlay')).toBeVisible();
    await expect(page.locator('#gameover-score')).toHaveText('Final Score: 654321');
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
