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
            ['sampleAt', 'f64'], ['sampleTick', 'u32'],
            ['respawnEpoch', 'u32'],
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
            ['sampleAt', 'f64'], ['sampleTick', 'u32'],
            ['bornAt', 'f64'],
            ['parentX', 'f64'], ['parentY', 'f64'], ['parentAngle', 'f64'],
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
            ['sampleAt', 'f64'], ['sampleTick', 'u32'],
            ['bornAt', 'f64'], ['shot', 'bytes'],
            ['hitClaimId', 'guid'], ['hitClaimAt', 'f64'],
            ['hitX', 'f64'], ['hitY', 'f64'], ['hitAngle', 'f64'],
            ['hitTargetVersion', 'u32'],
            ['hitTargetOwnerId', 'guid'],
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
        ]},
    ];

    // Keep the pre-lifecycle layouts on ordinary updates. Full creation schemas
    // still retain rare fields for snapshots; no codec/envelope change is needed.
    const UPDATE_SCHEMAS = [
        { id: 5, fields: SCHEMAS[0].fields.slice(0, 24) },
        { id: 6, fields: SCHEMAS[1].fields.slice(0, 14) },
        { id: 7, fields: SCHEMAS[2].fields.slice(0, 16) },
    ];
    SCHEMAS.push(...UPDATE_SCHEMAS);
    const UPDATE_SCHEMA_BY_TYPE = Object.freeze({ ship: 5, asteroid: 6, bullet: 7 });

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
    });

    function selectSchemaId(data, kind, context) {
        let type = data?.type;
        const schemas = context?.schemas || SCHEMAS;
        const fits = id => {
            const schema = schemas.find(value => value.id === id);
            return schema && Object.keys(data || {}).every(key =>
                schema.fields.some(field => field[0] === key));
        };
        if (kind === 'update') {
            type = context?.object?.data?.type || type;
            const compact = UPDATE_SCHEMA_BY_TYPE[type];
            if (fits(compact)) return compact;
        } else if (kind !== 'create' && kind !== 'replace') {
            return 0;
        }
        const full = SCHEMA_BY_OBJECT_TYPE[type];
        return fits(full) ? full : 0;
    }

    return Object.freeze({
        SCHEMAS,
        SCHEMA_BY_OBJECT_TYPE,
        selectSchemaId,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsWireSchemas;
}
