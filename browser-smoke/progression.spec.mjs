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

async function breakSoloPayload(page, payloadKind, hits = 2) {
    const target = await soloTarget(page, { hits, payload: payloadKind });
    for (let shot = 0; shot < hits && await soloRemaining(page, target.id) !== null; shot++) {
        const before = await soloRemaining(page, target.id);
        await fireOnce(page);
        await expect.poll(() => soloRemaining(page, target.id),
            { message: 'A real volley accepts damage against the arranged payload carrier' })
            .not.toBe(before);
    }
    expect(await soloRemaining(page, target.id)).toBeNull();
    return target;
}

async function earnSoloLevel(page, level) {
    for (let attempt = 0; (await localProgression(page)).level < level && attempt < level; attempt++) {
        const levelup = await page.evaluate(() => PAYLOAD_KIND.LEVELUP);
        const target = await breakSoloPayload(page, levelup);
        await collectSoloPickup(page, target.id);
    }
    expect((await localProgression(page)).level).toBe(level);
}

async function tabToChoice(page, id) {
    for (let tab = 0; tab < 12; tab++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(id => document.activeElement?.id === id, id)) return;
    }
    throw new Error('Native choice button was not reachable with bounded keyboard navigation');
}

async function observedVolleys(page, count) {
    await page.evaluate(() => {
        const audit = {
            active: true, seen: new Set(game.bullets.map(bullet => bullet.damageId)), volleys: [],
        };
        globalThis.progressionVolleyAudit = audit;
        const sample = () => {
            if (!audit.active) return;
            const fresh = game.bullets.filter(bullet => !audit.seen.has(bullet.damageId));
            if (fresh.length) {
                for (const bullet of fresh) audit.seen.add(bullet.damageId);
                audit.volleys.push({
                    at: game.simulationTimeMs, count: fresh.length, cooldown: game.ship.shootCooldown,
                });
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    await page.keyboard.down('Space');
    try {
        await expect.poll(() => page.evaluate(() => progressionVolleyAudit.volleys.length),
            { message: 'Held real fire produces repeated complete live volleys' }).toBeGreaterThanOrEqual(count);
    } finally {
        await page.keyboard.up('Space');
        await page.evaluate(() => { progressionVolleyAudit.active = false; });
    }
    return page.evaluate(count => progressionVolleyAudit.volleys.slice(0, count), count);
}

for (const layout of [
    { name: 'desktop', viewport: { width: 1280, height: 900 }, touch: false },
    { name: 'touch portrait', viewport: { width: 320, height: 568 }, touch: true },
]) {
    test(`native optional choices, shield protection, rapid-fire cadence and coalesced level feedback (${layout.name})`, async ({ players }) => {
        const { page } = await players.open({ ...layout, reducedMotion: 'reduce' });
        await startSolo(page, layout.touch);
        await soloArena(page);
        await earnSoloLevel(page, 4);
        await expect(page.locator('#modifier-choice')).toBeVisible();
        await expect(page.locator('#level-banner')).toContainText('Level 4');
        expect(await page.locator('#level-banner').evaluate(element => element instanceof HTMLElement)).toBe(true);
        expect(await page.evaluate(() => ['modifier-focus', 'modifier-sweep'].includes(document.activeElement?.id)))
            .toBe(false);
        const beforeChoice = await page.evaluate(() => ({
            at: game.simulationTimeMs, ids: game.bullets.map(bullet => bullet.damageId),
        }));
        for (const id of ['modifier-focus', 'modifier-sweep']) {
            const button = page.locator(`#${id}`);
            expect(await button.evaluate(element => element instanceof HTMLButtonElement)).toBe(true);
            const box = await button.boundingBox();
            const geometry = await barGeometry(page);
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.x).toBeGreaterThanOrEqual(geometry.region.left);
            expect(box.x + box.width).toBeLessThanOrEqual(geometry.region.right + 1);
            expect(box.y + box.height).toBeLessThanOrEqual(geometry.region.bottom);
            for (const control of geometry.touch.filter(control => control.width > 0)) {
                expect(box.x + box.width <= control.left || box.x >= control.right
                    || box.y + box.height <= control.top || box.y >= control.bottom,
                'Native choices cannot cover the visible touch controls').toBe(true);
            }
        }
        await page.waitForTimeout(100);
        expect(await page.evaluate(before => game.state === 'playing'
            && game.simulationTimeMs > before.at, beforeChoice)).toBe(true);
        if (layout.touch) {
            const canvas = await page.locator('#game').boundingBox();
            const button = await page.locator('#modifier-focus').boundingBox();
            const move = { x: canvas.x + canvas.width * 0.2, y: canvas.y + canvas.height * 0.75, id: 1 };
            const choice = { x: button.x + button.width / 2, y: button.y + button.height / 2, id: 2 };
            const cdp = await page.context().newCDPSession(page);
            try {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [move] });
                move.y -= 12;
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [move] });
                const anchor = await page.evaluate(() => stickInput.moveTouchId);
                expect(anchor).not.toBeNull();
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [move, choice] });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [choice] });
                await expect.poll(() => page.evaluate(() => game.soloModifier?.modifierKind)).toBe(1);
                expect(await page.evaluate(() => stickInput.moveTouchId)).toBe(anchor);
                expect(await page.evaluate(() => stickInput.fireTouchId)).toBeNull();
            } finally {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await cdp.detach();
            }
        } else {
            await page.keyboard.press('1');
        }
        await expect(page.locator('#modifier-choice')).toBeHidden();
        await expect(page.locator('#modifier-current')).toContainText('FOCUS');
        await page.keyboard.press('2');
        expect(await page.evaluate(() => game.soloModifier))
            .toEqual({ consumedMilestone: 4, modifierKind: 1 });
        const focusShots = await fireOnce(page);
        expect(focusShots).toHaveLength(4);
        expect(await page.evaluate(ids => game.bullets.filter(bullet => ids.includes(bullet.damageId))
            .every(bullet => Math.abs(Math.hypot(bullet.velocityX, bullet.velocityY)
                - CONFIG.BULLET_SPEED * 1.15) < 1e-8), focusShots)).toBe(true);

        const shield = await page.evaluate(() => PAYLOAD_KIND.SHIELD);
        const shieldCarrier = await breakSoloPayload(page, shield);
        await collectSoloPickup(page, shieldCarrier.id);
        const protectedLife = await page.evaluate(() => ({
            lifeId: game.ship.boostState.lifeId, until: game.ship.boostState.shieldUntil,
            hits: game.ship.hitCount, lives: game.lives,
        }));
        await expect(page.locator('#boost-status')).toContainText(/Shield [1-6]s/);
        await soloTarget(page, { ram: true });
        await page.waitForTimeout(150);
        expect(await localProgression(page)).toMatchObject({
            hits: protectedLife.hits, lives: protectedLife.lives,
        });
        await page.waitForFunction(({ until }) => game.simulationTimeMs >= until,
            protectedLife, { polling: 'raf' });
        await expect.poll(() => page.evaluate(() => game.ship.hitCount),
            { message: 'The real collision starts damaging again after the six-second simulation deadline' })
            .toBe(protectedLife.hits + 1);
        expect(await page.evaluate(before => ({
            expired: game.simulationTimeMs >= before.until,
            newLife: game.ship.boostState.lifeId !== before.lifeId,
            shieldCleared: game.ship.boostState.shieldUntil === 0,
            retainedChoice: game.soloModifier?.modifierKind === 1,
        }), protectedLife)).toEqual({ expired: true, newLife: true, shieldCleared: true, retainedChoice: true });
        await soloArena(page);
        const rapid = await page.evaluate(() => PAYLOAD_KIND.RAPID_FIRE);
        const rapidCarrier = await breakSoloPayload(page, rapid);
        await collectSoloPickup(page, rapidCarrier.id);
        await page.evaluate(() => {
            game.bullets = [];
            game.ship.velocityX = 0;
            game.ship.velocityY = 0;
            game.ship.angle = 0;
            game.ship.resetControls();
        });
        const volleyLevel = (await localProgression(page)).level;
        const timings = await observedVolleys(page, 3);
        expect(timings.map(volley => volley.count)).toEqual(Array(3).fill(volleyLevel));
        const cadence = await page.evaluate(() => CONFIG.SHOOT_COOLDOWN * 0.75 * 1000 / CONFIG.TARGET_FPS);
        for (let index = 1; index < timings.length; index++) {
            const elapsed = timings[index].at - timings[index - 1].at;
            expect(elapsed).toBeGreaterThanOrEqual(cadence - 1);
            expect(elapsed).toBeLessThan(cadence + 1000 / 30);
        }
        await earnSoloLevel(page, 8);
        await expect(page.locator('#modifier-choice')).toBeVisible();
        await tabToChoice(page, 'modifier-sweep');
        const prior = await page.evaluate(() => game.bullets.map(bullet => bullet.damageId));
        await page.keyboard.press(layout.touch ? 'Space' : 'Enter');
        await expect(page.locator('#modifier-choice')).toBeHidden();
        await expect(page.locator('#modifier-current')).toContainText('SWEEP');
        await page.waitForTimeout(100);
        expect(await page.evaluate(ids => game.bullets.some(bullet => !ids.includes(bullet.damageId)), prior),
            'Native keyboard activation never leaks into a firing volley').toBe(false);
        expect(await page.evaluate(() => game.soloModifier))
            .toEqual({ consumedMilestone: 8, modifierKind: 2 });
        await expect(page.locator('#level-banner')).toBeHidden();
        expect(await page.locator('#level-banner').evaluate(element => {
            const style = getComputedStyle(element);
            return style.animationName === 'none' && Number.parseFloat(style.transitionDuration) === 0;
        })).toBe(true);
        await pauseSolo(page, layout.touch);
        const paused = await page.evaluate(() => ({
            time: game.simulationTimeMs, boosts: game.ship.boostState, choice: game.soloModifier,
        }));
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => ({
            time: game.simulationTimeMs, boosts: game.ship.boostState, choice: game.soloModifier,
        }))).toEqual(paused);
        await restartToSoloMenu(page, layout.touch);
        await startSolo(page, layout.touch);
        expect(await page.evaluate(() => ({
            xp: game.soloXp, modifier: game.soloModifier,
            shield: game.ship.boostState.shieldUntil, rapid: game.ship.boostState.rapidFireUntil,
        }))).toEqual({ xp: 0, modifier: null, shield: 0, rapid: 0 });
    });
}

test('world-fixed spray corridors and mine warnings remain readable with reduced motion', async ({ players }) => {
    const { page } = await players.open({ reducedMotion: 'reduce' });
    await startSolo(page, false);
    await soloArena(page);
    const drawing = await page.evaluate(() => {
        const paths = [];
        const observed = new Proxy(ctx, {
            get(target, key) {
                const value = target[key];
                if (typeof value !== 'function') return value;
                return (...args) => { paths.push([key, ...args]); return value.apply(target, args); };
            },
            set(target, key, value) { target[key] = value; return true; },
        });
        const asteroid = new Asteroid(0.6, 0.3, 0.06, 0, 0, 123);
        Object.assign(asteroid, { maxHits: 3, hitsRemaining: 3, payloadKind: PAYLOAD_KIND.SPRAY, angle: 0.9 });
        asteroid.draw(observed);
        const start = paths.findIndex(([name, pattern]) =>
            name === 'setLineDash' && pattern[0] === 3 && pattern[1] === 5);
        const preview = paths.slice(start + 1, paths.findIndex(([name], index) => index > start && name === 'restore'));
        const moves = preview.filter(([name]) => name === 'moveTo');
        const lines = preview.filter(([name]) => name === 'lineTo');
        return {
            reduced: reducedGameplayMotion,
            angles: lines.map((line, index) => Math.round((Math.atan2(line[2] - moves[index][2],
                line[1] - moves[index][1]) * 180 / Math.PI + 360) % 360)),
            textCalls: paths.filter(([name]) => name === 'fillText' || name === 'strokeText').length,
        };
    });
    expect(drawing).toEqual({
        reduced: true, angles: [45, 75, 105, 135, 225, 255, 285, 315], textCalls: 0,
    });
    const spray = await page.evaluate(() => PAYLOAD_KIND.SPRAY);
    const target = await breakSoloPayload(page, spray, 3);
    const warning = await page.evaluate(id => game.effects.find(effect => effect.data.sourceId === id)?.data, target.id);
    expect(warning.armedAt).toBe(warning.startedAt + 1200);
    await page.waitForFunction(id => !game.effects.some(effect => effect.data.sourceId === id
        && effect.data.kind === GAME_EFFECT_KIND.SPRAY)
        && game.effects.filter(effect => effect.data.kind === GAME_EFFECT_KIND.HOSTILE_BULLET).length === 8,
    target.id, { polling: 'raf' });
    const burst = await page.evaluate(() => ({
        now: game.simulationTimeMs,
        lanes: game.effects.filter(effect => effect.data.kind === GAME_EFFECT_KIND.HOSTILE_BULLET)
            .map(effect => ({ angle: effect.data.angle, start: effect.data.startedAt, end: effect.data.expiresAt })),
    }));
    expect(burst.now).toBeGreaterThanOrEqual(warning.armedAt);
    expect(burst.lanes).toHaveLength(8);
    for (const lane of burst.lanes) {
        expect(lane.start).toBe(warning.armedAt);
        expect(lane.end).toBe(warning.armedAt + 2000);
    }
    await expect.poll(() => page.evaluate(() => game.effects.filter(effect =>
        effect.data.kind === GAME_EFFECT_KIND.HOSTILE_BULLET).length)).toBe(0);
    const mine = await page.evaluate(() => PAYLOAD_KIND.MINE);
    const mineTarget = await breakSoloPayload(page, mine, 3);
    const mineBefore = await page.evaluate(id => {
        const effect = game.effects.find(effect => effect.data.sourceId === id);
        game.ship.x = effect.data.x;
        game.ship.y = effect.data.y;
        game.ship.velocityX = 0;
        game.ship.velocityY = 0;
        game.ship.invulnerable = 0;
        return { start: effect.data.startedAt, armed: effect.data.armedAt, end: effect.data.expiresAt,
            hits: game.ship.hitCount };
    }, mineTarget.id);
    expect(mineBefore.armed).toBe(mineBefore.start + 1500);
    expect(mineBefore.end).toBe(mineBefore.start + 8000);
    await page.waitForTimeout(100);
    expect((await localProgression(page)).hits).toBe(mineBefore.hits);
    await expect.poll(async () => (await localProgression(page)).hits).toBe(mineBefore.hits + 1);
    expect(await page.evaluate(armed => game.simulationTimeMs >= armed, mineBefore.armed)).toBe(true);
});

test('cooperative damage, same-identity choices and ship-local boosts survive real reconciliation and migration', async ({ players }) => {
    const host = await players.open();
    const helper = await players.open();
    const twin = await players.open({ identityOf: host });
    const spectator = await players.open();
    const sessionId = await createSession(host.page);
    players.ownSession(sessionId);
    for (const player of [helper, twin, spectator]) await joinSession(player.page, sessionId);
    for (const player of [host, helper, twin]) await enterSession(player.page);
    await sessionArena(host.page, [host.page, helper.page, twin.page]);
    const participant = await host.page.evaluate(() => SessionClient.getParticipantId());
    const helperId = await helper.page.evaluate(() => SessionClient.getParticipantId());
    expect(await twin.page.evaluate(() => SessionClient.getParticipantId())).toBe(participant);
    expect(await spectator.page.evaluate(() => game.ship)).toBeNull();
    const armored = await sessionTarget(host.page, helper.page, { hits: 3 });
    for (const [shooter, remaining] of [[helper, 2], [twin, 1], [host, null]]) {
        await fireOnce(shooter.page);
        await expect.poll(() => host.page.evaluate(id =>
            ObjectSync.getObject(id)?.data.hitsRemaining ?? null, armored)).toBe(remaining);
    }
    for (const player of [host, helper, twin, spectator]) {
        await expect.poll(async () => (await sessionXp(player.page, participant))?.xp).toBe(10);
        await expect.poll(async () => (await sessionXp(player.page, helperId))?.xp).toBe(5);
    }
    for (let breakNumber = 2; breakNumber <= 12; breakNumber++) {
        const target = await sessionTarget(helper.page, host.page);
        await fireOnce(host.page);
        await expect.poll(() => host.page.evaluate(id => !!ObjectSync.getObject(id), target)).toBe(false);
        await expect.poll(async () => (await sessionXp(host.page, participant))?.xp).toBe(breakNumber * 10);
    }
    await expect(twin.page.locator('#modifier-choice')).toBeVisible();
    await expect(host.page.locator('#modifier-choice')).toBeVisible();
    await Promise.all([host.page.keyboard.press('1'), twin.page.keyboard.press('2')]);
    await expect.poll(() => host.page.evaluate(() => {
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        return Object.keys(AstervoidsWireCodec.unpackParticipantModifiers(state.data.participantModifiers)).length;
    })).toBe(1);
    const accepted = await host.page.evaluate(id => AstervoidsWireCodec.unpackParticipantModifiers(
        ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantModifiers)[id], participant);
    expect(accepted.consumedMilestone).toBe(4);
    expect([1, 2]).toContain(accepted.modifierKind);
    for (const player of [host, twin]) {
        await expect.poll(() => player.page.evaluate(() => getLocalModifier())).toBe(accepted.modifierKind);
        await expect(player.page.locator('#modifier-choice')).toBeHidden();
    }
    await twin.page.evaluate(() => {
        game.ship.x = 0.1;
        game.ship.y = 0.8;
        ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
    });
    const shield = await host.page.evaluate(() => PAYLOAD_KIND.SHIELD);
    const carrier = await sessionTarget(helper.page, host.page, { hits: 2, payload: shield });
    for (let shot = 0; shot < 2 && await host.page.evaluate(id => !!ObjectSync.getObject(id), carrier); shot++) {
        await fireOnce(host.page);
        if (shot === 0) await expect.poll(() => host.page.evaluate(id =>
            ObjectSync.getObject(id)?.data.hitsRemaining ?? 0, carrier)).toBeLessThan(2);
    }
    await expect.poll(() => host.page.evaluate(id => getGameEffectObjects().some(record =>
        record.data.sourceId === id && record.data.kind === GAME_EFFECT_KIND.PICKUP), carrier)).toBe(true);
    await host.page.evaluate(id => {
        const effect = getGameEffectObjects().find(record =>
            record.data.sourceId === id && record.data.kind === GAME_EFFECT_KIND.PICKUP);
        game.ship.x = effect.data.x - sizeToNormalizedX(CONFIG.SHIP_SIZE * 2 + PROGRESSION.PICKUP_RADIUS);
        game.ship.y = effect.data.y;
        game.ship.angle = 0;
        game.ship.velocityX = 0;
        game.ship.velocityY = 0;
        game.ship.resetControls();
        ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
    }, carrier);
    await host.page.keyboard.down('ArrowUp');
    try {
        await expect.poll(() => host.page.evaluate(() =>
            game.ship.boostState.shieldUntil > getGameEffectNow())).toBe(true);
    } finally {
        await host.page.keyboard.up('ArrowUp');
    }
    await expect.poll(() => host.page.evaluate(() => ObjectSync.isDataConfirmed(
        game.ship.syncObjectId, game.ship.boostData())),
    { message: 'Collector boost deadline is durably accepted before recovery evidence is captured' }).toBe(true);
    const beforeRecovery = await host.page.evaluate(async () => {
        const record = ObjectSync.getObject(game.ship.syncObjectId);
        const snapshot = await SessionClient.getSessionState();
        const authoritative = snapshot.objects.find(object => object.id === record.id);
        return { id: record.id, version: authoritative.version,
            boost: AstervoidsWireCodec.unpackBoostState(authoritative.data.boostState) };
    });
    expect(beforeRecovery.boost.shieldUntil).toBeGreaterThan(0);
    await host.page.evaluate(() => ObjectSync.triggerReconciliation());
    expect(await host.page.evaluate(before => ({
        sameShip: game.ship.syncObjectId === before.id,
        sameLife: game.ship.boostState.lifeId === before.boost.lifeId,
        sameDeadline: game.ship.boostState.shieldUntil === before.boost.shieldUntil,
        accepted: ObjectSync.getObject(before.id).version >= before.version,
    }), beforeRecovery)).toEqual({ sameShip: true, sameLife: true, sameDeadline: true, accepted: true });
    expect(await twin.page.evaluate(() => game.ship.boostState.shieldUntil)).toBe(0);
    await expect.poll(async () => (await sessionXp(spectator.page, participant))?.xp).toBe(130);
    const beforeMigration = await host.page.evaluate(async () => {
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        const snapshot = await SessionClient.getSessionState();
        const accepted = snapshot.objects.find(object => object.id === state.id);
        return { id: accepted.id, version: accepted.version };
    });
    for (const player of [host, helper, twin]) await leaveGame(player.page);
    await expect.poll(() => spectator.page.evaluate(async before => {
        const member = SessionClient.getCurrentMember();
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        const snapshot = await SessionClient.getSessionState();
        const accepted = snapshot.objects.find(record => record.id === before.id);
        return snapshot.members.length === 1 && !game.ship && isGameStateOwner()
            && state?.id === before.id && state.version > before.version
            && accepted?.ownerMemberId === member.id && accepted.version > before.version;
    }, beforeMigration), { message: 'The sole pure spectator adopts the same version-advancing GameState' }).toBe(true);
    expect(await sessionXp(spectator.page, participant)).toMatchObject({ xp: 130 });
    await joinSession(host.page, sessionId);
    await enterSession(host.page);
    expect(await localProgression(host.page)).toMatchObject({ xp: 130, level: 4 });
    expect(await host.page.evaluate(() => getLocalModifier())).toBe(accepted.modifierKind);
    expect(await host.page.evaluate(before => ({
        newShip: game.ship.syncObjectId !== before.id,
        newLife: game.ship.boostState.lifeId !== before.boost.lifeId,
        shield: game.ship.boostState.shieldUntil,
    }), beforeRecovery)).toEqual({ newShip: true, newLife: true, shield: 0 });
});
