/**
 * Explicit mutation modes for applying server-authoritative object records.
 */
const AuthoritativeObject = (function() {
    const METADATA_KEYS = Object.freeze([
        'creatorMemberId',
        'ownerMemberId',
        'scope',
    ]);

    function typeChange(target, oldType, changed) {
        return {
            changed,
            oldType,
            newType: target.data?.type
        };
    }

    function applyTiming(target, timing, validAtOnlyWhenMissing) {
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(timing, 'arrivalTime')) {
            target.arrivalTime = timing.arrivalTime;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(timing, 'arrivalServerTime')) {
            target.arrivalServerTime = timing.arrivalServerTime;
            changed = true;
        }
        if (timing.validAt !== undefined && timing.validAt !== null
            && (!validAtOnlyWhenMissing || target.validAt === undefined)) {
            target.validAt = timing.validAt;
            changed = true;
        }
        return changed;
    }

    function applyFull(target, source, timing = {}) {
        const oldType = target.data?.type;
        for (const key of METADATA_KEYS) target[key] = source[key];
        target.data = source.data || {};
        target.version = source.version;
        applyTiming(target, timing, false);
        return typeChange(target, oldType, true);
    }

    function applyPatch(target, source, timing = {}) {
        const oldType = target.data?.type;
        Object.assign(target.data || (target.data = {}), source.data || {});
        target.version = source.version;
        applyTiming(target, timing, false);
        return typeChange(target, oldType, true);
    }

    function backfill(target, source, options = {}) {
        const oldType = target.data?.type;
        let changed = false;
        for (const key of METADATA_KEYS) {
            if (target[key] == null && source[key] != null) {
                target[key] = source[key];
                changed = true;
            }
        }
        if (options.includeData) {
            const targetData = target.data || (target.data = {});
            for (const [key, value] of Object.entries(source.data || {})) {
                if (targetData[key] === undefined) {
                    targetData[key] = value;
                    changed = true;
                }
            }
        }
        changed = applyTiming(target, { validAt: options.validAt }, true) || changed;
        return typeChange(target, oldType, changed);
    }

    return Object.freeze({
        applyFull,
        applyPatch,
        backfill,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AuthoritativeObject;
}
