/**
 * Shared gameplay configuration primitives.
 *
 * SHARED_DEFAULTS contains values consumed outside the inline game runtime.
 * Keep runtime-only settings beside their owning systems in index.html.
 */
const AstervoidsConfig = (function() {
    const SHARED_DEFAULTS = Object.freeze({
        TARGET_FPS: 60,
        SHIP_KEYBOARD_TURN_SPEED: 0.125,
        SHIP_ANALOG_TURN_SPEED: 0.3,
        SHIP_MAX_SPEED: 1.0,
        ANALOG_RECTILINEAR_TURN_DEADZONE_PX: 16,
        ANALOG_RECTILINEAR_THRUST_DEADZONE_PX: 16,
        ANALOG_POLAR_DEADZONE_PX: 16,
        ANALOG_POLAR_THRESHOLD_PX: 64,
        ANALOG_RECTILINEAR_TURN_GAIN: 0.5,
        ANALOG_POLAR_TURN_GAIN: 2.0,
        ANALOG_THRUST_GAIN: 2.0,
        ANALOG_THRUST_MAX: 1.5,
        ANALOG_BRAKE_GAIN: 1.0,
        EXTRA_LIFE_SCORE_THRESHOLD: 10000,
        ASTEROID_MAX_SPEED: 0.4,
        ASTEROID_MAX_SPIN: Math.PI / 6,
        MIN_ASTEROID_RADIUS: 0.025,
        INITIAL_ASTEROID_RADIUS: 0.083,
        // Aspect-ratio compensation.  ASPECT_COMPENSATION is the capped aspect
        // factor (max(w,h)/min(w,h), capped at ASPECT_MAX_COMPENSATED) frozen at
        // session/game creation time.  It is included in SESSION_CONFIG_KEYS so
        // every multiplayer peer uses the same value regardless of viewport.
        // Default 1.0 means no compensation (square viewport equivalent).
        ASPECT_COMPENSATION: 1.0,
        ASPECT_SIZE_WEIGHT: 0.45,
        ASPECT_MAX_COMPENSATED: 2.25,
        MIN_SPLIT_RATIO: 0.1,
        DEFLECTION_KICK: 2.00e-3,
        ASTEROID_DENSITY: 5.0,
        SEPARATION_ENERGY_SIZE_BLEND: 1.0,
        SEPARATION_ENERGY: 2.00e-4,
        SEPARATION_ANGLE_VARIANCE: Math.PI / 8,
        MASS_SPLIT_BIAS: 0.6,
        FRACTURE_ENABLED: true,
        FRACTURE_VERTEX_DENSITY: 1.0,
        FRACTURE_JAGGEDNESS: 0.35,
        DEFLECTION_TIME_LIMIT: 0.5,
        DEFLECTION_SCALE: 1.2,
        MAX_EXTRAPOLATION: 2.0,
    });

    const SESSION_CONFIG_KEYS = Object.freeze([
        'FRACTURE_ENABLED',
        'ASTEROID_VERTICES',
        'ASTEROID_JAGGEDNESS',
        'SIM_MODE',
        'EXTRA_LIFE_SCORE_THRESHOLD',
        'ASPECT_COMPENSATION',
    ]);

    function control(definition) {
        const runtimeDefault = SHARED_DEFAULTS[definition.key];
        const defaultValue = typeof runtimeDefault === 'boolean'
            ? Number(runtimeDefault)
            : runtimeDefault;
        return Object.freeze({ ...definition, default: defaultValue });
    }

    const CONFIG_CONTROLS = Object.freeze([
        control({
            key: 'ASTEROID_DENSITY',
            label: 'Asteroid density',
            min: 0.1, max: 20, step: 0.1,
            fmt: value => value.toFixed(1),
            help: 'M = density * R² for disk/fallback asteroids; for polygon asteroids M = density * area / (area/R²) = density * R² (calibrated so a circle matches exactly). Density damps separation by 1/sqrt(density); deflection and spin remain velocity-driven.',
        }),
        control({
            key: 'EXTRA_LIFE_SCORE_THRESHOLD',
            label: 'Extra-life score threshold',
            min: 0, max: 100000, step: 100,
            fmt: value => `${Math.floor(value)} points`,
            help: 'Awards one life for every score multiple. Set to 0 to disable score-based extra lives.',
        }),
        control({
            key: 'ASTEROID_MAX_SPEED',
            label: 'Asteroid max linear speed (ref-dim/s)',
            min: 0, max: 2, step: 0.025,
            fmt: value => `${value.toFixed(3)} ref-dim/s`,
            help: 'Reference-dimension-per-second cap enforced on locally-owned asteroids each update. 0 disables the cap.',
        }),
        control({
            key: 'ASTEROID_MAX_SPIN',
            label: 'Asteroid max spin (rad/60 Hz tick)',
            min: 0, max: 1, step: 0.005,
            fmt: value => `${value.toFixed(3)} (${(value * 60 / (2 * Math.PI)).toFixed(2)} rot/s)`,
            help: 'Per-nominal-60 Hz-tick cap on locally-owned asteroid rotation speed. 0 disables the cap.',
        }),
        control({
            key: 'DEFLECTION_KICK',
            label: 'Deflection kick (COM delta-v, ref-dim/s)',
            min: 0, max: 5e-3, step: 1e-5,
            fmt: value => `${value.toExponential(2)} ref-dim/s`,
            help: 'Head-on parent center-of-mass velocity change per bullet hit.',
        }),
        control({
            key: 'SEPARATION_ENERGY',
            label: 'Fragment separation energy (ref-dim^2/s^2)',
            min: 0, max: 1e-3, step: 1e-6,
            fmt: value => `${value.toExponential(2)} ref-dim^2/s^2`,
            help: 'Energy released into fragment separation per hit.',
        }),
        control({
            key: 'SEPARATION_ENERGY_SIZE_BLEND',
            label: 'Separation energy size blend',
            min: 0, max: 1, step: 0.01,
            fmt: value => value.toFixed(2),
            help: '0 uses fixed energy per hit; 1 scales energy by parent radius squared.',
        }),
        control({
            key: 'SEPARATION_ANGLE_VARIANCE',
            label: 'Separation angle variance (rad)',
            min: 0, max: Math.PI, step: Math.PI / 180,
            fmt: value => `${value.toFixed(3)} rad`,
            help: 'Maximum deterministic random rotation applied to separation momentum in either direction. 0 follows the cut normal exactly.',
        }),
        control({
            key: 'MASS_SPLIT_BIAS',
            label: 'Legacy disk-split mass bias',
            min: 0, max: 1, step: 0.01,
            fmt: value => value.toFixed(2),
            help: 'Only used when polygon fracture is disabled or falls back to the legacy disk split. 0 always splits evenly; 1 applies full impact-offset asymmetry.',
        }),
        control({
            key: 'FRACTURE_ENABLED',
            label: 'Polygon fracture enabled (0/1)',
            min: 0, max: 1, step: 1,
            fmt: value => `${Math.round(value)}`,
            help: '0 uses the legacy disk split path; 1 uses polygon fracture, with invalid clips falling back to the disk split.',
        }),
        control({
            key: 'FRACTURE_VERTEX_DENSITY',
            label: 'Fracture vertex density',
            min: 0, max: 3, step: 0.05,
            fmt: value => value.toFixed(2),
            help: 'Multiplier for points along the fracture chord.',
        }),
        control({
            key: 'FRACTURE_JAGGEDNESS',
            label: 'Fracture jaggedness',
            min: 0, max: 1, step: 0.01,
            fmt: value => value.toFixed(2),
            help: 'Maximum fracture-point displacement as a fraction of parent radius.',
        }),
        control({
            key: 'DEFLECTION_TIME_LIMIT',
            label: 'Shooter-deflection time limit (s)',
            min: 0.05, max: 5, step: 0.05,
            fmt: value => `${value.toFixed(2)} s`,
            help: 'Time horizon used to cap the fragment impulse needed to miss the shooter.',
        }),
        control({
            key: 'DEFLECTION_SCALE',
            label: 'Shooter-deflection scale',
            min: 0, max: 3, step: 0.05,
            fmt: value => value.toFixed(2),
            help: '0 disables shooter avoidance; 1 targets a grazing miss; larger values add margin.',
        }),
        control({
            key: 'MAX_EXTRAPOLATION',
            label: 'Max extrapolation (s)',
            min: 0, max: 5, step: 0.1,
            fmt: value => `${value.toFixed(1)} s`,
            help: 'Caps buffered remote projection and local replacement-spawn projection.',
        }),
        control({
            key: 'SHIP_KEYBOARD_TURN_SPEED',
            label: 'Ship keyboard turn max speed (rad/60 Hz tick)',
            min: 0, max: 0.6, step: 0.005,
            fmt: value => `${value.toFixed(3)} (${(value * 60 * 180 / Math.PI).toFixed(0)} deg/s)`,
            help: 'Per-nominal-60 Hz-tick cap on keyboard-driven ship angular speed.',
        }),
        control({
            key: 'SHIP_ANALOG_TURN_SPEED',
            label: 'Ship analog turn max speed (rad/60 Hz tick)',
            min: 0, max: 0.6, step: 0.005,
            fmt: value => `${value.toFixed(3)} (${(value * 60 * 180 / Math.PI).toFixed(0)} deg/s)`,
            help: 'Per-nominal-60 Hz-tick cap on touch- and mouse-anchor ship angular speed.',
        }),
        control({
            key: 'ANALOG_RECTILINEAR_TURN_GAIN',
            label: 'Analog rectilinear turn-input gain',
            min: 0, max: 5, step: 0.1,
            fmt: value => `${value.toFixed(2)}x`,
            help: 'Multiplies post-dead-zone lateral displacement normalized by stick radius.',
        }),
        control({
            key: 'ANALOG_POLAR_TURN_GAIN',
            label: 'Analog polar turn-input gain',
            min: 0, max: 5, step: 0.1,
            fmt: value => `${value.toFixed(2)}x`,
            help: 'Multiplies the normalized radial turn band.',
        }),
        control({
            key: 'SHIP_MAX_SPEED',
            label: 'Ship max linear speed (ref-dim/s)',
            min: 0, max: 6, step: 0.025,
            fmt: value => `${value.toFixed(3)} ref-dim/s`,
            help: 'Reference-dimension-per-second cap on ship velocity. 0 disables the cap.',
        }),
        control({
            key: 'ANALOG_THRUST_GAIN',
            label: 'Analog thrust-input gain',
            min: 0, max: 5, step: 0.1,
            fmt: value => `${value.toFixed(2)}x`,
            help: 'Multiplies post-dead-zone rectilinear or post-threshold polar displacement normalized by stick radius.',
        }),
        control({
            key: 'ANALOG_THRUST_MAX',
            label: 'Analog thrust input maximum',
            min: 0, max: 5, step: 0.1,
            fmt: value => value.toFixed(2),
            help: 'Caps touch and mouse anchor thrust input; 1.00 matches standard full thrust.',
        }),
        control({
            key: 'ANALOG_BRAKE_GAIN',
            label: 'Brake-input gain (analog + keyboard)',
            min: 0, max: 5, step: 0.1,
            fmt: value => `${value.toFixed(2)}x`,
            help: 'Multiplies normalized analog brake displacement and sets the keyboard brake input.',
        }),
        control({
            key: 'ANALOG_RECTILINEAR_TURN_DEADZONE_PX',
            label: 'Analog rectilinear turn dead-zone (CSS px @ 390px gameplay ref)',
            min: 0, max: 60, step: 1,
            fmt: value => `${Math.round(value)} px @ 390`,
            help: 'Horizontal turn dead-zone half-extent at a 390px gameplay-reference short edge; scales with the gameplay viewport.',
        }),
        control({
            key: 'ANALOG_RECTILINEAR_THRUST_DEADZONE_PX',
            label: 'Analog rectilinear thrust/brake dead-zone (CSS px @ 390px gameplay ref)',
            min: 0, max: 60, step: 1,
            fmt: value => `${Math.round(value)} px @ 390`,
            help: 'Vertical thrust/brake dead-zone half-extent at a 390px gameplay-reference short edge; scales with the gameplay viewport.',
        }),
        control({
            key: 'ANALOG_POLAR_DEADZONE_PX',
            label: 'Analog polar turn/thrust dead-zone (CSS px @ 390px gameplay ref)',
            min: 0, max: 80, step: 1,
            fmt: value => `${Math.round(value)} px @ 390`,
            help: 'Radius below which polar turn and thrust are zero; polar brake remains active. Calibrated at a 390px gameplay-reference short edge.',
        }),
        control({
            key: 'ANALOG_POLAR_THRESHOLD_PX',
            label: 'Analog polar turn/thrust threshold (CSS px @ 390px gameplay ref)',
            min: 4, max: 200, step: 1,
            fmt: value => `${Math.round(value)} px @ 390`,
            help: 'Radius where polar thrust begins and polar brake reaches zero; it ends the radial turn ramp. Calibrated at a 390px gameplay-reference short edge.',
        }),
    ]);

    const DEBUG_OVERRIDABLE_KEYS = Object.freeze(
        CONFIG_CONTROLS.map(definition => definition.key));

    function parseBooleanLike(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') {
            if (value === 1) return true;
            if (value === 0) return false;
            return undefined;
        }
        if (typeof value !== 'string') return undefined;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
        if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
        return undefined;
    }

    function coerceConfigOverrideValue(rawValue, currentValue) {
        if (typeof currentValue === 'boolean') {
            return parseBooleanLike(rawValue);
        }
        if (typeof currentValue === 'number') {
            const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue);
            return Number.isFinite(numeric) ? numeric : undefined;
        }
        if (typeof currentValue === 'string') {
            if (typeof rawValue === 'string') {
                return rawValue.length > 0 ? rawValue : undefined;
            }
            if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
                return String(rawValue);
            }
            if (typeof rawValue === 'boolean') {
                return rawValue ? 'true' : 'false';
            }
            return undefined;
        }
        const booleanLike = parseBooleanLike(rawValue);
        if (booleanLike !== undefined) return booleanLike;
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
        return undefined;
    }

    function applyConfigOverride(config, key, rawValue) {
        if (!Object.prototype.hasOwnProperty.call(config, key)) return false;
        const value = coerceConfigOverrideValue(rawValue, config[key]);
        if (value === undefined) return false;
        config[key] = value;
        return true;
    }

    function applyUrlConfigOverrides(config, search = '') {
        const params = new URLSearchParams(search);
        for (const [paramKey, rawValue] of params.entries()) {
            if (!paramKey.startsWith('cfg.')) continue;
            applyConfigOverride(config, paramKey.slice(4), rawValue);
        }
    }

    function countExtraLivesForScore(score, threshold) {
        const normalizedThreshold = Math.floor(Number(threshold));
        if (!Number.isFinite(normalizedThreshold) || normalizedThreshold <= 0) return 0;

        const normalizedScore = Math.floor(Number(score));
        if (!Number.isFinite(normalizedScore) || normalizedScore <= 0) return 0;
        return Math.floor(normalizedScore / normalizedThreshold);
    }

    function snapshotConfigValues(config, keys) {
        const out = {};
        for (const key of keys) out[key] = config[key];
        return out;
    }

    function buildSessionConfigMetadata(config, keys = SESSION_CONFIG_KEYS) {
        return snapshotConfigValues(config, keys);
    }

    function applySessionConfigMetadata(metadata, config, keys = SESSION_CONFIG_KEYS) {
        if (!metadata || typeof metadata !== 'object') return;
        const overrides = metadata.config;
        if (!overrides || typeof overrides !== 'object') return;
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                applyConfigOverride(config, key, overrides[key]);
            }
        }
    }

    return Object.freeze({
        SHARED_DEFAULTS,
        CONFIG_CONTROLS,
        DEBUG_OVERRIDABLE_KEYS,
        SESSION_CONFIG_KEYS,
        parseBooleanLike,
        coerceConfigOverrideValue,
        applyConfigOverride,
        applyUrlConfigOverrides,
        countExtraLivesForScore,
        snapshotConfigValues,
        buildSessionConfigMetadata,
        applySessionConfigMetadata,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsConfig;
}
