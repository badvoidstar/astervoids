import { expect } from '@playwright/test';
import {
    test, createSession, joinSession, enterSession, leaveGame, fireOnce,
} from './progression-fixture.mjs';

const localLoadTest = Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL') ? test.skip : test;

localLoadTest('sustained real multiplayer breaks keep receipt state bounded and sessions joinable', async ({ players }) => {
    test.setTimeout(180_000);
    const owner = await players.open();
    const peer = await players.open();
    const sessionId = await createSession(owner.page);
    players.ownSession(sessionId);
    await joinSession(peer.page, sessionId);
    await enterSession(owner.page);
    await enterSession(peer.page);
    for (const { page } of [owner, peer]) {
        await page.evaluate(() => {
            game.ship.invulnerable = CONFIG.INVULNERABILITY_TIME * 100;
            game.ship.x = 0.5;
            game.ship.y = 0.8;
            ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
            globalThis.loadEpoch = SessionClient.getSessionEpoch();
        });
    }
    await owner.page.evaluate(async () => {
        const old = ObjectSync.getObjectsByType(OBJECT_TYPES.ASTEROID);
        const sentinel = new Asteroid(0.05, 0.05, CONFIG.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
        sentinel.rotationSpeed = 0;
        await ObjectSync.createObject(sentinel.toSyncData(), 'Session');
        await Promise.all(old.map(record => ObjectSync.deleteObject(record.id)));
    });

    const breaks = 3600;
    const result = await owner.page.evaluate(async breaks => {
        const participantId = game.ship.participantId;
        const memberId = SessionClient.getCurrentMember().id;
        let completed = 0, maxReceipts = 0, maxLedgerBytes = 0;
        try {
            for (; completed < breaks; completed++) {
                const asteroid = new Asteroid(
                    0.8, 0.2, CONFIG.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
                asteroid.rotationSpeed = 0;
                const hits = completed % 5 === 0 ? 3 : 1;
                asteroid.maxHits = hits;
                asteroid.hitsRemaining = hits;
                const record = await ObjectSync.createObject(asteroid.toSyncData(), 'Session');
                asteroid.syncObjectId = record.id;
                for (let hit = 0; hit < hits; hit++) {
                    const accepted = await applyOwnedAsteroidDamage(asteroid, {
                        damageId: crypto.randomUUID(), participantId,
                        participantTag: game.ship.participantTag, shipId: game.ship.syncObjectId,
                    }, null, memberId);
                    if (!accepted) throw new Error('Damage was not accepted');
                }
                // Exercise the real game-owned accounting, durable anchor/ACK and
                // response-first receipt retirement, not a seeded XP/receipt ledger.
                updateGameEffects(0);
                syncGameState();
                await ObjectSync.flushUpdates();
                updateGameEffects(0);
                const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
                maxLedgerBytes = Math.max(maxLedgerBytes, state.data.processedEffects.length);
                maxReceipts = Math.max(maxReceipts,
                    ObjectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length);
                if (game.connectionLost || !SessionClient.isInSession()) break;
            }
            return { completed, maxReceipts, maxLedgerBytes, participantId, failed: false };
        } catch {
            return { completed, maxReceipts, maxLedgerBytes, participantId, failed: true };
        }
    }, breaks);
    console.log('Progression load:', JSON.stringify({
        completed: result.completed, maxLedgerBytes: result.maxLedgerBytes,
        maxReceipts: result.maxReceipts, maxHubMessageBytes: owner.health.maxHubMessageBytes,
        maxUpdateMessageBytes: owner.health.maxUpdateMessageBytes,
    }));
    expect(result, 'Every durable break survives well beyond the old 32-KiB failure threshold')
        .toMatchObject({ completed: breaks, failed: false });
    expect(result.maxReceipts).toBeLessThan(32);
    expect(result.maxLedgerBytes, 'Retired receipt IDs are not permanent GameState history')
        .toBeLessThan(640);
    for (const { page } of [owner, peer]) {
        await expect.poll(() => page.evaluate(id => {
            const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
            return AstervoidsWireCodec.unpackXpMap(state.data.participantXp)[id];
        }, result.participantId)).toBe(breaks * 10);
        expect(await page.evaluate(() => ({
            sameEpoch: globalThis.loadEpoch === SessionClient.getSessionEpoch(),
            connected: SessionClient.isConnected(), lost: game.connectionLost,
        }))).toEqual({ sameEpoch: true, connected: true, lost: false });
    }

    const level = await owner.page.evaluate(() => {
        game.ship.angle = 0;
        return getLocalProgression().level;
    });
    expect(level).toBeGreaterThan(32);
    expect(await fireOnce(owner.page), 'High progression still fires a complete uncapped real volley')
        .toHaveLength(level);
    const late = await players.open();
    await joinSession(late.page, sessionId);
    await enterSession(late.page);
    await expect.poll(() => late.page.evaluate(id =>
        AstervoidsWireCodec.unpackXpMap(
            ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantXp)[id],
    result.participantId)).toBe(breaks * 10);
    await leaveGame(owner.page);
    await expect.poll(() => peer.page.evaluate(() => isGameStateOwner()),
        { message: 'The surviving player adopts compacted GameState without losing progression' }).toBe(true);
    await expect.poll(() => peer.page.evaluate(id =>
        AstervoidsWireCodec.unpackXpMap(
            ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantXp)[id],
    result.participantId)).toBe(breaks * 10);
    expect(owner.health.maxHubMessageBytes, 'Includes SignalR MessagePack envelope and length prefix')
        .toBeLessThan(32 * 1024);
    expect(owner.health.maxUpdateMessageBytes, 'UpdateObjects stays below the unchanged server boundary')
        .toBeLessThan(32 * 1024);
    expect(owner.health.maxUpdateMessageBytes).toBeGreaterThan(0);
});
