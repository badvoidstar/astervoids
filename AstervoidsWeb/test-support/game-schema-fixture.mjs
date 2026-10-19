export const SHIP_SCHEMA_FIELDS = [
    ['type', 'str'],
    ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
    ['velocityX', 'f32'], ['velocityY', 'f32'], ['rotationSpeed', 'q16s'],
    ['thrusting', 'bool'], ['invulnerable', 'u16'],
    ['colorIndex', 'u8'], ['memberId', 'guid'],
    ['score', 'u32'], ['hitCount', 'u16'],
    ['thrustInput', 'f32'], ['brakeInput', 'q8'],
    ['turnControlMode', 'u8'], ['turnTarget', 'q16s'],
    ['turnTargetAngle', 'q16_2pi'], ['turnMagnitude', 'q8'], ['turnBias', 'q16s'],
    ['terminalEpoch', 'f64'], ['terminalX', 'f64'],
    ['terminalY', 'f64'], ['terminalAngle', 'f64'],
    ['invulnerabilityRevision', 'u32'], ['invulnerableAt', 'f64'],
    ['participantId', 'guid'], ['participantTag', 'str'],
    ['handledHazards', 'bytes'],
    ['boostState', 'bytes'],
    ['modifierRequestMilestone', 'u32'], ['modifierRequestKind', 'u8'],
];

export const ASTEROID_SCHEMA_FIELDS = [
    ['type', 'str'],
    ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'], ['radius', 'q16'],
    ['velocityX', 'f32'], ['velocityY', 'f32'], ['rotationSpeed', 'f32'],
    ['seed', 'f64'], ['vertices', 'bytes'],
    ['terminalEpoch', 'f64'], ['terminalX', 'f64'],
    ['terminalY', 'f64'], ['terminalAngle', 'f64'],
    ['maxHits', 'u8'], ['hitsRemaining', 'u8'],
    ['payloadKind', 'u8'], ['processedDamage', 'bytes'],
    ['contributors', 'bytes'],
];

export const BULLET_SCHEMA_FIELDS = [
    ['type', 'str'],
    ['x', 'q16w'], ['y', 'q16w'],
    ['velocityX', 'q16s'], ['velocityY', 'q16s'],
    ['lifetime', 'u16'], ['colorIndex', 'u8'], ['ownerMemberId', 'guid'],
    ['pendingHit', 'bool'], ['hitTargetId', 'nullable-guid'],
    ['hitImpactTorque', 'q16s'], ['hitBulletAngle', 'q16_2pi'],
    ['hitOffsetN', 'q16s'], ['terminalEpoch', 'f64'],
    ['terminalX', 'f64'], ['terminalY', 'f64'],
    ['damageId', 'guid'], ['participantId', 'guid'],
    ['shipId', 'nullable-guid'], ['participantTag', 'str'],
    ['velocityXFull', 'f32'], ['velocityYFull', 'f32'],
];

export const GAME_STATE_SCHEMA_FIELDS = [
    ['type', 'str'], ['gameStarted', 'bool'], ['wave', 'u16'], ['state', 'str'],
    ['lives', 'u16'], ['groupScore', 'u32'], ['speedMultiplier', 'f32'],
    ['waveDelayTimer', 'f32'], ['processedHits', 'bytes'], ['processedScores', 'bytes'],
    ['peakShipCount', 'u8'], ['gameOverAt', 'f64'], ['terminalAt', 'f64'],
    ['scoreLifeAwardCount', 'u32'], ['countedParticipants', 'bytes'],
    ['terminalShipId', 'guid'], ['participantScores', 'bytes'], ['participantNumbers', 'bytes'],
    ['participantTags', 'bytes'], ['participantXp', 'bytes'], ['processedEffects', 'bytes'],
    ['participantModifiers', 'bytes'],
];

export const GAME_EFFECT_SCHEMA_FIELDS = [
    ['type', 'str'], ['kind', 'u8'], ['payloadKind', 'u8'], ['sourceId', 'guid'],
    ['claimId', 'nullable-guid'], ['participantId', 'nullable-guid'], ['participantTag', 'str'],
    ['shipId', 'nullable-guid'], ['x', 'q16w'], ['y', 'q16w'],
    ['velocityX', 'f32'], ['velocityY', 'f32'], ['angle', 'q16_2pi'],
    ['startedAt', 'f64'], ['armedAt', 'f64'], ['expiresAt', 'f64'], ['points', 'u32'],
    ['damageReceipts', 'bytes'], ['asteroidTargets', 'bytes'], ['hazardTargets', 'bytes'],
    ['contributors', 'bytes'], ['shipLifeId', 'nullable-guid'],
];

export const GAME_CLAIM_SCHEMA_FIELDS = [
    ['type', 'str'], ['targetId', 'guid'], ['shipId', 'guid'], ['participantId', 'guid'],
    ['participantTag', 'str'], ['x', 'q16w'], ['y', 'q16w'], ['angle', 'q16_2pi'],
    ['claimedAt', 'f64'], ['invulnerabilityRevision', 'u32'],
    ['shipLifeId', 'guid'],
];

export const CURRENT_GAME_SCHEMAS = [
    SHIP_SCHEMA_FIELDS, ASTEROID_SCHEMA_FIELDS, BULLET_SCHEMA_FIELDS,
    GAME_STATE_SCHEMA_FIELDS, GAME_EFFECT_SCHEMA_FIELDS, GAME_CLAIM_SCHEMA_FIELDS,
].map((fields, index) => ({ id: index + 1, fields }));

// Each XP entry is a GUID followed by an exact safe-integer f64, not uint32.
export const LARGE_XP_ENTRY_HEX =
    '33221100554477668899aabbccddeeff' + '000010000000f041';
export const LARGE_XP_STATE_HEX = '00000818000000' + LARGE_XP_ENTRY_HEX;

export const BOOST_STATE_HEX = '33221100554477668899aabbccddeeff'
    + '0000000000408f40' + '000000000070a740';
export const MODIFIER_ENTRY_HEX = '33221100554477668899aabbccddeeff' + '08000000' + '02';
export const CONTRIBUTOR_ENTRY_HEX = '33221100554477668899aabbccddeeff' + '01000000';
