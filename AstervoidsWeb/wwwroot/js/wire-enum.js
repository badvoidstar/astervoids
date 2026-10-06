/**
 * Wire Enum Translation Module
 *
 * The server sends MemberRole and ObjectScope as 1-byte enum values (Phase 1 wire-opt)
 * instead of strings. Game-facing code uses 'Server'/'Client'
 * and 'Member'/'Session' string literals (e.g. `member.role === 'Server'`).
 *
 * This module funnels the byte → string translation through a single boundary so all
 * downstream code keeps the readable representation.
 *
 * Order MUST match the server-side `MemberRole` and `ObjectScope` enum declarations:
 *   MemberRole:  Server=0, Client=1   (AstervoidsWeb/Models/MemberRole.cs)
 *   ObjectScope: Member=0, Session=1  (AstervoidsWeb/Models/ObjectScope.cs)
 *
 * Wire savings: 1 byte for the enum + 1 byte msgpack uint header = ~2 bytes per occurrence,
 * vs 8-9 bytes for the corresponding string ("Server"/"Client", "Member"/"Session").
 */
const WireEnum = (function() {
    const MEMBER_ROLE_NAMES = ['Server', 'Client'];
    const OBJECT_SCOPE_NAMES = ['Member', 'Session'];

    /**
     * Convert a wire MemberRole (0/1) to its string form ('Server'/'Client').
     * Null/undefined represent absent optional metadata.
     */
    function roleFromWire(v) {
        if (typeof v === 'number') return MEMBER_ROLE_NAMES[v] ?? null;
        if (v == null) return v;
        throw new TypeError('Unsupported MemberRole wire contract: expected a numeric enum');
    }

    /**
     * Convert a wire ObjectScope (0/1) to its string form ('Member'/'Session').
     * Null/undefined represent absent optional metadata.
     */
    function scopeFromWire(v) {
        if (typeof v === 'number') return OBJECT_SCOPE_NAMES[v] ?? null;
        if (v == null) return v;
        throw new TypeError('Unsupported ObjectScope wire contract: expected a numeric enum');
    }

    /**
     * Translate the role field on a MemberInfo in place. Safe on null/undefined.
     */
    function translateMember(member) {
        if (member && member.role !== undefined) member.role = roleFromWire(member.role);
        return member;
    }

    /**
     * Translate the scope field on an ObjectInfo in place. Safe on null/undefined.
     */
    function translateObject(obj) {
        if (obj && obj.scope !== undefined) obj.scope = scopeFromWire(obj.scope);
        return obj;
    }

    /**
     * Convert a GuidLongPair[] (each entry deserialized as a 2-element array
     * [guidString, long] after GuidUtils.transformBinaryGuids) into a
     * string-keyed object { [guidString]: long } for game-facing consumers.
     */
    function pairsToObject(pairs) {
        if (pairs == null) return {};
        if (Array.isArray(pairs)) {
            const out = {};
            for (let i = 0; i < pairs.length; i++) {
                const p = pairs[i];
                if (Array.isArray(p) && p.length >= 2) {
                    out[p[0]] = p[1];
                }
            }
            return out;
        }
        throw new TypeError('Unsupported GUID-pair wire contract: expected positional pairs');
    }

    return {
        roleFromWire,
        scopeFromWire,
        translateMember,
        translateObject,
        pairsToObject,
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WireEnum;
}
