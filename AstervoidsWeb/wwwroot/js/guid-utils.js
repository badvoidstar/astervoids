/**
 * GUID Utilities Module
 * Converts between .NET binary GUIDs (16-byte Uint8Array) and string GUIDs.
 *
 * When the server serializes Guid properties via MessagePack with BinaryGuidFormatter,
 * they arrive as Uint8Array(16) on the JS side. This module converts them back to
 * standard GUID strings so all game code continues to use string comparisons,
 * Map keys, etc. without changes.
 *
 * .NET Guid.TryWriteBytes uses mixed-endian layout:
 *   bytes[0-3]:  group 1 (int32, little-endian)
 *   bytes[4-5]:  group 2 (int16, little-endian)
 *   bytes[6-7]:  group 3 (int16, little-endian)
 *   bytes[8-15]: groups 4+5 (big-endian)
 */

const GuidUtils = (function() {
    const mixedEndianOrder = Object.freeze([
        3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15
    ]);
    const hex = new Array(256);
    for (let i = 0; i < 256; i++) {
        hex[i] = i.toString(16).padStart(2, '0');
    }

    /**
     * Convert a canonical GUID string to the 16-byte .NET mixed-endian layout.
     * Throws when the value is not a canonical 8-4-4-4-12 hexadecimal GUID.
     */
    function guidToBytes(value) {
        if (typeof value !== 'string'
            || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
            throw new TypeError(`Invalid GUID: ${value}`);
        }
        const canonicalHex = value.replace(/-/g, '');
        const bytes = new Uint8Array(16);
        for (let i = 0; i < mixedEndianOrder.length; i++) {
            const source = mixedEndianOrder[i] * 2;
            bytes[i] = parseInt(canonicalHex.slice(source, source + 2), 16);
        }
        return bytes;
    }

    /**
     * Convert a 16-byte Uint8Array (.NET binary Guid) to a lowercase GUID string.
     * An offset may select a GUID within a larger byte buffer.
     */
    function bytesToGuid(bytes, offset = 0) {
        if (!(bytes instanceof Uint8Array)
            || !Number.isInteger(offset)
            || offset < 0
            || offset + 16 > bytes.length) {
            return null;
        }

        // .NET mixed-endian: reverse first 3 groups, big-endian for last 2
        return (
            hex[bytes[offset + 3]] + hex[bytes[offset + 2]] + hex[bytes[offset + 1]] + hex[bytes[offset]] + '-' +
            hex[bytes[offset + 5]] + hex[bytes[offset + 4]] + '-' +
            hex[bytes[offset + 7]] + hex[bytes[offset + 6]] + '-' +
            hex[bytes[offset + 8]] + hex[bytes[offset + 9]] + '-' +
            hex[bytes[offset + 10]] + hex[bytes[offset + 11]] + hex[bytes[offset + 12]] + hex[bytes[offset + 13]] +
            hex[bytes[offset + 14]] + hex[bytes[offset + 15]]
        );
    }

    /**
     * Recursively walk a value and convert any 16-byte Uint8Array to a GUID string.
     * Applied at the session-client boundary so all downstream game code sees strings.
     * Mutates the object in place for efficiency (freshly deserialized from MessagePack).
     */
    function transformBinaryGuids(value) {
        if (value == null || typeof value !== 'object') return value;

        // 16-byte Uint8Array → GUID string
        if (value instanceof Uint8Array) {
            return value.length === 16 ? bytesToGuid(value) : value;
        }

        // Recurse into arrays
        if (Array.isArray(value)) {
            // SyncPayload envelope: [schemaId:number, data:byte[]]. The data slot
            // is an opaque payload that may legitimately be exactly 16 bytes long
            // (e.g. a positional schema or a small delta dict that encodes to 16
            // bytes). Treating it as a .NET binary Guid here would corrupt it
            // before SyncPayload.unwrap gets a chance to decode it. Leave such
            // envelopes untouched so the downstream unwrap sees the real bytes.
            // (Member-sequence pairs are [guidBytes, long] = [Uint8Array, number],
            // which do NOT match this shape, so their Guid is still converted.)
            if (value.length === 2 && typeof value[0] === 'number' && value[1] instanceof Uint8Array) {
                return value;
            }
            for (let i = 0; i < value.length; i++) {
                value[i] = transformBinaryGuids(value[i]);
            }
            return value;
        }

        // Recurse into plain objects (Map/Set/Date etc. are left alone)
        if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
            for (const key in value) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    value[key] = transformBinaryGuids(value[key]);
                }
            }
        }
        return value;
    }

    return { guidToBytes, bytesToGuid, transformBinaryGuids };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GuidUtils;
}
