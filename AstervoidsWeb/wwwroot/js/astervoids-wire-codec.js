/**
 * Astervoids-specific packing at the game/replication boundary.
 */
const AstervoidsWireCodec = (function () {
    const guidUtils = typeof GuidUtils !== 'undefined'
        ? GuidUtils
        : require('./guid-utils.js');
    const TWO_PI = Math.PI * 2;
    const ASTEROID_VERTEX_BYTES = 4;
    const COUNTER_ENTRY_BYTES = 20;

    function isByteArray(value) {
        return value instanceof Uint8Array;
    }

    function bytesEqual(left, right) {
        if (left === right) return true;
        if (!isByteArray(left) || !isByteArray(right) || left.length !== right.length) {
            return false;
        }
        for (let i = 0; i < left.length; i++) {
            if (left[i] !== right[i]) return false;
        }
        return true;
    }

    function packAsteroidVertices(vertices) {
        if (!Array.isArray(vertices)) {
            throw new TypeError('asteroid vertices must be an array');
        }
        const bytes = new Uint8Array(vertices.length * ASTEROID_VERTEX_BYTES);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < vertices.length; i++) {
            const vertex = vertices[i];
            const angle = Number(vertex?.angle);
            const distance = Number(vertex?.distance);
            if (!Number.isFinite(angle)) {
                throw new TypeError(`asteroid vertex ${i} has an invalid angle`);
            }
            if (!Number.isFinite(distance) || distance < 0 || distance > 1) {
                throw new RangeError(`asteroid vertex ${i} distance must be within [0, 1]`);
            }
            const wrappedAngle = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
            const angleQ = Math.round(wrappedAngle / TWO_PI * 65536) & 0xffff;
            const distanceQ = Math.round(distance * 65535);
            const offset = i * ASTEROID_VERTEX_BYTES;
            view.setUint16(offset, angleQ, true);
            view.setUint16(offset + 2, distanceQ, true);
        }
        return bytes;
    }

    function unpackAsteroidVertices(value) {
        if (value == null) return null;
        if (!isByteArray(value)) {
            throw new TypeError('packed asteroid vertices must be a Uint8Array');
        }
        if (value.length % ASTEROID_VERTEX_BYTES !== 0) {
            throw new Error('packed asteroid vertices have an invalid byte length');
        }
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        const vertices = new Array(value.length / ASTEROID_VERTEX_BYTES);
        for (let i = 0; i < vertices.length; i++) {
            const offset = i * ASTEROID_VERTEX_BYTES;
            vertices[i] = {
                angle: view.getUint16(offset, true) / 65536 * TWO_PI,
                distance: view.getUint16(offset + 2, true) / 65535
            };
        }
        return vertices;
    }

    function hasAsteroidVertices(value) {
        return isByteArray(value)
            && value.length >= ASTEROID_VERTEX_BYTES
            && value.length % ASTEROID_VERTEX_BYTES === 0;
    }

    function maxAsteroidVertexDistance(value) {
        if (value == null) return 0;
        if (!isByteArray(value)) throw new TypeError('packed asteroid vertices must be a Uint8Array');
        if (value.length % ASTEROID_VERTEX_BYTES !== 0) {
            throw new Error('packed asteroid vertices have an invalid byte length');
        }
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        let maximumQ = 0;
        for (let offset = 2; offset < value.length; offset += ASTEROID_VERTEX_BYTES) {
            const distanceQ = view.getUint16(offset, true);
            if (distanceQ > maximumQ) maximumQ = distanceQ;
        }
        return maximumQ / 65535;
    }

    function guidStringToBytes(value) {
        try {
            return guidUtils.guidToBytes(value);
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            throw new TypeError(`invalid counter-map GUID: ${value}`);
        }
    }

    function guidBytesToString(bytes, offset) {
        const value = guidUtils.bytesToGuid(bytes, offset);
        if (value === null) throw new Error('counter-map GUID payload is truncated');
        return value;
    }

    function packCounterMap(counters) {
        if (counters == null) counters = {};
        if (typeof counters !== 'object' || Array.isArray(counters) || isByteArray(counters)) {
            throw new TypeError('counter map must be a plain object');
        }
        const entries = Object.entries(counters)
            .map(([id, value]) => [id.toLowerCase(), value])
            .sort((left, right) =>
                left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
        const bytes = new Uint8Array(entries.length * COUNTER_ENTRY_BYTES);
        const view = new DataView(bytes.buffer);
        let previousId = null;
        for (let i = 0; i < entries.length; i++) {
            const [id, value] = entries[i];
            if (id === previousId) {
                throw new Error(`duplicate counter-map GUID: ${id}`);
            }
            if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
                throw new RangeError(`counter-map value for ${id} must be a uint32`);
            }
            const offset = i * COUNTER_ENTRY_BYTES;
            bytes.set(guidStringToBytes(id), offset);
            view.setUint32(offset + 16, value, true);
            previousId = id;
        }
        return bytes;
    }

    function unpackCounterMap(value) {
        if (value == null) return {};
        if (!isByteArray(value)) {
            throw new TypeError('packed counter map must be a Uint8Array');
        }
        if (value.length % COUNTER_ENTRY_BYTES !== 0) {
            throw new Error('packed counter map has an invalid byte length');
        }
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        const counters = {};
        for (let offset = 0; offset < value.length; offset += COUNTER_ENTRY_BYTES) {
            const id = guidBytesToString(value, offset);
            if (Object.hasOwn(counters, id)) throw new Error('packed counter map contains duplicate GUIDs');
            counters[id] = view.getUint32(offset + 16, true);
        }
        return counters;
    }

    function isParticipantTag(value) {
        return typeof value === 'string' && /^[A-Za-z0-9_-]{1,8}$/.test(value);
    }

    function packTagMap(tags) {
        if (tags == null) tags = {};
        if (typeof tags !== 'object' || Array.isArray(tags) || isByteArray(tags)) {
            throw new TypeError('participant tags must be a plain object');
        }
        const entries = Object.entries(tags).map(([id, tag]) => [id.toLowerCase(), tag])
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        let size = 0;
        let previous = null;
        for (const [id, tag] of entries) {
            if (!guidUtils.isGuid(id) || id === previous || !isParticipantTag(tag)) {
                throw new TypeError('participant tags contain an invalid or duplicate entry');
            }
            size += 17 + tag.length;
            previous = id;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const [id, tag] of entries) {
            bytes.set(guidUtils.guidToBytes(id), offset);
            bytes[offset + 16] = tag.length;
            for (let i = 0; i < tag.length; i++) bytes[offset + 17 + i] = tag.charCodeAt(i);
            offset += 17 + tag.length;
        }
        return bytes;
    }

    function unpackTagMap(value) {
        if (value == null) return {};
        if (!isByteArray(value)) {
            throw new TypeError('packed participant tags must be a Uint8Array');
        }
        const tags = {};
        for (let offset = 0; offset < value.length;) {
            if (offset + 17 > value.length) throw new Error('participant tags are truncated');
            const id = guidUtils.bytesToGuid(value, offset);
            const length = value[offset + 16];
            if (length < 1 || length > 8 || offset + 17 + length > value.length
                || Object.hasOwn(tags, id)) {
                throw new Error('participant tags contain an invalid or duplicate entry');
            }
            const tag = String.fromCharCode(...value.subarray(offset + 17, offset + 17 + length));
            if (!isParticipantTag(tag)) throw new Error('participant tag has invalid characters');
            tags[id] = tag;
            offset += 17 + length;
        }
        return tags;
    }

    return {
        bytesEqual,
        hasAsteroidVertices,
        maxAsteroidVertexDistance,
        packAsteroidVertices,
        unpackAsteroidVertices,
        packCounterMap,
        unpackCounterMap,
        isParticipantTag,
        packTagMap,
        unpackTagMap
    };
})();

if (typeof window !== 'undefined') {
    window.AstervoidsWireCodec = AstervoidsWireCodec;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsWireCodec;
}
