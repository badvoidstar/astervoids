/**
 * Shared stationary and continuous-collision geometry.
 */
const AstervoidsCollision = (function() {
    function pointSegmentDistanceSquared(point, start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared === 0) {
            return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
        }
        const t = Math.max(0, Math.min(1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
        const closestX = start.x + dx * t;
        const closestY = start.y + dy * t;
        return (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
    }

    function segmentSegmentDistanceSquared(a0, a1, b0, b1) {
        const ux = a1.x - a0.x;
        const uy = a1.y - a0.y;
        const vx = b1.x - b0.x;
        const vy = b1.y - b0.y;
        const wx = a0.x - b0.x;
        const wy = a0.y - b0.y;
        const a = ux * ux + uy * uy;
        const b = ux * vx + uy * vy;
        const c = vx * vx + vy * vy;
        const d = ux * wx + uy * wy;
        const e = vx * wx + vy * wy;
        if (a === 0) return pointSegmentDistanceSquared(a0, b0, b1);
        if (c === 0) return pointSegmentDistanceSquared(b0, a0, a1);
        const denominator = a * c - b * b;
        let sNumerator;
        let sDenominator = denominator;
        let tNumerator;
        let tDenominator = denominator;

        if (denominator <= Number.EPSILON * a * c) {
            sNumerator = 0;
            sDenominator = 1;
            tNumerator = e;
            tDenominator = c;
        } else {
            sNumerator = b * e - c * d;
            tNumerator = a * e - b * d;
            if (sNumerator < 0) {
                sNumerator = 0;
                tNumerator = e;
                tDenominator = c;
            } else if (sNumerator > sDenominator) {
                sNumerator = sDenominator;
                tNumerator = e + b;
                tDenominator = c;
            }
        }

        if (tNumerator < 0) {
            tNumerator = 0;
            if (-d < 0) {
                sNumerator = 0;
            } else if (-d > a) {
                sNumerator = sDenominator;
            } else {
                sNumerator = -d;
                sDenominator = a;
            }
        } else if (tNumerator > tDenominator) {
            tNumerator = tDenominator;
            if (-d + b < 0) {
                sNumerator = 0;
            } else if (-d + b > a) {
                sNumerator = sDenominator;
            } else {
                sNumerator = -d + b;
                sDenominator = a;
            }
        }

        const s = Math.abs(sNumerator) < Number.EPSILON ? 0 : sNumerator / sDenominator;
        const t = Math.abs(tNumerator) < Number.EPSILON ? 0 : tNumerator / tDenominator;
        const dx = wx + s * ux - t * vx;
        const dy = wy + s * uy - t * vy;
        return dx * dx + dy * dy;
    }

    function pointInPolygon(point, vertices) {
        let inside = false;
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
            const current = vertices[i];
            const previous = vertices[j];
            if (((current.y > point.y) !== (previous.y > point.y))
                && point.x < (previous.x - current.x) * (point.y - current.y)
                    / (previous.y - current.y) + current.x) {
                inside = !inside;
            }
        }
        return inside;
    }

    function circlePolygonCollision(circle, vertices) {
        if (pointInPolygon(circle, vertices)) return true;
        const radiusSquared = circle.radius * circle.radius;
        for (let i = 0; i < vertices.length; i++) {
            if (pointSegmentDistanceSquared(
                circle, vertices[i], vertices[(i + 1) % vertices.length])
                <= radiusSquared) {
                return true;
            }
        }
        return false;
    }

    function sweptCircleIntersectsCircle(start, end, circle) {
        const reach = start.radius + circle.radius;
        return pointSegmentDistanceSquared(circle, start, end) <= reach * reach;
    }

    function sweptCirclePolygonCollision(start, end, vertices) {
        if (vertices.length < 2) return false;
        if (pointInPolygon(start, vertices) || pointInPolygon(end, vertices)) return true;
        const radiusSquared = start.radius * start.radius;
        for (let i = 0; i < vertices.length; i++) {
            const edgeStart = vertices[i];
            const edgeEnd = vertices[(i + 1) % vertices.length];
            if (segmentSegmentDistanceSquared(start, end, edgeStart, edgeEnd)
                <= radiusSquared) {
                return true;
            }
        }
        return false;
    }

    function wrappedDelta(previous, current, margin = 0) {
        let delta = current - previous;
        const range = 1 + 2 * margin;
        if (delta > range / 2) delta -= range;
        else if (delta < -range / 2) delta += range;
        return delta;
    }

    return Object.freeze({
        pointInPolygon,
        circlePolygonCollision,
        sweptCircleIntersectsCircle,
        sweptCirclePolygonCollision,
        wrappedDelta,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsCollision;
}
