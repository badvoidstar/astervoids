/**
 * Pure geometry and kinematics for asteroid fragmentation.
 */
const AstervoidsFracture = (function() {
    function polygonArea(vertices) {
        let area = 0;
        for (let i = 0; i < vertices.length; i++) {
            const next = (i + 1) % vertices.length;
            area += vertices[i].x * vertices[next].y - vertices[next].x * vertices[i].y;
        }
        return area * 0.5;
    }

    function polygonCentroid(vertices) {
        let cx = 0;
        let cy = 0;
        let area = 0;
        for (let i = 0; i < vertices.length; i++) {
            const next = (i + 1) % vertices.length;
            const cross = vertices[i].x * vertices[next].y - vertices[next].x * vertices[i].y;
            cx += (vertices[i].x + vertices[next].x) * cross;
            cy += (vertices[i].y + vertices[next].y) * cross;
            area += cross;
        }
        area *= 0.5;
        if (Math.abs(area) < 1e-18) {
            let sx = 0;
            let sy = 0;
            for (const vertex of vertices) {
                sx += vertex.x;
                sy += vertex.y;
            }
            return { x: sx / vertices.length, y: sy / vertices.length, area: 0 };
        }
        return { x: cx / (6 * area), y: cy / (6 * area), area };
    }

    function fractureSplitPolygon(vertices, normal, distance, jagPath) {
        const count = vertices.length;
        if (count < 3) return null;

        const sides = vertices.map(
            vertex => vertex.x * normal.x + vertex.y * normal.y - distance);
        const crossEdges = [];
        for (let i = 0; i < count; i++) {
            const next = (i + 1) % count;
            const startSide = sides[i];
            const endSide = sides[next];
            if ((startSide > 0 && endSide < 0) || (startSide < 0 && endSide > 0)) {
                const t = startSide / (startSide - endSide);
                crossEdges.push({
                    edgeStart: i,
                    point: {
                        x: vertices[i].x + (vertices[next].x - vertices[i].x) * t,
                        y: vertices[i].y + (vertices[next].y - vertices[i].y) * t,
                    },
                    fromPos: startSide > 0,
                });
            }
        }
        if (crossEdges.length !== 2) return null;

        const entryIndex = crossEdges[0].fromPos ? 0 : 1;
        const exitIndex = entryIndex === 0 ? 1 : 0;
        const buildHalf = (startCross, endCross, sideTest, jagDirection) => {
            const result = [{ x: startCross.point.x, y: startCross.point.y }];
            const stop = (endCross.edgeStart + 1) % count;
            let i = (startCross.edgeStart + 1) % count;
            let safety = count + 2;
            while (i !== stop && safety-- > 0) {
                if (sideTest(sides[i])) {
                    result.push({ x: vertices[i].x, y: vertices[i].y });
                }
                i = (i + 1) % count;
            }
            result.push({ x: endCross.point.x, y: endCross.point.y });
            if (jagDirection > 0) {
                for (const point of jagPath) result.push({ x: point.x, y: point.y });
            } else {
                for (let j = jagPath.length - 1; j >= 0; j--) {
                    result.push({ x: jagPath[j].x, y: jagPath[j].y });
                }
            }
            return result;
        };

        const positive = buildHalf(
            crossEdges[exitIndex], crossEdges[entryIndex], side => side > 0, 1);
        const negative = buildHalf(
            crossEdges[entryIndex], crossEdges[exitIndex], side => side < 0, -1);
        if (positive.length < 3 || negative.length < 3) return null;

        return {
            positive,
            negative,
            entry: crossEdges[entryIndex].point,
            exit: crossEdges[exitIndex].point,
        };
    }

    function buildFracturePolyline(entry, exit, count, jagAmplitude, randomFn) {
        const result = [];
        if (count <= 0) return result;

        const dx = exit.x - entry.x;
        const dy = exit.y - entry.y;
        const length = Math.hypot(dx, dy);
        if (length < 1e-12) return result;

        const perpendicularX = -dy / length;
        const perpendicularY = dx / length;
        for (let i = 1; i <= count; i++) {
            const t = i / (count + 1);
            const centerX = entry.x + dx * t;
            const centerY = entry.y + dy * t;
            const taper = 2 * Math.min(t, 1 - t);
            const amplitude = jagAmplitude > 0 ? jagAmplitude : 0;
            const offset = (randomFn() * 2 - 1) * amplitude * taper;
            result.push({
                x: centerX + perpendicularX * offset,
                y: centerY + perpendicularY * offset,
            });
        }
        return result;
    }

    function makeSeededRandom(seed) {
        let state = (seed >>> 0) || 1;
        return () => {
            state = (state + 0x6D2B79F5) >>> 0;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    function verticesFromXY(vertices) {
        return vertices.map(vertex => ({
            angle: Math.atan2(vertex.y, vertex.x),
            distance: Math.hypot(vertex.x, vertex.y),
        }));
    }

    /**
     * Centroidal moment of inertia for a uniform-density planar polygon.
     *
     * Uses the standard shoelace-derived formula:
     *   I_origin = (ρ/12) Σ |cross_i| (r_i² + r_i·r_{i+1} + r_{i+1}²)
     * where ρ = mass / area, then applies the parallel-axis correction:
     *   I_centroid = I_origin − mass * (cx² + cy²)
     *
     * The polygon is assumed to be in local (origin-centred) coordinates, so
     * the centroid offset is the centroid returned by polygonCentroid().
     *
     * Returns the disk approximation 0.5 * mass * radius^2 as a safe fallback
     * when the polygon is degenerate or has too few vertices.
     *
     * @param {Array<{x:number,y:number}>} vertices  – polygon in XY coordinates
     * @param {number} mass    – total mass of the polygon
     * @param {number} radius  – equivalent disk radius used as fallback
     */
    function polygonMomentOfInertia(vertices, mass, radius) {
        if (!vertices || vertices.length < 3 || !(mass > 0)) {
            return 0.5 * mass * radius * radius;
        }
        const n = vertices.length;
        let area = 0;
        let Iorigin = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < n; i++) {
            const next = (i + 1) % n;
            const xi = vertices[i].x, yi = vertices[i].y;
            const xj = vertices[next].x, yj = vertices[next].y;
            const cross = xi * yj - xj * yi;
            area += cross;
            Iorigin += cross * (xi * xi + xi * xj + xj * xj + yi * yi + yi * yj + yj * yj);
            cx += (xi + xj) * cross;
            cy += (yi + yj) * cross;
        }
        area *= 0.5;
        if (Math.abs(area) < 1e-18) {
            return 0.5 * mass * radius * radius;
        }
        const density = mass / Math.abs(area);
        const Iorig = (density / 12) * Math.abs(Iorigin);
        cx /= 6 * area;
        cy /= 6 * area;
        // Parallel-axis theorem: shift from origin to centroid.
        const I = Iorig - mass * (cx * cx + cy * cy);
        // Guard against numerical noise yielding a slightly negative result.
        return Math.max(I, 0.5 * mass * radius * radius * 1e-6);
    }

    /**
     * Intersects a ray (origin + t*dir) with a polygon boundary and returns
     * the hit point closest to the polygon surface along the *incoming*
     * (negative-t) direction.  Used to find the actual contact point for
     * impact torque when a polygon asteroid is hit.
     *
     * The ray direction is the bullet travel direction; we look for the
     * intersection with the smallest non-positive t so the contact point is
     * on the entry face of the polygon.
     *
     * @param {Array<{x:number,y:number}>} polygon  – convex or concave polygon
     * @param {number} ox  – ray origin x (impact offset projected to contact plane)
     * @param {number} oy  – ray origin y
     * @param {number} dx  – ray direction x (unit vector, bullet travel direction)
     * @param {number} dy  – ray direction y
     * @returns {{ x:number, y:number }|null}  contact point, or null on miss
     */
    function polygonRayIntersect(polygon, ox, oy, dx, dy) {
        const n = polygon.length;
        if (n < 3) return null;
        let bestT = Infinity;
        let found = false;
        for (let i = 0; i < n; i++) {
            const next = (i + 1) % n;
            const ex = polygon[next].x - polygon[i].x;
            const ey = polygon[next].y - polygon[i].y;
            // denom = cross(dir, edge)
            const denom = dx * ey - dy * ex;
            if (Math.abs(denom) < 1e-18) continue;
            const fx = polygon[i].x - ox;
            const fy = polygon[i].y - oy;
            const t = (fx * ey - fy * ex) / denom;
            const u = (fx * dy - fy * dx) / denom;
            if (u >= 0 && u <= 1) {
                // We want the entry intersection: t should be <= 0 (bullet
                // travels toward the polygon), and as close to 0 as possible.
                if (t <= 1e-9 && t < bestT) {
                    bestT = t;
                    found = true;
                }
            }
        }
        if (!found) return null;
        return { x: ox + dx * bestT, y: oy + dy * bestT };
    }

    function effectiveSeparationEnergy(radius, config) {
        const blend = Math.max(0, Math.min(1, config.SEPARATION_ENERGY_SIZE_BLEND));
        const radiusRatio = radius / config.INITIAL_ASTEROID_RADIUS;
        const sizeMultiplier = (1 - blend) + blend * radiusRatio * radiusRatio;
        return Math.max(0, config.SEPARATION_ENERGY) * sizeMultiplier;
    }

    function separationAngleOffset(asteroid, impact, maxAngle) {
        const limit = Number.isFinite(maxAngle) ? Math.max(0, maxAngle) : 0;
        if (limit === 0) return 0;

        const seedFraction = ((asteroid.seed || 0) * 0x100000000) >>> 0;
        const bulletAngle = Number.isFinite(impact?.bulletAngle)
            ? impact.bulletAngle
            : 0;
        const offsetN = Number.isFinite(impact?.offsetN) ? impact.offsetN : 0;
        const seed = (seedFraction
            ^ (Math.floor((bulletAngle + 10) * 1e6) >>> 0)
            ^ (Math.floor((offsetN + 10) * 1e6) >>> 0)
            ^ 0xA511E9B3) >>> 0;
        return (makeSeededRandom(seed)() * 2 - 1) * limit;
    }

    function clampAsteroidMotion(
        velocityX,
        velocityY,
        rotationSpeed,
        maxSpeed,
        maxSpin) {
        if (maxSpeed > 0) {
            const speedSquared =
                velocityX * velocityX + velocityY * velocityY;
            const maxSpeedSquared = maxSpeed * maxSpeed;
            if (speedSquared > maxSpeedSquared) {
                const scale = maxSpeed / Math.sqrt(speedSquared);
                velocityX *= scale;
                velocityY *= scale;
            }
        }
        if (maxSpin > 0 && Math.abs(rotationSpeed) > maxSpin) {
            rotationSpeed = rotationSpeed > 0 ? maxSpin : -maxSpin;
        }
        return { velocityX, velocityY, rotationSpeed };
    }

    function calculateParentGeometry(asteroid, config) {
        const radius = asteroid.radius;
        const density = Math.max(1e-6, config.ASTEROID_DENSITY);
        // Area calibration cancels out of parent mass; effectivePi is still
        // needed to convert each fragment's area into its equivalent radius.
        const mass = density * radius * radius;
        let polygon = null;
        let area = 0;
        let effectivePi = Math.PI;
        const rawVerts = asteroid.vertices;
        if (config.FRACTURE_ENABLED
                && Array.isArray(rawVerts)
                && rawVerts.length >= 3) {
            // World-aligned offsets from the parent origin, not world positions.
            polygon = rawVerts.map(vertex => ({
                x: Math.cos(vertex.angle + asteroid.angle) * vertex.distance,
                y: Math.sin(vertex.angle + asteroid.angle) * vertex.distance,
            }));
            area = Math.abs(polygonArea(polygon));
            if (area > 0) {
                effectivePi = area / (radius * radius);
            } else {
                polygon = null;
            }
        }

        const inertia = polygon
            ? polygonMomentOfInertia(polygon, mass, radius)
            : 0.5 * mass * radius * radius;
        return { polygon, area, effectivePi, radius, mass, inertia };
    }

    function calculateImpactResponse(asteroid, impact, parent, config) {
        const { polygon, radius, mass, inertia } = parent;
        const offsetN = Math.max(-1, Math.min(1, impact?.offsetN ?? 0));
        let bulletAngle = impact?.bulletAngle;
        if (!Number.isFinite(bulletAngle)) {
            const speed = Math.hypot(asteroid.velocityX, asteroid.velocityY);
            bulletAngle = speed > 1e-9
                ? Math.atan2(asteroid.velocityY, asteroid.velocityX)
                : 0;
        }

        const directionX = Math.cos(bulletAngle);
        const directionY = Math.sin(bulletAngle);
        const normalX = -directionY;
        const normalY = directionX;
        const impactOffset = offsetN * radius;

        // Use the entry face along the bullet ray, or a circular contact if
        // geometry is missing or the ray misses the polygon.
        let contact = polygon && polygonRayIntersect(
            polygon, impactOffset * normalX, impactOffset * normalY,
            directionX, directionY);
        if (!contact) {
            const impactAlongDirection = -Math.sqrt(
                Math.max(0, radius * radius - impactOffset * impactOffset));
            contact = {
                x: impactAlongDirection * directionX + impactOffset * normalX,
                y: impactAlongDirection * directionY + impactOffset * normalY,
            };
        }

        const impulseMagnitude = mass * Math.max(0, config.DEFLECTION_KICK);
        const impulseX = impulseMagnitude * directionX;
        const impulseY = impulseMagnitude * directionY;
        const velocityX = asteroid.velocityX + impulseX / mass;
        const velocityY = asteroid.velocityY + impulseY / mass;
        const torque = contact.x * impulseY - contact.y * impulseX;
        const angularVelocity = (asteroid.rotationSpeed || 0) + torque / inertia;
        const separationEnergy = effectiveSeparationEnergy(radius, config);
        const sideSign = offsetN >= 0 ? 1 : -1;
        const separationX = sideSign * normalX;
        const separationY = sideSign * normalY;
        const separationRotation = separationAngleOffset(
            asteroid, impact, config.SEPARATION_ANGLE_VARIANCE);
        const separationCos = Math.cos(separationRotation);
        const separationSin = Math.sin(separationRotation);
        const momentumSeparationX =
            separationX * separationCos - separationY * separationSin;
        const momentumSeparationY =
            separationX * separationSin + separationY * separationCos;

        return {
            bulletAngle, offsetN, normalX, normalY, impactOffset,
            separationX, separationY, momentumSeparationX, momentumSeparationY,
            separationEnergy, velocityX, velocityY, angularVelocity,
            impulse: { x: impulseX, y: impulseY },
        };
    }

    function calculatePolygonFragment(polygon, area, parent, response) {
        const center = polygonCentroid(polygon);
        const radius = Math.sqrt(area / parent.effectivePi);
        const mass = (area / parent.area) * parent.mass;
        const centeredPolygon = polygon.map(point => ({
            x: point.x - center.x,
            y: point.y - center.y,
        }));
        return {
            r: radius,
            m: mass,
            inertia: polygonMomentOfInertia(centeredPolygon, mass, radius),
            cx: center.x,
            cy: center.y,
            vx: response.velocityX - response.angularVelocity * center.y,
            vy: response.velocityY + response.angularVelocity * center.x,
            omega: response.angularVelocity,
            vertices: verticesFromXY(centeredPolygon),
        };
    }

    function calculatePolygonChildren(asteroid, parent, response, config) {
        if (!parent.polygon) return null;
        const { polygon, area: parentArea, effectivePi, radius, mass } = parent;
        const {
            bulletAngle, offsetN, normalX, normalY, impactOffset,
            separationX, separationY, momentumSeparationX, momentumSeparationY,
            separationEnergy,
        } = response;
        const normal = { x: normalX, y: normalY };
        const probe = fractureSplitPolygon(polygon, normal, impactOffset, []);
        if (!probe) return null;

        const chordLength = Math.hypot(
            probe.exit.x - probe.entry.x, probe.exit.y - probe.entry.y);
        const parentSpacing = (2 * Math.PI * radius) / Math.max(1, polygon.length);
        const fractureDensity = Math.max(0, config.FRACTURE_VERTEX_DENSITY);
        const jagCount = parentSpacing > 0
            ? Math.max(0, Math.floor((chordLength / parentSpacing) * fractureDensity))
            : 0;
        const jagAmplitude = Math.max(0, config.FRACTURE_JAGGEDNESS) * radius;
        const seedFraction = ((asteroid.seed || 0) * 0x100000000) >>> 0;
        const jagSeed = (seedFraction
            ^ (Math.floor((bulletAngle + 10) * 1e6) >>> 0)
            ^ (Math.floor((offsetN + 10) * 1e6) >>> 0)) >>> 0;
        const jagPath = buildFracturePolyline(
            probe.entry, probe.exit, jagCount, jagAmplitude, makeSeededRandom(jagSeed));
        const split = fractureSplitPolygon(polygon, normal, impactOffset, jagPath);
        if (!split) return null;

        const positiveArea = Math.abs(polygonArea(split.positive));
        const negativeArea = Math.abs(polygonArea(split.negative));
        if (!(positiveArea > 0 && negativeArea > 0 && parentArea > 0)) return null;

        const positiveIsSmall = positiveArea <= negativeArea;
        const small = calculatePolygonFragment(
            positiveIsSmall ? split.positive : split.negative,
            positiveIsSmall ? positiveArea : negativeArea, parent, response);
        const large = calculatePolygonFragment(
            positiveIsSmall ? split.negative : split.positive,
            positiveIsSmall ? negativeArea : positiveArea, parent, response);
        const fracture = { parentArea, positiveArea, negativeArea, effectivePi };
        if (small.r < config.MIN_ASTEROID_RADIUS) {
            return { children: [large], fracture };
        }

        const separationSpeed = separationEnergy > 0
            ? Math.sqrt(2 * separationEnergy * large.m / (small.m * mass))
            : 0;
        const projection = small.cx * separationX + small.cy * separationY;
        const separationDirection = projection >= 0 ? 1 : -1;
        const fragmentSeparationX = separationDirection * momentumSeparationX;
        const fragmentSeparationY = separationDirection * momentumSeparationY;
        small.vx += fragmentSeparationX * separationSpeed;
        small.vy += fragmentSeparationY * separationSpeed;
        large.vx -= fragmentSeparationX * separationSpeed * (small.m / large.m);
        large.vy -= fragmentSeparationY * separationSpeed * (small.m / large.m);
        return { children: [small, large], fracture };
    }

    function calculateDiskChildren(parent, response, config) {
        const { radius, mass } = parent;
        const {
            offsetN, separationX, separationY, momentumSeparationX, momentumSeparationY,
            separationEnergy, velocityX, velocityY, angularVelocity,
        } = response;
        const minimumRatio = Math.max(0.01, Math.min(0.5, config.MIN_SPLIT_RATIO));
        const massBias = Math.max(0, Math.min(1, config.MASS_SPLIT_BIAS));
        const smallFraction = Math.max(
            minimumRatio, 0.5 * (1 - massBias * Math.abs(offsetN)));
        const largeFraction = 1 - smallFraction;
        const smallRadius = radius * Math.sqrt(smallFraction);
        const largeRadius = radius * Math.sqrt(largeFraction);
        const smallMass = smallFraction * mass;
        const largeMass = largeFraction * mass;

        if (smallRadius < config.MIN_ASTEROID_RADIUS) {
            return [{
                r: largeRadius,
                m: largeMass,
                cx: 0,
                cy: 0,
                vx: velocityX,
                vy: velocityY,
                omega: angularVelocity,
                vertices: null,
            }];
        }

        const smallDistance = radius * largeFraction;
        const largeDistance = -radius * smallFraction;
        const rigidVelocityAt = distance => ({
            x: velocityX - angularVelocity * distance * separationY,
            y: velocityY + angularVelocity * distance * separationX,
        });
        const smallRigidVelocity = rigidVelocityAt(smallDistance);
        const largeRigidVelocity = rigidVelocityAt(largeDistance);
        const separationSpeed = separationEnergy > 0
            ? Math.sqrt(2 * separationEnergy * largeMass / (smallMass * mass))
            : 0;
        return [
            {
                r: smallRadius,
                m: smallMass,
                cx: smallDistance * separationX,
                cy: smallDistance * separationY,
                vx: smallRigidVelocity.x + separationSpeed * momentumSeparationX,
                vy: smallRigidVelocity.y + separationSpeed * momentumSeparationY,
                omega: angularVelocity,
                vertices: null,
            },
            {
                r: largeRadius,
                m: largeMass,
                cx: largeDistance * separationX,
                cy: largeDistance * separationY,
                vx: largeRigidVelocity.x
                    - separationSpeed * momentumSeparationX * (smallMass / largeMass),
                vy: largeRigidVelocity.y
                    - separationSpeed * momentumSeparationY * (smallMass / largeMass),
                omega: angularVelocity,
                vertices: null,
            },
        ];
    }

    function calculateAsteroidFragments(asteroid, impact, config) {
        const parent = calculateParentGeometry(asteroid, config);
        const response = calculateImpactResponse(asteroid, impact, parent, config);
        const polygonResult = calculatePolygonChildren(asteroid, parent, response, config);
        return {
            children: polygonResult
                ? polygonResult.children
                : calculateDiskChildren(parent, response, config),
            mass: parent.mass,
            inertia: parent.inertia,
            impulse: response.impulse,
            postImpulse: {
                velocityX: response.velocityX,
                velocityY: response.velocityY,
                angularVelocity: response.angularVelocity,
            },
            fracture: polygonResult ? polygonResult.fracture : null,
        };
    }

    /**
     * Returns the aspect severity for a viewport: max(w,h)/min(w,h).
     * Portrait and landscape reciprocals (e.g. 16:9 and 9:16) produce the
     * same value. Square viewports return 1.
     * @param {number} width  viewport width in any consistent unit
     * @param {number} height viewport height in the same unit
     * @returns {number} severity >= 1
     */
    function getAspectSeverity(width, height) {
        const shortEdge = Math.max(1, Math.min(width, height));
        const longEdge = Math.max(width, height);
        return longEdge / shortEdge;
    }

    /**
     * Compute asteroid radius and speed scaling factors from aspect severity,
     * a difficulty factor, and a balance parameter in [0, 1].
     *
     *   combinedFactor = aspectSeverity * difficultyFactor
     *   radiusScale = combinedFactor ** (1 - balance)
     *   speedScale  = combinedFactor ** balance
     *
     * Invariant: radiusScale * speedScale === combinedFactor (within float tolerance).
     *
     * balance = 0 → size-only compensation (radiusScale = combinedFactor, speedScale = 1).
     * balance = 0.5 → equal geometric split (both scales = sqrt(combinedFactor)).
     * balance = 1 → speed-only compensation (radiusScale = 1, speedScale = combinedFactor).
     *
     * @param {number} aspectSeverity  result of getAspectSeverity(), >= 1
     * @param {number} balance         value clamped to [0, 1]
     * @param {number} difficultyFactor multiplier clamped to [0.01, 2]; defaults to 1
     * @returns {{ radiusScale: number, speedScale: number }}
     */
    function getAsteroidAspectScales(aspectSeverity, balance, difficultyFactor = 1) {
        const clampedBalance = Math.max(0, Math.min(1, Number.isFinite(balance) ? balance : 0.5));
        const severity = Math.max(1, Number.isFinite(aspectSeverity) ? aspectSeverity : 1);
        const difficulty = Math.max(0.01, Math.min(
            2, Number.isFinite(difficultyFactor) ? difficultyFactor : 1));
        const combinedFactor = severity * difficulty;
        return {
            radiusScale: Math.pow(combinedFactor, 1 - clampedBalance),
            speedScale: Math.pow(combinedFactor, clampedBalance),
        };
    }

    return Object.freeze({
        polygonArea,
        polygonCentroid,
        polygonMomentOfInertia,
        polygonRayIntersect,
        fractureSplitPolygon,
        buildFracturePolyline,
        makeSeededRandom,
        verticesFromXY,
        effectiveSeparationEnergy,
        separationAngleOffset,
        clampAsteroidMotion,
        calculateAsteroidFragments,
        getAspectSeverity,
        getAsteroidAspectScales,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsFracture;
}
