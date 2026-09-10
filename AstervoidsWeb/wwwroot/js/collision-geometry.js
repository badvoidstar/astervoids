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

    function closestPoint(point, start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared > 0 ? Math.max(0, Math.min(1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
        return { x: start.x + t * dx, y: start.y + t * dy };
    }

    function circlePolygonSeparation(circle, vertices) {
        let distanceSquared = Infinity;
        let contact = null;
        for (let i = 0; i < vertices.length; i++) {
            const point = closestPoint(circle, vertices[i], vertices[(i + 1) % vertices.length]);
            const d2 = (circle.x - point.x) ** 2 + (circle.y - point.y) ** 2;
            if (d2 < distanceSquared) {
                distanceSquared = d2;
                contact = point;
            }
        }
        return {
            distance: pointInPolygon(circle, vertices) ? 0
                : Math.max(0, Math.sqrt(distanceSquared) - circle.radius),
            contact,
        };
    }

    function polygonSeparation(first, second) {
        if (!first.length || !second.length) return { distance: Infinity, contact: null };
        let distanceSquared = Infinity;
        let contact = null;
        for (let i = 0; i < first.length; i++) {
            const a = first[i], b = first[(i + 1) % first.length];
            for (let j = 0; j < second.length; j++) {
                const c = second[j], d = second[(j + 1) % second.length];
                const d2 = segmentSegmentDistanceSquared(a, b, c, d);
                if (d2 < distanceSquared) {
                    distanceSquared = d2;
                    const ux = b.x - a.x, uy = b.y - a.y;
                    const vx = d.x - c.x, vy = d.y - c.y;
                    const cross = ux * vy - uy * vx;
                    const t = cross ? ((c.x - a.x) * vy - (c.y - a.y) * vx) / cross : -1;
                    const u = cross ? ((c.x - a.x) * uy - (c.y - a.y) * ux) / cross : -1;
                    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                        contact = { x: a.x + t * ux, y: a.y + t * uy };
                    } else {
                        const candidates = [
                            [a, closestPoint(a, c, d)], [b, closestPoint(b, c, d)],
                            [closestPoint(c, a, b), c], [closestPoint(d, a, b), d],
                        ];
                        candidates.sort((left, right) =>
                            (left[0].x - left[1].x) ** 2 + (left[0].y - left[1].y) ** 2
                            - (right[0].x - right[1].x) ** 2 - (right[0].y - right[1].y) ** 2);
                        contact = candidates[0][1];
                    }
                }
            }
        }
        if (pointInPolygon(first[0], second) || pointInPolygon(second[0], first)) {
            distanceSquared = 0;
        }
        return { distance: Math.sqrt(distanceSquared), contact };
    }

    function polygonPolygonCollision(first, second) {
        return polygonSeparation(first, second).distance <= 1e-9;
    }

    function prepareMotion(motion) {
        const start = motion.start;
        const end = motion.end;
        const wrap = motion.wrap;
        const breaks = [0, 1];
        const deltas = { x: end.x - start.x, y: end.y - start.y };
        for (const axis of ['x', 'y']) {
            const size = wrap?.[axis === 'x' ? 'width' : 'height'];
            const margin = wrap?.[axis === 'x' ? 'marginX' : 'marginY'] || 0;
            if (!(size > 0)) continue;
            const span = size + 2 * margin;
            deltas[axis] -= Math.round(deltas[axis] / span) * span;
            const delta = deltas[axis];
            const boundary = delta > 0 ? size + margin : -margin;
            const time = delta ? (boundary - start[axis]) / delta : -1;
            if (time > 0 && time < 1) breaks.push(time);
        }
        const angleDelta = Math.atan2(
            Math.sin((end.angle || 0) - (start.angle || 0)),
            Math.cos((end.angle || 0) - (start.angle || 0)));
        return { ...motion, deltas, angleDelta, breaks };
    }

    function poseAt(motion, time, intervalMidpoint) {
        const pose = {
            x: motion.start.x + motion.deltas.x * time,
            y: motion.start.y + motion.deltas.y * time,
            angle: (motion.start.angle || 0) + motion.angleDelta * time,
        };
        for (const axis of ['x', 'y']) {
            const size = motion.wrap?.[axis === 'x' ? 'width' : 'height'];
            const margin = motion.wrap?.[axis === 'x' ? 'marginX' : 'marginY'] || 0;
            if (!(size > 0)) continue;
            const span = size + 2 * margin;
            // Choose one side of a wrap for the entire interval. In particular,
            // never interpolate the discontinuity through the middle of the field.
            const midpoint = motion.start[axis] + motion.deltas[axis] * intervalMidpoint;
            pose[axis] -= Math.floor((midpoint + margin) / span) * span;
        }
        return pose;
    }

    function verticesAt(motion, pose) {
        const cos = Math.cos(pose.angle), sin = Math.sin(pose.angle);
        return motion.vertices.map(v => ({
            x: pose.x + cos * v.x - sin * v.y,
            y: pose.y + sin * v.x + cos * v.y,
        }));
    }

    function motionRadius(motion) {
        return motion.vertices
            ? motion.vertices.reduce((radius, vertex) => Math.max(radius, Math.hypot(vertex.x, vertex.y)), 0)
            : motion.radius;
    }

    function translatedCircleContactTime(start, end, radius, vertices) {
        if (circlePolygonCollision({ ...start, radius }, vertices)) return 0;
        const dx = end.x - start.x, dy = end.y - start.y;
        const speedSquared = dx * dx + dy * dy;
        if (!speedSquared) return null;
        let earliest = Infinity;
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i], b = vertices[(i + 1) % vertices.length];
            const ox = start.x - a.x, oy = start.y - a.y;
            const projection = ox * dx + oy * dy;
            const discriminant = projection * projection
                - speedSquared * (ox * ox + oy * oy - radius * radius);
            if (discriminant >= 0) {
                const time = (-projection - Math.sqrt(discriminant)) / speedSquared;
                if (time >= 0 && time <= 1) earliest = Math.min(earliest, time);
            }
            const ex = b.x - a.x, ey = b.y - a.y;
            const length = Math.hypot(ex, ey);
            if (!length) continue;
            const normalSpeed = (dx * -ey + dy * ex) / length;
            if (!normalSpeed) continue;
            const distance = (ox * -ey + oy * ex) / length;
            for (const side of [-radius, radius]) {
                const time = (side - distance) / normalSpeed;
                if (time < 0 || time > 1) continue;
                const along = ((ox + dx * time) * ex + (oy + dy * time) * ey) / (length * length);
                if (along >= 0 && along <= 1) earliest = Math.min(earliest, time);
            }
        }
        return Number.isFinite(earliest) ? earliest : null;
    }

    // A distance function is Lipschitz with this bound on relative translation
    // plus both angular arc lengths. Ordered interval subdivision therefore
    // cannot step over thin shards or contacts that occur only during rotation.
    // Every returned contact is within tolerance spatial units of the surfaces.
    function movingTOI(firstMotion, secondMotion, circle, options = {}) {
        const first = prepareMotion(firstMotion), second = prepareMotion(secondMotion);
        if (!second.vertices?.length || (!circle && !first.vertices?.length)) return null;
        const firstRadius = motionRadius(first), secondRadius = motionRadius(second);
        const relativeX = first.deltas.x - second.deltas.x;
        const relativeY = first.deltas.y - second.deltas.y;
        const speed = Math.hypot(relativeX, relativeY)
            + Math.abs(first.angleDelta) * firstRadius
            + Math.abs(second.angleDelta) * secondRadius;
        // At most 14 subdivision levels per continuous wrap interval, even
        // for pathological near-parallel grazing. Normal 60 Hz motion retains
        // the 0.002 px bound; huge steps explicitly report their coarser bound.
        const tolerance = Math.max(options.tolerance ?? 0.002, speed / 8192);
        const times = [...new Set([...first.breaks, ...second.breaks])].sort((a, b) => a - b);
        let evaluations = 0;
        for (let interval = 0; interval + 1 < times.length; interval++) {
            const lo = times[interval], hi = times[interval + 1];
            const midpoint = (lo + hi) / 2;
            const a0 = poseAt(first, lo, midpoint), a1 = poseAt(first, hi, midpoint);
            const b0 = poseAt(second, lo, midpoint), b1 = poseAt(second, hi, midpoint);
            if (!sweptCircleIntersectsCircle(
                { x: a0.x - b0.x, y: a0.y - b0.y, radius: firstRadius + tolerance },
                { x: a1.x - b1.x, y: a1.y - b1.y },
                { x: 0, y: 0, radius: secondRadius })) continue;
            const evaluate = time => {
                evaluations++;
                const firstPose = poseAt(first, time, midpoint);
                const secondPose = poseAt(second, time, midpoint);
                const polygon = verticesAt(second, secondPose);
                const separation = circle
                    ? circlePolygonSeparation({ ...firstPose, radius: first.radius }, polygon)
                    : polygonSeparation(verticesAt(first, firstPose), polygon);
                return { ...separation, time, firstPose, secondPose, evaluations, tolerance };
            };
            const initial = evaluate(lo);
            if (circle && second.angleDelta === 0) {
                const time = translatedCircleContactTime(a0,
                    { x: a1.x + b0.x - b1.x, y: a1.y + b0.y - b1.y },
                    first.radius, verticesAt(second, b0));
                if (time !== null) return evaluate(lo + time * (hi - lo));
                continue;
            }
            if (initial.distance <= tolerance) return initial;
            if (!(speed > 0)) continue;
            const stack = [{ lo, hi, left: initial }];
            while (stack.length) {
                const node = stack.pop();
                const mid = (node.lo + node.hi) / 2;
                const sample = evaluate(mid);
                const halfTravel = speed * (node.hi - node.lo) / 2;
                if (sample.distance > halfTravel + tolerance) continue;
                if (halfTravel <= tolerance / 2) {
                    if (node.left.distance <= tolerance) return node.left;
                    if (sample.distance <= tolerance) return sample;
                    const right = evaluate(node.hi);
                    if (right.distance <= tolerance) return right;
                    continue;
                }
                stack.push({ lo: mid, hi: node.hi, left: sample });
                stack.push({ lo: node.lo, hi: mid, left: node.left });
            }
        }
        return null;
    }

    function movingCirclePolygonTOI(circle, polygon, options) {
        return movingTOI(circle, polygon, true, options);
    }

    function movingPolygonTOI(first, second, options) {
        return movingTOI(first, second, false, options);
    }

    return Object.freeze({
        pointInPolygon,
        circlePolygonCollision,
        sweptCircleIntersectsCircle,
        sweptCirclePolygonCollision,
        wrappedDelta,
        polygonPolygonCollision,
        movingCirclePolygonTOI,
        movingPolygonTOI,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsCollision;
}
