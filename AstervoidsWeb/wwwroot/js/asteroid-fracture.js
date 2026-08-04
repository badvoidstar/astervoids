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

    function calculateAsteroidFragments(asteroid, impact, config) {
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
        const radius = asteroid.radius;
        const density = Math.max(1e-6, config.ASTEROID_DENSITY);
        const mass = density * radius * radius;
        const inertia = 0.5 * mass * radius * radius;
        const impactOffset = offsetN * radius;
        const impactAlongDirection = -Math.sqrt(
            Math.max(0, radius * radius - impactOffset * impactOffset));
        const impactX = impactAlongDirection * directionX + impactOffset * normalX;
        const impactY = impactAlongDirection * directionY + impactOffset * normalY;
        const impulseMagnitude = mass * Math.max(0, config.DEFLECTION_KICK);
        const impulseX = impulseMagnitude * directionX;
        const impulseY = impulseMagnitude * directionY;
        const velocityX = asteroid.velocityX + impulseX / mass;
        const velocityY = asteroid.velocityY + impulseY / mass;
        const torque = impactX * impulseY - impactY * impulseX;
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

        let children = null;
        let fracture = null;
        if (config.FRACTURE_ENABLED) {
            const parentPolygon = asteroid.vertices.map(vertex => ({
                x: Math.cos(vertex.angle + asteroid.angle) * vertex.distance,
                y: Math.sin(vertex.angle + asteroid.angle) * vertex.distance,
            }));
            const parentArea = Math.abs(polygonArea(parentPolygon));
            const effectivePi = parentArea > 0
                ? parentArea / (radius * radius)
                : Math.PI;
            const probe = fractureSplitPolygon(
                parentPolygon, { x: normalX, y: normalY }, impactOffset, []);
            if (probe) {
                const chordLength = Math.hypot(
                    probe.exit.x - probe.entry.x,
                    probe.exit.y - probe.entry.y);
                const parentSpacing =
                    (2 * Math.PI * radius) / Math.max(1, parentPolygon.length);
                const fractureDensity = Math.max(0, config.FRACTURE_VERTEX_DENSITY);
                const jagCount = parentSpacing > 0
                    ? Math.max(0, Math.floor(
                        (chordLength / parentSpacing) * fractureDensity))
                    : 0;
                const jagAmplitude =
                    Math.max(0, config.FRACTURE_JAGGEDNESS) * radius;
                const seedFraction = ((asteroid.seed || 0) * 0x100000000) >>> 0;
                const jagSeed = (seedFraction
                    ^ (Math.floor((bulletAngle + 10) * 1e6) >>> 0)
                    ^ (Math.floor((offsetN + 10) * 1e6) >>> 0)) >>> 0;
                const jagPath = buildFracturePolyline(
                    probe.entry,
                    probe.exit,
                    jagCount,
                    jagAmplitude,
                    makeSeededRandom(jagSeed));
                const split = fractureSplitPolygon(
                    parentPolygon,
                    { x: normalX, y: normalY },
                    impactOffset,
                    jagPath);
                if (split) {
                    const positiveArea = Math.abs(polygonArea(split.positive));
                    const negativeArea = Math.abs(polygonArea(split.negative));
                    if (positiveArea > 0 && negativeArea > 0 && parentArea > 0) {
                        fracture = {
                            parentArea,
                            positiveArea,
                            negativeArea,
                            effectivePi,
                        };
                        const smallSide = positiveArea <= negativeArea
                            ? { polygon: split.positive, area: positiveArea }
                            : { polygon: split.negative, area: negativeArea };
                        const largeSide = positiveArea <= negativeArea
                            ? { polygon: split.negative, area: negativeArea }
                            : { polygon: split.positive, area: positiveArea };
                        const smallCenter = polygonCentroid(smallSide.polygon);
                        const largeCenter = polygonCentroid(largeSide.polygon);
                        const smallRadius = Math.sqrt(smallSide.area / effectivePi);
                        const largeRadius = Math.sqrt(largeSide.area / effectivePi);
                        const smallMass = (smallSide.area / parentArea) * mass;
                        const largeMass = (largeSide.area / parentArea) * mass;
                        const recenter = (polygon, center) => verticesFromXY(
                            polygon.map(point => ({
                                x: point.x - center.x,
                                y: point.y - center.y,
                            })));
                        const smallVertices = recenter(
                            smallSide.polygon, smallCenter);
                        const largeVertices = recenter(
                            largeSide.polygon, largeCenter);

                        if (smallRadius < config.MIN_ASTEROID_RADIUS) {
                            children = [{
                                r: largeRadius,
                                m: largeMass,
                                cx: largeCenter.x,
                                cy: largeCenter.y,
                                vx: velocityX - angularVelocity * largeCenter.y,
                                vy: velocityY + angularVelocity * largeCenter.x,
                                omega: angularVelocity,
                                vertices: largeVertices,
                            }];
                        } else {
                            const smallRigidVelocity = {
                                x: velocityX - angularVelocity * smallCenter.y,
                                y: velocityY + angularVelocity * smallCenter.x,
                            };
                            const largeRigidVelocity = {
                                x: velocityX - angularVelocity * largeCenter.y,
                                y: velocityY + angularVelocity * largeCenter.x,
                            };
                            const separationSpeed = separationEnergy > 0
                                ? Math.sqrt(
                                    2 * separationEnergy * largeMass
                                    / (smallMass * mass))
                                : 0;
                            const projection =
                                smallCenter.x * separationX
                                + smallCenter.y * separationY;
                            const separationDirection = projection >= 0 ? 1 : -1;
                            const fragmentSeparationX =
                                separationDirection * momentumSeparationX;
                            const fragmentSeparationY =
                                separationDirection * momentumSeparationY;
                            children = [
                                {
                                    r: smallRadius,
                                    m: smallMass,
                                    cx: smallCenter.x,
                                    cy: smallCenter.y,
                                    vx: smallRigidVelocity.x
                                        + fragmentSeparationX * separationSpeed,
                                    vy: smallRigidVelocity.y
                                        + fragmentSeparationY * separationSpeed,
                                    omega: angularVelocity,
                                    vertices: smallVertices,
                                },
                                {
                                    r: largeRadius,
                                    m: largeMass,
                                    cx: largeCenter.x,
                                    cy: largeCenter.y,
                                    vx: largeRigidVelocity.x
                                        - fragmentSeparationX * separationSpeed
                                        * (smallMass / largeMass),
                                    vy: largeRigidVelocity.y
                                        - fragmentSeparationY * separationSpeed
                                        * (smallMass / largeMass),
                                    omega: angularVelocity,
                                    vertices: largeVertices,
                                },
                            ];
                        }
                    }
                }
            }
        }

        if (!children) {
            const minimumRatio = Math.max(
                0.01, Math.min(0.5, config.MIN_SPLIT_RATIO));
            const massBias = Math.max(
                0, Math.min(1, config.MASS_SPLIT_BIAS));
            const smallFraction = Math.max(
                minimumRatio,
                0.5 * (1 - massBias * Math.abs(offsetN)));
            const largeFraction = 1 - smallFraction;
            const smallRadius = radius * Math.sqrt(smallFraction);
            const largeRadius = radius * Math.sqrt(largeFraction);
            const smallMass = smallFraction * mass;
            const largeMass = largeFraction * mass;

            if (smallRadius < config.MIN_ASTEROID_RADIUS) {
                children = [{
                    r: largeRadius,
                    m: largeMass,
                    cx: 0,
                    cy: 0,
                    vx: velocityX,
                    vy: velocityY,
                    omega: angularVelocity,
                    vertices: null,
                }];
            } else {
                const smallDistance = radius * largeFraction;
                const largeDistance = -radius * smallFraction;
                const rigidVelocityAt = distance => ({
                    x: velocityX - angularVelocity * distance * separationY,
                    y: velocityY + angularVelocity * distance * separationX,
                });
                const smallRigidVelocity = rigidVelocityAt(smallDistance);
                const largeRigidVelocity = rigidVelocityAt(largeDistance);
                const separationSpeed = separationEnergy > 0
                    ? Math.sqrt(
                        2 * separationEnergy * largeMass / (smallMass * mass))
                    : 0;
                children = [
                    {
                        r: smallRadius,
                        m: smallMass,
                        cx: smallDistance * separationX,
                        cy: smallDistance * separationY,
                        vx: smallRigidVelocity.x
                            + separationSpeed * momentumSeparationX,
                        vy: smallRigidVelocity.y
                            + separationSpeed * momentumSeparationY,
                        omega: angularVelocity,
                        vertices: null,
                    },
                    {
                        r: largeRadius,
                        m: largeMass,
                        cx: largeDistance * separationX,
                        cy: largeDistance * separationY,
                        vx: largeRigidVelocity.x
                            - separationSpeed * momentumSeparationX
                            * (smallMass / largeMass),
                        vy: largeRigidVelocity.y
                            - separationSpeed * momentumSeparationY
                            * (smallMass / largeMass),
                        omega: angularVelocity,
                        vertices: null,
                    },
                ];
            }
        }

        return {
            children,
            mass,
            inertia,
            impulse: { x: impulseX, y: impulseY },
            postImpulse: {
                velocityX,
                velocityY,
                angularVelocity,
            },
            fracture,
        };
    }

    return Object.freeze({
        polygonArea,
        polygonCentroid,
        fractureSplitPolygon,
        buildFracturePolyline,
        makeSeededRandom,
        verticesFromXY,
        effectiveSeparationEnergy,
        separationAngleOffset,
        clampAsteroidMotion,
        calculateAsteroidFragments,
    });
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AstervoidsFracture;
}
