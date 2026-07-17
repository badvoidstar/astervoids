/**
 * Astervoids-specific packing at the game/replication boundary.
 */
const AstervoidsWireCodec = (function () {
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
        if (Array.isArray(value)) {
            return value.map(vertex => ({
                angle: vertex.angle,
                distance: vertex.distance
            }));
        }
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
        return (Array.isArray(value) && value.length > 0)
            || (isByteArray(value)
                && value.length >= ASTEROID_VERTEX_BYTES
                && value.length % ASTEROID_VERTEX_BYTES === 0);
    }

    function maxAsteroidVertexDistance(value) {
        if (Array.isArray(value)) {
            let maximum = 0;
            for (const vertex of value) {
                const distance = Number(vertex?.distance) || 0;
                if (distance > maximum) maximum = distance;
            }
            return maximum;
        }
        if (!isByteArray(value)) return 0;
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
        if (typeof value !== 'string') {
            throw new TypeError('counter-map keys must be GUID strings');
        }
        const hex = value.replace(/-/g, '');
        if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
            throw new TypeError(`invalid counter-map GUID: ${value}`);
        }
        const bytes = new Uint8Array(16);
        const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
        for (let i = 0; i < order.length; i++) {
            bytes[i] = parseInt(hex.slice(order[i] * 2, order[i] * 2 + 2), 16);
        }
        return bytes;
    }

    function guidBytesToString(bytes, offset) {
        const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
        const hex = new Array(32);
        for (let i = 0; i < order.length; i++) {
            const byte = bytes[offset + i];
            const target = order[i] * 2;
            hex[target] = (byte >>> 4).toString(16);
            hex[target + 1] = (byte & 0x0f).toString(16);
        }
        return hex.slice(0, 8).join('')
            + '-' + hex.slice(8, 12).join('')
            + '-' + hex.slice(12, 16).join('')
            + '-' + hex.slice(16, 20).join('')
            + '-' + hex.slice(20).join('');
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
            if (typeof value === 'object' && !Array.isArray(value)) {
                return { ...value };
            }
            throw new TypeError('packed counter map must be a Uint8Array');
        }
        if (value.length % COUNTER_ENTRY_BYTES !== 0) {
            throw new Error('packed counter map has an invalid byte length');
        }
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        const counters = {};
        for (let offset = 0; offset < value.length; offset += COUNTER_ENTRY_BYTES) {
            counters[guidBytesToString(value, offset)] = view.getUint32(offset + 16, true);
        }
        return counters;
    }

    return {
        bytesEqual,
        hasAsteroidVertices,
        maxAsteroidVertexDistance,
        packAsteroidVertices,
        unpackAsteroidVertices,
        packCounterMap,
        unpackCounterMap
    };
})();

if (typeof window !== 'undefined') {
    window.AstervoidsWireCodec = AstervoidsWireCodec;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsWireCodec;
}
