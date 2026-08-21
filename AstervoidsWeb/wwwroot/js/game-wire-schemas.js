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
        selectSchemaId,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsWireSchemas;
}
