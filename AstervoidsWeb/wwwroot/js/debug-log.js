/**
 * Debug logging helpers shared by the inline game runtime and the
 * classic-script modules.
 *
 * Every call is gated on `window.ASTERVOIDS_DEBUG` so production consoles stay
 * quiet while the same call sites stay available for live debugging. The flag
 * is read per call (not captured) so toggling `window.ASTERVOIDS_DEBUG` from a
 * console session takes effect immediately.
 *
 * Load this before any module that logs. Consumers destructure it once:
 *   const { log: _log, warn: _warn, error: _error } = AstervoidsDebugLog;
 */
const AstervoidsDebugLog = (function () {
    const enabled = () => typeof window !== 'undefined' && !!window.ASTERVOIDS_DEBUG;
    return {
        log: (...a) => { if (enabled()) console.log(...a); },
        warn: (...a) => { if (enabled()) console.warn(...a); },
        error: (...a) => { if (enabled()) console.error(...a); }
    };
})();

// Browser: attach to window for cross-script discovery. Top-level `const` in a
// classic script is not auto-attached to window. See the identical note in
// session-client.js.
if (typeof window !== 'undefined') {
    window.AstervoidsDebugLog = AstervoidsDebugLog;
}

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsDebugLog;
}
