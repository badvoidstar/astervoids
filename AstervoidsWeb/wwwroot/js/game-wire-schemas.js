/**
 * Astervoids positional wire schemas and outbound schema selection.
 */
const AstervoidsWireSchemas = (function() {
    const SCHEMAS = [
        { id: 1, fields: [
            ['type', 'str'],
            ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
            ['velocityX', 'f32'], ['velocityY', 'f32'],
            ['rotationSpeed', 'q16s'],
            ['thrusting', 'bool'], ['invulnerable', 'u16'],
            ['colorIndex', 'u8'],
            ['memberId', 'guid'],
            ['score', 'u32'], ['hitCount', 'u16'],
            ['thrustInput', 'f32'], ['brakeInput', 'q8'],
            ['turnControlMode', 'u8'], ['turnTarget', 'q16s'],
            ['turnTargetAngle', 'q16_2pi'], ['turnMagnitude', 'q8'],
            ['turnBias', 'q16s'],
            ['terminalEpoch', 'f64'],
            ['terminalX', 'f64'], ['terminalY', 'f64'],
            ['terminalAngle', 'f64'],
            ['invulnerabilityRevision', 'u32'], ['invulnerableAt', 'f64'],
            ['participantId', 'guid'],
            ['participantTag', 'str'],
            ['handledHazards', 'bytes'],
            ['boostState', 'bytes'],
            ['modifierRequestMilestone', 'u32'], ['modifierRequestKind', 'u8'],
        ]},
        { id: 2, fields: [
            ['type', 'str'],
            ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
            ['radius', 'q16'],
            ['velocityX', 'f32'], ['velocityY', 'f32'],
            ['rotationSpeed', 'f32'],
            ['seed', 'f64'],
            ['vertices', 'bytes'],
            ['terminalEpoch', 'f64'],
            ['terminalX', 'f64'], ['terminalY', 'f64'],
            ['terminalAngle', 'f64'],
            ['maxHits', 'u8'], ['hitsRemaining', 'u8'], ['payloadKind', 'u8'],
            ['processedDamage', 'bytes'],
            ['contributors', 'bytes'],
        ]},
        { id: 3, fields: [
            ['type', 'str'],
            ['x', 'q16w'], ['y', 'q16w'],
            ['velocityX', 'q16s'], ['velocityY', 'q16s'],
            ['lifetime', 'u16'],
            ['colorIndex', 'u8'],
            ['ownerMemberId', 'guid'],
            ['pendingHit', 'bool'],
            ['hitTargetId', 'nullable-guid'],
            ['hitImpactTorque', 'q16s'],
            ['hitBulletAngle', 'q16_2pi'],
            ['hitOffsetN', 'q16s'],
            ['terminalEpoch', 'f64'],
            ['terminalX', 'f64'], ['terminalY', 'f64'],
            ['damageId', 'guid'], ['participantId', 'guid'],
            ['shipId', 'nullable-guid'], ['participantTag', 'str'],
            ['velocityXFull', 'f32'], ['velocityYFull', 'f32'],
        ]},
        { id: 4, fields: [
            ['type', 'str'],
            ['gameStarted', 'bool'],
            ['wave', 'u16'],
            ['state', 'str'],
            ['lives', 'u16'],
            ['groupScore', 'u32'],
            ['speedMultiplier', 'f32'],
            ['waveDelayTimer', 'f32'],
            ['processedHits', 'bytes'],
            ['processedScores', 'bytes'],
            ['peakShipCount', 'u8'],
            ['gameOverAt', 'f64'],
            ['terminalAt', 'f64'],
            ['scoreLifeAwardCount', 'u32'],
            ['countedParticipants', 'bytes'],
            ['terminalShipId', 'guid'],
            ['participantScores', 'bytes'],
            ['participantNumbers', 'bytes'],
            ['participantTags', 'bytes'],
            ['participantXp', 'bytes'], ['processedEffects', 'bytes'],
            ['participantModifiers', 'bytes'],
        ]},
        { id: 5, fields: [
            ['type', 'str'], ['kind', 'u8'], ['payloadKind', 'u8'],
            ['sourceId', 'guid'], ['claimId', 'nullable-guid'],
            ['participantId', 'nullable-guid'], ['participantTag', 'str'],
            ['shipId', 'nullable-guid'],
            ['x', 'q16w'], ['y', 'q16w'],
            ['velocityX', 'f32'], ['velocityY', 'f32'], ['angle', 'q16_2pi'],
            ['startedAt', 'f64'], ['armedAt', 'f64'], ['expiresAt', 'f64'],
            ['points', 'u32'], ['damageReceipts', 'bytes'],
            ['asteroidTargets', 'bytes'], ['hazardTargets', 'bytes'],
            ['contributors', 'bytes'], ['shipLifeId', 'nullable-guid'],
        ]},
        { id: 6, fields: [
            ['type', 'str'], ['targetId', 'guid'], ['shipId', 'guid'],
            ['participantId', 'guid'], ['participantTag', 'str'],
            ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
            ['claimedAt', 'f64'], ['invulnerabilityRevision', 'u32'],
            ['shipLifeId', 'guid'],
        ]},
    ];

    for (const schema of SCHEMAS) {
        for (const field of schema.fields) Object.freeze(field);
        Object.freeze(schema.fields);
        Object.freeze(schema);
    }
    Object.freeze(SCHEMAS);

    const SCHEMA_BY_OBJECT_TYPE = Object.freeze({
        ship: 1,
        asteroid: 2,
        bullet: 3,
        gameState: 4,
        gameEffect: 5,
        gameClaim: 6,
    });

    function requireCurrentSchemas(metadata) {
        const definitions = metadata?.schemas;
        if (!Array.isArray(definitions)
            || new Set(definitions.map(schema => schema?.id)).size !== definitions.length
            || SCHEMAS.some(expected => {
                const fields = definitions.find(schema => schema?.id === expected.id)?.fields;
                return !Array.isArray(fields) || fields.length !== expected.fields.length
                    || expected.fields.some(([name, type], index) =>
                        !Array.isArray(fields[index]) || fields[index].length !== 2
                        || fields[index][0] !== name || fields[index][1] !== type);
            })) {
            throw new Error('Unsupported Astervoids session schemas. Create a new session with the current game.');
        }
    }

    function selectSchemaId(data, kind, context) {
        let type = data?.type;
        if (kind === 'update') {
            type = context?.object?.data?.type || type;
        } else if (kind !== 'create' && kind !== 'replace') {
            return 0;
        }
        return SCHEMA_BY_OBJECT_TYPE[type] || 0;
    }

    return Object.freeze({
        SCHEMAS,
        SCHEMA_BY_OBJECT_TYPE,
        requireCurrentSchemas,
        selectSchemaId,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsWireSchemas;
}
