import { expect } from '@playwright/test';
import {
    test, playing, leaveGame, createSession, joinSession, enterSession, fireOnce,
} from './progression-fixture.mjs';

async function localProgression(page) {
    return page.evaluate(() => {
        const progression = getLocalProgression();
        return {
            ...progression, score: game.score, lives: game.lives,
            hits: game.ship?.hitCount ?? 0, shipId: game.ship?.syncObjectId,
        };
    });
}

async function startSolo(page, touch) {
    const solo = page.locator('#btn-solo');
    await expect(solo).toBeEnabled();
    if (touch) await solo.tap();
    else await solo.click();
    await playing(page);
}

async function pauseSolo(page, touch) {
    if (touch) {
        await expect(page.locator('#touch-pause')).toBeVisible();
        await page.locator('#touch-pause').tap();
    } else {
        await page.keyboard.press('p');
    }
    await expect(page.locator('#pause-menu')).toBeVisible();
    await expect.poll(() => page.evaluate(() => game.state)).toBe('paused');
    await expect(page.getByRole('progressbar')).toBeHidden();
    if (touch) {
        await expect(page.locator('#pause-restart-btn')).toBeVisible();
        await expect(page.locator('#pause-restart-btn')).toBeEnabled();
    } else {
        await expect(page.locator('#pause-restart-btn')).toBeHidden();
        await expect(page.locator('#pause-menu .desktop-only').filter({ hasText: 'ESC' })).toBeVisible();
    }
}

async function restartToSoloMenu(page, touch) {
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
    await expect(page.locator('#pause-menu')).toBeHidden();
    await expect(page.locator('#btn-solo')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => game.state)).toBe('start');
    await expect(page.getByRole('progressbar')).toBeHidden();
}

async function soloArena(page) {
    await page.evaluate(() => {
        // A stationary, distant rock prevents an unintended next wave while the
        // test arranges collisions. Neither XP nor score is seeded.
        const sentinel = new Asteroid(0.05, 0.05, CONFIG.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
        sentinel.angle = 0;
        sentinel.rotationSpeed = 0;
        game.astervoids = [sentinel];
        game.bullets = [];
        game.effects = [];
        game.ship.x = 0.35;
        game.ship.y = 0.5;
        game.ship.angle = 0;
        game.ship.velocityX = 0;
        game.ship.velocityY = 0;
        game.ship.invulnerable = CONFIG.INVULNERABILITY_TIME * 100;
        game.ship.resetControls();
        game.state = 'playing';
    });
}

async function soloTarget(page, { hits = 1, payload = 0, ram = false } = {}) {
    return page.evaluate(({ hits, payload, ram }) => {
        game.bullets = [];
        game.ship.x = 0.35;
        game.ship.y = 0.5;
        game.ship.angle = 0;
        game.ship.velocityX = 0;
        game.ship.velocityY = 0;
        game.ship.shootCooldown = 0;
        if (ram) game.ship.invulnerable = 0;
        const distance = ram ? CONFIG.SHIP_SIZE * 0.8 : 0.14;
        const target = new Asteroid(
            game.ship.x + sizeToNormalizedX(distance), game.ship.y,
            CONFIG.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
        Object.assign(target, { maxHits: hits, hitsRemaining: hits, payloadKind: payload, angle: 0, rotationSpeed: 0 });
        const id = getAsteroidObjectId(target);
        game.astervoids.push(target);
        return { id, points: target.getPoints() };
    }, { hits, payload, ram });
}

async function soloRemaining(page, id) {
    return page.evaluate(id => game.astervoids.find(asteroid =>
        asteroid.localObjectId === id)?.hitsRemaining ?? null, id);
}

async function soloBreak(page) {
    const target = await soloTarget(page);
    await fireOnce(page);
    await expect.poll(() => soloRemaining(page, target.id),
        { message: 'A real keyboard-fired bullet breaks the arranged asteroid' }).toBeNull();
    return target;
}

async function collectSoloPickup(page, sourceId) {
    await expect.poll(() => page.evaluate(id => game.effects.some(effect =>
        effect.data.kind === GAME_EFFECT_KIND.PICKUP && effect.data.sourceId === id), sourceId),
    { message: 'The armor break produces a stationary collectible in the live simulation' }).toBe(true);
    await page.evaluate(id => {
        const effect = game.effects.find(effect =>
            effect.data.kind === GAME_EFFECT_KIND.PICKUP && effect.data.sourceId === id);
        game.ship.x = effect.data.x - sizeToNormalizedX(CONFIG.SHIP_SIZE * 2 + PROGRESSION.PICKUP_RADIUS);
        game.ship.y = effect.data.y;
        game.ship.angle = 0;
        game.ship.velocityX = 0;
        game.ship.velocityY = 0;
        game.ship.resetControls();
    }, sourceId);
    await page.keyboard.down('ArrowUp');
    try {
        await expect.poll(() => page.evaluate(id => game.effects.some(effect =>
            effect.data.kind === GAME_EFFECT_KIND.PICKUP && effect.data.sourceId === id), sourceId),
        { message: 'Actual thrust brings the ship hull into the pickup and consumes it' }).toBe(false);
    } finally {
        await page.keyboard.up('ArrowUp');
    }
}

async function sessionXp(page, participantId) {
    return page.evaluate(id => {
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        if (!state?.data?.participantXp) return null;
        const xp = AstervoidsWireCodec.unpackXpMap(state.data.participantXp)[id.toLowerCase()];
        return {
            xp, level: xp === undefined ? null : getLevelForXp(xp),
            owner: state.ownerMemberId, version: state.version, lives: state.data.lives,
        };
    }, participantId);
}

async function sessionArena(owner, pages) {
    const sentinelId = await owner.evaluate(async () => {
        const old = ObjectSync.getObjectsByType(OBJECT_TYPES.ASTEROID).map(object => object.id);
        const sentinel = new Asteroid(0.05, 0.05, CONFIG.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
        sentinel.angle = 0;
        sentinel.rotationSpeed = 0;
        const created = await ObjectSync.createObject(sentinel.toSyncData(), 'Session');
        await Promise.all(old.map(id => ObjectSync.deleteObject(id)));
        return created.id;
    });
    for (const page of pages) {
        await expect.poll(() => page.evaluate(id => !!ObjectSync.getObject(id), sentinelId)).toBe(true);
        await page.evaluate(() => {
            game.ship.x = 0.35;
            game.ship.y = 0.5;
            game.ship.angle = 0;
            game.ship.velocityX = 0;
            game.ship.velocityY = 0;
            game.ship.invulnerable = CONFIG.INVULNERABILITY_TIME * 100;
            game.ship.resetControls();
            ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
        });
    }
}

async function sessionTarget(owner, shooter, { ram = false, hits = 1, payload = 0 } = {}) {
    const setup = await shooter.evaluate(ram => {
        game.ship.x = 0.35;
        game.ship.y = 0.5;
        game.ship.angle = 0;
        game.ship.velocityX = 0;
        game.ship.velocityY = 0;
        game.ship.shootCooldown = 0;
        if (ram) game.ship.invulnerable = 0;
        ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
        return {
            x: game.ship.x + sizeToNormalizedX(ram ? CONFIG.SHIP_SIZE * 0.8 : 0.14),
            y: game.ship.y, radius: CONFIG.MIN_ASTEROID_RADIUS / 2,
        };
    }, ram);
    const targetId = await owner.evaluate(async ({ setup, hits, payload }) => {
        const asteroid = new Asteroid(setup.x, setup.y, setup.radius, 0, 0, 123);
        Object.assign(asteroid, { maxHits: hits, hitsRemaining: hits, payloadKind: payload, angle: 0, rotationSpeed: 0 });
        const target = await ObjectSync.createObject(asteroid.toSyncData(), 'Session');
        return target.id;
    }, { setup, hits, payload });
    if (!ram) {
        await expect.poll(() => shooter.evaluate(id => game.astervoids.some(asteroid =>
            asteroid.syncObjectId === id), targetId)).toBe(true);
    }
    return targetId;
}

async function barGeometry(page) {
    return page.getByRole('progressbar').evaluate(bar => {
        const box = element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
        };
        const canvas = document.getElementById('game');
        const canvasBox = canvas.getBoundingClientRect();
        const view = game.viewport;
        const region = {
            left: canvasBox.left + view.x * canvasBox.width / canvas.width,
            top: canvasBox.top + view.y * canvasBox.height / canvas.height,
            right: canvasBox.left + (view.x + view.width) * canvasBox.width / canvas.width,
            bottom: canvasBox.top + (view.y + view.height) * canvasBox.height / canvas.height,
        };
        const native = bar instanceof HTMLElement;
        const ancestors = [];
        for (let node = bar; node && node !== document.body; node = node.parentElement) {
            const transform = getComputedStyle(node).transform;
            if (transform !== 'none') {
                const matrix = new DOMMatrix(transform);
                ancestors.push({ x: matrix.a, y: matrix.d, shearX: matrix.b, shearY: matrix.c });
            }
        }
        return {
            bar: box(bar), region, native, ancestors,
            bitmap: bar.parentElement.querySelectorAll('img, canvas').length,
            touch: [...document.querySelectorAll('#mobile-controls .touch-btn')].map(box),
            min: Number(bar.getAttribute('aria-valuemin')),
            max: Number(bar.getAttribute('aria-valuemax')),
            value: Number(bar.getAttribute('aria-valuenow')),
        };
    });
}

test('solo armored hits earn nothing until break, then real hull pickup advances exactly one level', async ({ players }) => {
    const { page } = await players.open();
    await page.locator('#btn-solo').click();
    await playing(page);
    await soloArena(page);
    const levelup = await page.evaluate(() => PAYLOAD_KIND.LEVELUP);
    const target = await soloTarget(page, { hits: 3, payload: levelup });
    const score = (await localProgression(page)).score;
    for (const remaining of [2, 1]) {
        const volley = await fireOnce(page);
        expect(volley).toHaveLength(1);
        await expect.poll(() => soloRemaining(page, target.id)).toBe(remaining);
        expect(await localProgression(page)).toMatchObject({ xp: 0, level: 1, score });
    }
    await fireOnce(page);
    await expect.poll(() => soloRemaining(page, target.id)).toBeNull();
    expect(await localProgression(page)).toMatchObject({ xp: 10, level: 1, score: score + target.points });
    await collectSoloPickup(page, target.id);
    await expect.poll(async () => (await localProgression(page)).xp).toBe(20);
    expect(await localProgression(page)).toMatchObject({ xp: 20, level: 2 });
    await page.waitForTimeout(500);
    expect((await localProgression(page)).xp, 'The removed pickup cannot activate twice').toBe(20);
});

for (const layout of [
    { name: 'desktop', viewport: { width: 1280, height: 900 }, touch: false },
    { name: 'touch portrait', viewport: { width: 320, height: 568 }, touch: true },
]) {
    test(`actual per-break XP, full multishot, death retention, new-run reset and native bar (${layout.name})`, async ({ players }) => {
        const { page } = await players.open(layout);
        await expect(page.getByRole('progressbar')).toBeHidden();
        await startSolo(page, layout.touch);
        await expect(page.locator('#game-container')).toHaveClass(
            layout.touch ? /touch-enabled/ : /^(?!.*touch-enabled)/);
        await soloArena(page);
        await page.evaluate(() => { game.leaderboardRun = null; });
        expect((await localProgression(page)).xp).toBe(0);
        await soloBreak(page);
        expect(await localProgression(page)).toMatchObject({ xp: 10, level: 1 });
        await soloBreak(page);
        expect(await localProgression(page)).toMatchObject({ xp: 20, level: 2 });
        expect(await fireOnce(page), 'Keyboard controls now fire a complete two-shot volley').toHaveLength(2);
        await expect(page.getByRole('progressbar')).toBeVisible();
        const before = await localProgression(page);
        await soloTarget(page, { ram: true });
        await expect.poll(async () => (await localProgression(page)).hits).toBe(before.hits + 1);
        await expect.poll(async () => (await localProgression(page)).xp).toBe(30);
        expect(await localProgression(page)).toMatchObject({ level: 2, lives: before.lives - 1 });
        const geometry = await barGeometry(page);
        expect(geometry.native).toBe(true);
        expect(geometry.bitmap).toBe(0);
        expect(geometry.bar.left).toBeGreaterThanOrEqual(geometry.region.left);
        expect(geometry.bar.right).toBeLessThanOrEqual(geometry.region.right + 1);
        expect(geometry.bar.top).toBeGreaterThanOrEqual(geometry.region.top);
        expect(geometry.bar.bottom).toBeLessThanOrEqual(geometry.region.bottom);
        expect(geometry.bar.right).toBeGreaterThan((geometry.region.left + geometry.region.right) / 2);
        expect(geometry.bar.top).toBeLessThan(geometry.region.top + 100);
        for (const transform of geometry.ancestors) {
            expect(transform).toEqual({ x: 1, y: 1, shearX: 0, shearY: 0 });
        }
        expect((geometry.value - geometry.min) / (geometry.max - geometry.min)).toBeCloseTo(0.25, 4);
        const visibleTouchControls = geometry.touch.filter(control => control.width > 0);
        expect(visibleTouchControls).toHaveLength(layout.touch ? 2 : 0);
        for (const control of visibleTouchControls) {
            expect(geometry.bar.right <= control.left || geometry.bar.left >= control.right
                || geometry.bar.bottom <= control.top || geometry.bar.top >= control.bottom,
            'The leveling bar does not cover a visible touch control').toBe(true);
        }
        await pauseSolo(page, layout.touch);
        const paused = await localProgression(page);
        await page.waitForTimeout(400);
        expect(await localProgression(page)).toMatchObject({ xp: paused.xp, level: paused.level });
        await restartToSoloMenu(page, layout.touch);
        await startSolo(page, layout.touch);
        expect(await localProgression(page)).toMatchObject({ xp: 0, level: 1, score: 0, hits: 0 });
        await expect(page.locator('#xp-level')).toHaveText('L1');
        await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
        await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '20');
        await pauseSolo(page, layout.touch);
        await restartToSoloMenu(page, layout.touch);
    });
}

test('independent SignalR clients replicate earned XP, preserve it through death, ownership migration and rejoin', async ({ players }) => {
    const host = await players.open();
    const guest = await players.open();
    const sessionId = await createSession(host.page);
    players.ownSession(sessionId);
    await joinSession(guest.page, sessionId);
    await enterSession(host.page);
    await enterSession(guest.page);
    await sessionArena(host.page, [host.page, guest.page]);
    const participant = await host.page.evaluate(() => SessionClient.getParticipantId());
    const guestParticipant = await guest.page.evaluate(() => SessionClient.getParticipantId());
    expect(participant).not.toBe(guestParticipant);
    const initialVersion = (await sessionXp(guest.page, participant)).version;
    for (const xp of [10, 20]) {
        const targetId = await sessionTarget(guest.page, host.page);
        await fireOnce(host.page);
        for (const page of [host.page, guest.page]) {
            await expect.poll(() => page.evaluate(id => !!ObjectSync.getObject(id), targetId),
                { message: 'The asteroid owner commits the break through real SignalR' }).toBe(false);
            await expect.poll(async () => (await sessionXp(page, participant))?.xp,
                { message: 'Accepted per-break XP converges on each independent client' }).toBe(xp);
        }
    }
    expect(await localProgression(host.page)).toMatchObject({ xp: 20, level: 2 });
    expect((await sessionXp(guest.page, participant)).version).toBeGreaterThan(initialVersion);
    expect(await sessionXp(guest.page, guestParticipant)).toMatchObject({ xp: 0, level: 1 });
    const beforeDeath = await localProgression(host.page);
    await sessionTarget(guest.page, host.page, { ram: true });
    await expect.poll(async () => (await localProgression(host.page)).hits).toBe(beforeDeath.hits + 1);
    for (const page of [host.page, guest.page]) {
        await expect.poll(async () => (await sessionXp(page, participant))?.xp).toBe(30);
        await expect.poll(async () => (await sessionXp(page, participant))?.lives).toBe(beforeDeath.lives - 1);
    }
    expect(await localProgression(host.page)).toMatchObject({ xp: 30, level: 2 });
    const departedShip = beforeDeath.shipId;
    await leaveGame(host.page);
    await expect.poll(() => guest.page.evaluate(() =>
        ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE)?.ownerMemberId === SessionClient.getCurrentMember()?.id),
    { message: 'The real departure migrates GameState ownership to the remaining client' }).toBe(true);
    expect(await sessionXp(guest.page, participant)).toMatchObject({ xp: 30, level: 2 });
    await joinSession(host.page, sessionId);
    await enterSession(host.page);
    expect(await host.page.evaluate(() => SessionClient.getParticipantId())).toBe(participant);
    expect((await localProgression(host.page)).shipId).not.toBe(departedShip);
    expect(await localProgression(host.page)).toMatchObject({ xp: 30, level: 2 });
    expect((await sessionXp(guest.page, participant)).lives).toBe(beforeDeath.lives - 1);
    const spectator = await players.open();
    await joinSession(spectator.page, sessionId);
    expect(await spectator.page.evaluate(() => game.ship)).toBeNull();
    await expect(spectator.page.getByRole('progressbar')).toBeHidden();
    expect(await sessionXp(spectator.page, participant)).toMatchObject({ xp: 30, level: 2 });
    expect(host.health.hubFrames).toBeGreaterThan(0);
    expect(guest.health.hubFrames).toBeGreaterThan(0);
});
