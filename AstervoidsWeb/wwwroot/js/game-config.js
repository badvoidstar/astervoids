/**
 * Shared gameplay configuration primitives.
 *
 * SHARED_DEFAULTS contains values consumed outside the inline game runtime.
 * Keep runtime-only settings beside their owning systems in index.html.
 */
const AstervoidsConfig = (function() {
    const SHARED_DEFAULTS = Object.freeze({
        TARGET_FPS: 60,
        SHIP_TURN_SPEED: 0.2,
        SHIP_MAX_SPEED: 1.0,
        TOUCH_STICK_TURN_DEADZONE_PX: 6,
        TOUCH_STICK_THRUST_DEADZONE_PX: 24,
        TOUCH_POLAR_DEADZONE_PX: 16,
        TOUCH_POLAR_THRESHOLD_PX: 64,
        TOUCH_TURN_GAIN: 2.0,
        TOUCH_THRUST_GAIN: 2.0,
        TOUCH_THRUST_MAX: 1.5,
        TOUCH_BRAKE_GAIN: 1.0,
        ASTEROID_MAX_SPEED: 0.4,
        ASTEROID_MAX_SPIN: Math.PI / 6,
        MIN_ASTEROID_RADIUS: 0.025,
        INITIAL_ASTEROID_RADIUS: 0.083,
        MIN_SPLIT_RATIO: 0.1,
        DEFLECTION_KICK: 2.00e-3,
        ASTEROID_DENSITY: 5.0,
        SEPARATION_ENERGY_SIZE_BLEND: 1.0,
        SEPARATION_ENERGY: 2.00e-4,
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
            help: 'M = density * R^2. Density damps separation by 1/sqrt(density); deflection and spin remain velocity-driven.',
        }),
        control({
            key: 'ASTEROID_MAX_SPEED',
            label: 'Asteroid max linear speed',
            min: 0, max: 2, step: 0.025,
            fmt: value => value.toFixed(3),
            help: 'Per-frame cap on locally-owned asteroid velocity. 0 disables the cap.',
        }),
        control({
            key: 'ASTEROID_MAX_SPIN',
            label: 'Asteroid max spin (rad/frame)',
            min: 0, max: 1, step: 0.005,
            fmt: value => `${value.toFixed(3)} (${(value * 60 / (2 * Math.PI)).toFixed(2)} rot/s)`,
            help: 'Per-frame cap on locally-owned asteroid rotation speed. 0 disables the cap.',
        }),
        control({
            key: 'DEFLECTION_KICK',
            label: 'Deflection kick (head-on delta-v COM)',
            min: 0, max: 5e-3, step: 1e-5,
            fmt: value => value.toExponential(2),
            help: 'Head-on parent center-of-mass velocity change per bullet hit.',
        }),
        control({
            key: 'SEPARATION_ENERGY',
            label: 'Separation energy',
            min: 0, max: 1e-3, step: 1e-6,
            fmt: value => value.toExponential(2),
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
            key: 'MASS_SPLIT_BIAS',
            label: 'Mass split bias (offset to asymmetry)',
            min: 0, max: 1, step: 0.01,
            fmt: value => value.toFixed(2),
            help: '0 always splits evenly; 1 applies the full impact-offset asymmetry.',
        }),
        control({
            key: 'FRACTURE_ENABLED',
            label: 'Fracture split enabled (0/1)',
            min: 0, max: 1, step: 1,
            fmt: value => `${Math.round(value)}`,
            help: '0 uses the legacy disk split path; 1 uses polygon fracture.',
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
            help: 'Caps buffered remote projection, spawn projection, and migration seed projection.',
        }),
        control({
            key: 'SHIP_TURN_SPEED',
            label: 'Ship turn max speed (rad/frame)',
            min: 0, max: 0.6, step: 0.005,
            fmt: value => `${value.toFixed(3)} (${(value * 60 * 180 / Math.PI).toFixed(0)} deg/s)`,
            help: 'Per-frame cap on ship angular speed.',
        }),
        control({
            key: 'TOUCH_TURN_GAIN',
            label: 'Touch displacement to turn gain',
            min: 0, max: 5, step: 0.1,
            fmt: value => value.toFixed(2),
            help: 'Maps left-anchor lateral displacement to turn input.',
        }),
        control({
            key: 'SHIP_MAX_SPEED',
            label: 'Ship max linear velocity',
            min: 0, max: 6, step: 0.025,
            fmt: value => value.toFixed(3),
            help: 'Cap on ship velocity. 0 disables the cap.',
        }),
        control({
            key: 'TOUCH_THRUST_GAIN',
            label: 'Touch displacement to thrust gain',
            min: 0, max: 5, step: 0.1,
            fmt: value => value.toFixed(2),
            help: 'Maps upward anchor displacement to thrust input.',
        }),
        control({
            key: 'TOUCH_THRUST_MAX',
            label: 'Touch thrust input maximum',
            min: 0, max: 5, step: 0.1,
            fmt: value => value.toFixed(2),
            help: 'Caps touch thrust input; 1.00 matches standard full thrust.',
        }),
        control({
            key: 'TOUCH_BRAKE_GAIN',
            label: 'Touch displacement to brake gain',
            min: 0, max: 5, step: 0.1,
            fmt: value => value.toFixed(2),
            help: 'Maps downward anchor displacement to brake input.',
        }),
        control({
            key: 'TOUCH_STICK_TURN_DEADZONE_PX',
            label: 'Touch turn dead-zone (reference CSS px)',
            min: 0, max: 60, step: 1,
            fmt: value => `${Math.round(value)} px`,
            help: 'Horizontal rectilinear dead-zone half-extent at the touch-anchor reference dimension.',
        }),
        control({
            key: 'TOUCH_STICK_THRUST_DEADZONE_PX',
            label: 'Touch thrust/brake dead-zone (reference CSS px)',
            min: 0, max: 60, step: 1,
            fmt: value => `${Math.round(value)} px`,
            help: 'Vertical rectilinear dead-zone half-extent at the touch-anchor reference dimension.',
        }),
        control({
            key: 'TOUCH_POLAR_DEADZONE_PX',
            label: 'Polar left anchor dead-zone radius (reference CSS px)',
            min: 0, max: 80, step: 1,
            fmt: value => `${Math.round(value)} px`,
            help: 'Minimum polar-anchor radius at the touch-anchor reference dimension.',
        }),
        control({
            key: 'TOUCH_POLAR_THRESHOLD_PX',
            label: 'Polar left anchor threshold radius (reference CSS px)',
            min: 4, max: 200, step: 1,
            fmt: value => `${Math.round(value)} px`,
            help: 'Radius where polar turn reaches full input and thrust begins at the reference dimension.',
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
        snapshotConfigValues,
        buildSessionConfigMetadata,
        applySessionConfigMetadata,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsConfig;
}
