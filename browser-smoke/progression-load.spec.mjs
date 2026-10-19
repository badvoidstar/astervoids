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

    const breaks = 5000;
    const result = await owner.page.evaluate(async breaks => {
        const participantId = game.ship.participantId;
        const memberId = SessionClient.getCurrentMember().id;
        let completed = 0, maxReceipts = 0, maxLedgerBytes = 0, maxModifierBytes = 0;
        let boostReceiptsConfirmed = 0, choicesRequested = 0;
        let stage = 'creating a retained-load asteroid';
        try {
            for (; completed < breaks; completed++) {
                stage = 'creating a retained-load asteroid';
                const asteroid = new Asteroid(
                    0.8, 0.2, CONFIG.MIN_ASTEROID_RADIUS / 2, 0, 0, 123);
                asteroid.rotationSpeed = 0;
                const collectBoost = completed > 0 && completed % 500 === 0;
                const hits = collectBoost || completed % 5 === 0 ? 3 : 1;
                asteroid.maxHits = hits;
                asteroid.hitsRemaining = hits;
                if (collectBoost) {
                    asteroid.payloadKind = completed % 1000 === 0
                        ? PAYLOAD_KIND.RAPID_FIRE : PAYLOAD_KIND.SHIELD;
                }
                const record = await ObjectSync.createObject(asteroid.toSyncData(), 'Session');
                asteroid.syncObjectId = record.id;
                stage = 'accepting attributed armor damage';
                for (let hit = 0; hit < hits; hit++) {
                    const accepted = await applyOwnedAsteroidDamage(asteroid, {
                        damageId: crypto.randomUUID(), participantId,
                        participantTag: game.ship.participantTag, shipId: game.ship.syncObjectId,
                    }, null, memberId);
                    if (!accepted) throw new Error('Damage was not accepted');
                }
                if (collectBoost) {
                    stage = 'acknowledging a real boost collection';
                    const payloadKind = asteroid.payloadKind;
                    const field = payloadKind === PAYLOAD_KIND.SHIELD ? 'shieldUntil' : 'rapidFireUntil';
                    const previous = game.ship.boostState[field];
                    game.ship.x = 0.8;
                    game.ship.y = 0.2;
                    game.ship.velocityX = 0;
                    game.ship.velocityY = 0;
                    ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
                    await ObjectSync.flushUpdates();
                    const deadline = performance.now() + 10_000;
                    let accepted = false;
                    while (performance.now() < deadline) {
                        updateGameEffects(0);
                        checkGameEffectContacts();
                        syncGameState();
                        await ObjectSync.flushUpdates();
                        if (game.ship.boostState[field] > previous
                            && ObjectSync.isDataConfirmed(game.ship.syncObjectId, game.ship.boostData())) {
                            accepted = true;
                            break;
                        }
                        await new Promise(resolve => setTimeout(resolve, 4));
                    }
                    if (!accepted) throw new Error('The real boost claim did not reach durable Ship acknowledgement');
                    boostReceiptsConfirmed++;
                    game.ship.x = 0.5;
                    game.ship.y = 0.8;
                    ObjectSync.updateObject(game.ship.syncObjectId, game.ship.toUpdateData(), true);
                }
                if (completed === 11 || completed % 250 === 0 || completed === breaks - 1) {
                    stage = 'requesting a milestone choice';
                    if (requestModifierChoice(choicesRequested % 2 === 0
                        ? MODIFIER_KIND.FOCUS : MODIFIER_KIND.SWEEP)) choicesRequested++;
                }
                // Exercise the real game-owned accounting, durable anchor/ACK and
                // response-first receipt retirement, not a seeded XP/receipt ledger.
                stage = 'settling GameState receipt accounting';
                updateGameEffects(0);
                syncGameState();
                await ObjectSync.flushUpdates();
                updateGameEffects(0);
                const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
                maxLedgerBytes = Math.max(maxLedgerBytes, state.data.processedEffects.length);
                maxModifierBytes = Math.max(maxModifierBytes, state.data.participantModifiers.length);
                maxReceipts = Math.max(maxReceipts,
                    ObjectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).length);
                if (game.connectionLost || !SessionClient.isInSession()) break;
            }
            return { completed, maxReceipts, maxLedgerBytes, maxModifierBytes,
                boostReceiptsConfirmed, choicesRequested, participantId, stage, failed: false };
        } catch {
            return { completed, maxReceipts, maxLedgerBytes, maxModifierBytes,
                boostReceiptsConfirmed, choicesRequested, participantId, stage, failed: true };
        }
    }, breaks);
    console.log('Progression load:', JSON.stringify({
        completed: result.completed, maxLedgerBytes: result.maxLedgerBytes,
        maxModifierBytes: result.maxModifierBytes, boostReceiptsConfirmed: result.boostReceiptsConfirmed,
        choicesRequested: result.choicesRequested,
        maxReceipts: result.maxReceipts, maxHubMessageBytes: owner.health.maxHubMessageBytes,
        maxUpdateMessageBytes: owner.health.maxUpdateMessageBytes,
    }));
    expect({ completed: result.completed, failed: result.failed, stage: result.stage },
        'Every durable break survives well beyond the old 32-KiB failure threshold')
        .toMatchObject({ completed: breaks, failed: false });
    expect(result.maxReceipts).toBeLessThan(32);
    expect(result.maxLedgerBytes, 'Retired receipt IDs are not permanent GameState history')
        .toBeLessThan(640);
    expect(result.boostReceiptsConfirmed).toBe(9);
    expect(result.choicesRequested).toBeGreaterThan(5);
    expect(result.maxModifierBytes, 'Repeated choices replace one identity entry, not append a choice history').toBe(21);
    await expect.poll(() => owner.page.evaluate(() => {
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        return {
            acknowledgements: AstervoidsWireCodec.unpackCounterMap(state.data.processedEffects),
            receipts: ObjectSync.getObjectsByType(OBJECT_TYPES.GAME_EFFECT).filter(record =>
                record.data.kind === GAME_EFFECT_KIND.BREAK_RECEIPT
                || record.data.kind === GAME_EFFECT_KIND.ACTIVATION_RECEIPT).length,
            modifiers: Object.keys(AstervoidsWireCodec.unpackParticipantModifiers(state.data.participantModifiers)).length,
        };
    }), { message: 'All receipt ACKs settle while the one accepted modifier entry remains bounded' })
        .toEqual({ acknowledgements: {}, receipts: 0, modifiers: 1 });
    const retainedModifier = await owner.page.evaluate(id =>
        AstervoidsWireCodec.unpackParticipantModifiers(
            ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantModifiers)[id],
    result.participantId);
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

    const level = await owner.page.evaluate(() => getLocalProgression().level);
    expect(level).toBeGreaterThan(32);
    const late = await players.open();
    await joinSession(late.page, sessionId);
    await enterSession(late.page);
    await expect.poll(() => late.page.evaluate(id =>
        AstervoidsWireCodec.unpackXpMap(
            ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantXp)[id],
    result.participantId)).toBe(breaks * 10);
    expect(await late.page.evaluate(id => AstervoidsWireCodec.unpackParticipantModifiers(
        ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantModifiers)[id],
    result.participantId)).toEqual(retainedModifier);
    // Server promotion does not select session-object owners when several members remain.
    // Complete late-join coverage before arranging one unambiguous migration recipient.
    await leaveGame(late.page);
    await expect.poll(() => peer.page.evaluate(() => SessionClient.getCurrentSession()?.members?.length),
        { message: 'The late joiner has left before the original owner migrates GameState' }).toBe(2);
    const beforeMigration = await owner.page.evaluate(async () => {
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        const snapshot = await SessionClient.getSessionState();
        const authoritative = snapshot.objects.find(record => record.id === state.id);
        return {
            id: authoritative.id, version: authoritative.version,
            members: snapshot.members.length,
            ownedByDepartingPlayer: authoritative.ownerMemberId === SessionClient.getCurrentMember()?.id,
        };
    });
    expect(beforeMigration.members).toBe(2);
    expect(beforeMigration.ownedByDepartingPlayer).toBe(true);
    await leaveGame(owner.page);
    await expect.poll(() => peer.page.evaluate(async ({ id, version }) => {
        const member = SessionClient.getCurrentMember();
        const state = ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE);
        const snapshot = await SessionClient.getSessionState();
        const authoritative = snapshot.objects.find(record => record.id === id);
        return {
            soleSurvivor: snapshot.members.length === 1 && snapshot.members[0].id === member?.id,
            promotedServer: member?.role === 'Server' && snapshot.members[0]?.role === 'Server',
            ownsSameGameState: isGameStateOwner() && state?.id === id && state.version > version,
            serverConfirmsMigration: authoritative?.ownerMemberId === member?.id
                && authoritative.version > version,
            sameEpoch: globalThis.loadEpoch === SessionClient.getSessionEpoch(),
        };
    }, beforeMigration), {
        message: 'The sole surviving player adopts the same compacted GameState through real ownership migration',
    }).toEqual({
        soleSurvivor: true, promotedServer: true, ownsSameGameState: true,
        serverConfirmsMigration: true, sameEpoch: true,
    });
    await expect.poll(() => peer.page.evaluate(id =>
        AstervoidsWireCodec.unpackXpMap(
            ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantXp)[id],
    result.participantId)).toBe(breaks * 10);
    expect(await peer.page.evaluate(id => AstervoidsWireCodec.unpackParticipantModifiers(
        ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantModifiers)[id],
    result.participantId)).toEqual(retainedModifier);
    await joinSession(owner.page, sessionId);
    await enterSession(owner.page);
    await expect.poll(() => owner.page.evaluate(id =>
        AstervoidsWireCodec.unpackXpMap(
            ObjectSync.getObjectByType(OBJECT_TYPES.GAME_STATE).data.participantXp)[id],
    result.participantId), { message: 'The earned participant XP also survives the real rejoin' })
        .toBe(breaks * 10);
    expect(await owner.page.evaluate(() => {
        game.ship.angle = 0;
        return getLocalProgression().level;
    })).toBe(level);
    expect(await owner.page.evaluate(() => getLocalModifier())).toBe(retainedModifier.modifierKind);
    expect(await owner.page.evaluate(() => ({
        shieldUntil: game.ship.boostState.shieldUntil, rapidFireUntil: game.ship.boostState.rapidFireUntil,
    }))).toEqual({ shieldUntil: 0, rapidFireUntil: 0 });
    // A live volley can legitimately break the sentinel and earn more XP.
    // Fire only after exact late-join, migration and rejoin progression checks.
    expect(await fireOnce(owner.page), 'High progression still fires a complete uncapped real volley')
        .toHaveLength(level);
    for (const player of [owner, peer, late]) {
        expect(player.health.maxHubMessageBytes, 'Includes SignalR MessagePack envelope and length prefix')
            .toBeLessThan(32 * 1024);
        expect(player.health.maxUpdateMessageBytes, 'UpdateObjects stays below the unchanged server boundary')
            .toBeLessThan(32 * 1024);
    }
    expect(owner.health.maxUpdateMessageBytes).toBeGreaterThan(0);
});
