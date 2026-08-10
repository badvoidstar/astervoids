/**
 * Aspect-ratio compensation for asteroid difficulty.
 *
 * On non-square viewports the playable area grows with the longer axis while
 * asteroid count stays fixed, so difficulty decreases as the aspect ratio
 * moves away from 1:1.  This module defines a deterministic compensation
 * model that increases asteroid size and speed to restore consistent pressure.
 *
 * Model:
 *   aspect     = min(max(w,h)/min(w,h), ASPECT_MAX_COMPENSATED)
 *   sizeScale  = aspect ** sizeWeight
 *   speedScale = aspect ** (1 - sizeWeight)
 *
 * Invariant: sizeScale * speedScale === aspect  (within floating-point precision)
 *
 * The compensated aspect factor is frozen once per game/session and stored in
 * session metadata (ASPECT_COMPENSATION) so all multiplayer peers share the
 * same physics regardless of their local viewport.
 */
const AstervoidsAspectCompensation = (function () {

    /**
     * Compute the capped aspect factor for a viewport.
     *
     * @param {number} width               Viewport width in pixels (or any consistent unit).
     * @param {number} height              Viewport height in pixels.
     * @param {number} [maxCompensated=2.25] Cap applied before raising to the exponents.
     * @returns {number} Aspect factor ≥ 1, capped at maxCompensated.
     */
    function computeAspectFactor(width, height, maxCompensated = 2.25) {
        const a   = Math.max(1, Math.abs(width));
        const b   = Math.max(1, Math.abs(height));
        const raw = Math.max(a, b) / Math.min(a, b);
        return Math.min(raw, maxCompensated);
    }

    /**
     * Derive size and speed scale multipliers from a pre-computed aspect factor.
     *
     * @param {number} aspectFactor Pre-computed (capped) aspect factor, e.g. from
     *                              computeAspectFactor(); must be ≥ 1.
     * @param {number} [sizeWeight=0.45] Fraction of the compensation budget applied to
     *                                   size; the remainder goes to speed.
     * @returns {{ sizeScale: number, speedScale: number }}
     */
    function asteroidAspectScales(aspectFactor, sizeWeight = 0.45) {
        const f = Math.max(1, aspectFactor);
        return {
            sizeScale:  Math.pow(f, sizeWeight),
            speedScale: Math.pow(f, 1 - sizeWeight),
        };
    }

    return Object.freeze({ computeAspectFactor, asteroidAspectScales });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsAspectCompensation;
}
