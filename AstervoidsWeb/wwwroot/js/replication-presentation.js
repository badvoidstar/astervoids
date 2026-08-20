/**
 * Reusable presentation-time policies for replicated records.
 */
const ReplicationPresentation = (function () {
    function createMemberDelay(config) {
        return {
            packetIntervals: [],
            lagSamples: [],
            computedDelay: config.INTERPOLATION_DELAY,
            lastServerTimestamp: 0,
            lastValidAt: 0,
            remoteSendInterval: 0
        };
    }

    function recomputeAdaptiveDelay(delay, config, rttMs = 0) {
        const minSamples = config.ADAPTIVE_DELAY_MIN_SAMPLES;
        if (delay.lagSamples.length >= minSamples) {
            const lagMean = delay.lagSamples.reduce((sum, value) => sum + value, 0)
                / delay.lagSamples.length;
            const lagVariance = delay.lagSamples.reduce(
                (sum, value) => sum + (value - lagMean) ** 2,
                0) / delay.lagSamples.length;
            let intervalStddev = 0;
            if (delay.packetIntervals.length >= minSamples) {
                const intervalMean = delay.packetIntervals.reduce(
                    (sum, value) => sum + value,
                    0) / delay.packetIntervals.length;
                const intervalVariance = delay.packetIntervals.reduce(
                    (sum, value) => sum + (value - intervalMean) ** 2,
                    0) / delay.packetIntervals.length;
                intervalStddev = Math.sqrt(intervalVariance);
            }
            const rawDelay = Math.max(
                config.ADAPTIVE_DELAY_MIN,
                lagMean
                    + config.ADAPTIVE_DELAY_JITTER_MULT * Math.sqrt(lagVariance)
                    + intervalStddev);
            delay.computedDelay += config.ADAPTIVE_DELAY_SMOOTHING
                * (rawDelay - delay.computedDelay);
            return;
        }

        if (delay.packetIntervals.length < minSamples) return;
        const observedMean = delay.packetIntervals.reduce(
            (sum, value) => sum + value,
            0) / delay.packetIntervals.length;
        const variance = delay.packetIntervals.reduce(
            (sum, value) => sum + (value - observedMean) ** 2,
            0) / delay.packetIntervals.length;
        const mean = delay.remoteSendInterval > 0
            ? delay.remoteSendInterval
            : observedMean;
        const networkFactor = Math.min(
            1,
            config.ADAPTIVE_DELAY_NET_FLOOR
                + rttMs / (config.ADAPTIVE_DELAY_NET_SCALE * mean));
        const rawDelay = Math.max(
            config.ADAPTIVE_DELAY_MIN,
            mean * networkFactor
                + config.ADAPTIVE_DELAY_JITTER_MULT * Math.sqrt(variance));
        delay.computedDelay += config.ADAPTIVE_DELAY_SMOOTHING
            * (rawDelay - delay.computedDelay);
    }

    function createAdaptiveDelayPolicy(options) {
        const config = options?.config;
        const getRttMs = options?.getRttMs;
        if (!config) throw new TypeError('config is required');
        if (typeof getRttMs !== 'function') {
            throw new TypeError('getRttMs must be a function');
        }

        const memberDelays = new Map();

        function getMemberDelay(memberId) {
            let delay = memberDelays.get(memberId);
            if (!delay) {
                delay = createMemberDelay(config);
                memberDelays.set(memberId, delay);
            }
            return delay;
        }

        function recompute(delay) {
            recomputeAdaptiveDelay(delay, config, getRttMs() || 0);
        }

        function recordPacketInterval(delay, interval) {
            delay.packetIntervals.push(interval);
            if (delay.packetIntervals.length > config.ADAPTIVE_DELAY_SAMPLES) {
                delay.packetIntervals.shift();
            }
            recompute(delay);
        }

        function recordObjectSample(memberId, validAt, arrivalServerTime) {
            if (!config.ADAPTIVE_DELAY_ENABLED) return;
            if (!memberId || validAt == null || arrivalServerTime == null) return;
            const delay = getMemberDelay(memberId);
            const lag = arrivalServerTime - validAt;
            if (!Number.isFinite(lag) || lag < 0 || lag > 5000) return;
            delay.lagSamples.push(lag);
            if (delay.lagSamples.length > config.ADAPTIVE_DELAY_SAMPLES) {
                delay.lagSamples.shift();
            }
            if (delay.lastValidAt > 0) {
                const interval = validAt - delay.lastValidAt;
                if (interval > 0 && interval < 5000) {
                    recordPacketInterval(delay, interval);
                } else {
                    recompute(delay);
                }
            } else {
                recompute(delay);
            }
            delay.lastValidAt = validAt;
        }

        return {
            memberDelays,
            createMemberDelay: () => createMemberDelay(config),
            getMemberDelay,
            recordPacketInterval,
            recordObjectSample,
            recomputeAdaptiveDelay: recompute,
            getDelayForMember(memberId) {
                if (!config.ADAPTIVE_DELAY_ENABLED) {
                    return config.INTERPOLATION_DELAY;
                }
                const delay = memberId ? memberDelays.get(memberId) : null;
                return delay ? delay.computedDelay : config.INTERPOLATION_DELAY;
            },
            getDelay() {
                if (!config.ADAPTIVE_DELAY_ENABLED) {
                    return config.INTERPOLATION_DELAY;
                }
                let maximum = config.ADAPTIVE_DELAY_MIN;
                for (const delay of memberDelays.values()) {
                    if (delay.computedDelay > maximum) {
                        maximum = delay.computedDelay;
                    }
                }
                return maximum;
            },
            removeMember(memberId) {
                memberDelays.delete(memberId);
            },
            clear() {
                memberDelays.clear();
            }
        };
    }

    // Keep full-rate prediction through the expected next packet, while
    // reserving a bounded tail in which stale turn intent can decelerate.
    function calculateRateAngularPredictionWindow(options = {}) {
        const targetFps = Number.isFinite(options.targetFps) && options.targetFps > 0
            ? options.targetFps
            : 60;
        const minimumFrames = Number.isFinite(options.minimumFrames)
            ? Math.max(0, options.minimumFrames)
            : 0;
        const maximumFrames = Number.isFinite(options.maximumFrames)
            ? Math.max(0, options.maximumFrames)
            : minimumFrames;
        const configuredTaperFrames = Number.isFinite(options.taperFrames)
            ? Math.max(0, options.taperFrames)
            : 0;
        const taperFrames = Math.min(configuredTaperFrames, maximumFrames);
        const maximumFullFrames = Math.max(0, maximumFrames - taperFrames);
        const minimumFullFrames = Math.min(minimumFrames, maximumFullFrames);

        const intervals = Array.isArray(options.packetIntervals)
            ? options.packetIntervals.filter(value => Number.isFinite(value) && value > 0)
            : [];
        const intervalMean = intervals.length > 0
            ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
            : 0;
        const intervalVariance = intervals.length > 0
            ? intervals.reduce(
                (sum, value) => sum + (value - intervalMean) ** 2,
                0) / intervals.length
            : 0;
        const intervalJitterMs = Math.sqrt(intervalVariance);
        const senderIntervalMs = Number.isFinite(options.senderIntervalMs)
            ? Math.max(0, options.senderIntervalMs)
            : 0;
        const heartbeatMs = Number.isFinite(options.heartbeatMs)
            ? Math.max(0, options.heartbeatMs)
            : 0;
        const measuredJitterMs = Number.isFinite(options.jitterMs)
            ? Math.max(0, options.jitterMs)
            : 0;
        const jitterMultiplier = Number.isFinite(options.jitterMultiplier)
            ? Math.max(0, options.jitterMultiplier)
            : 0;

        const cadenceMs = Math.max(
            heartbeatMs,
            senderIntervalMs,
            intervalMean);
        const jitterMs = Math.max(measuredJitterMs, intervalJitterMs);
        const desiredFullFrames =
            (cadenceMs + jitterMultiplier * jitterMs) * targetFps / 1000;
        const fullFrames = Math.max(
            minimumFullFrames,
            Math.min(maximumFullFrames, desiredFullFrames));

        return {
            fullFrames,
            taperFrames: Math.min(taperFrames, maximumFrames - fullFrames)
        };
    }

    // Integral of a turn scale that is 1 through fullFrames, falls linearly to
    // 0 through taperFrames, and remains 0 afterward.
    function integrateRateAngularPredictionFrames(elapsedFrames, window) {
        const elapsed = Number.isFinite(elapsedFrames)
            ? Math.max(0, elapsedFrames)
            : 0;
        if (!window) return elapsed;
        const fullFrames = Number.isFinite(window.fullFrames)
            ? Math.max(0, window.fullFrames)
            : 0;
        const taperFrames = Number.isFinite(window.taperFrames)
            ? Math.max(0, window.taperFrames)
            : 0;
        if (elapsed <= fullFrames) return elapsed;
        if (taperFrames <= 0) return fullFrames;
        const taperElapsed = Math.min(elapsed - fullFrames, taperFrames);
        return fullFrames
            + taperElapsed
            - (taperElapsed * taperElapsed) / (2 * taperFrames);
    }

    function averageRateAngularPredictionScale(startFrame, endFrame, window) {
        if (!window) return 1;
        const start = Number.isFinite(startFrame) ? Math.max(0, startFrame) : 0;
        const end = Number.isFinite(endFrame) ? Math.max(start, endFrame) : start;
        if (end <= start) return 0;
        return (integrateRateAngularPredictionFrames(end, window)
            - integrateRateAngularPredictionFrames(start, window))
            / (end - start);
    }

    function createDeadReckoningPolicy(options) {
        const config = options?.config;
        const nowMs = options?.nowMs;
        const velocityToDeltaX = options?.velocityToDeltaX;
        const velocityToDeltaY = options?.velocityToDeltaY;
        const shortestAngleDelta = options?.shortestAngleDelta;
        const createState = options?.createState;
        const isRotationTarget = options?.isRotationTarget || (() => false);
        const shouldReplay = options?.shouldReplay || (() => false);
        const getAngularPredictionWindow =
            options?.getAngularPredictionWindow || (() => null);
        const replay = options?.replay;
        if (!config) throw new TypeError('config is required');
        if (typeof nowMs !== 'function') throw new TypeError('nowMs must be a function');
        if (typeof velocityToDeltaX !== 'function') {
            throw new TypeError('velocityToDeltaX must be a function');
        }
        if (typeof velocityToDeltaY !== 'function') {
            throw new TypeError('velocityToDeltaY must be a function');
        }
        if (typeof shortestAngleDelta !== 'function') {
            throw new TypeError('shortestAngleDelta must be a function');
        }
        if (typeof createState !== 'function') {
            throw new TypeError('createState must be a function');
        }
        if (typeof getAngularPredictionWindow !== 'function') {
            throw new TypeError('getAngularPredictionWindow must be a function');
        }

        const states = new Map();
        const lastVersions = new Map();
        const smooth = new Map();
        const replayCache = new WeakMap();
        const replayContext = { replayCache, scratch: null };

        const policy = {
            states,
            lastVersions,
            smooth,
            replayCache,

            updateState(
                id,
                data,
                baselinePerf,
                snap,
                preserveDirection = false,
                stateContext = null) {
                const now = nowMs();
                const displayed = (!snap && states.has(id))
                    ? policy._reckonAt(id, now)
                    : null;
                const recvPerf = (typeof baselinePerf === 'number'
                    && Number.isFinite(baselinePerf))
                    ? baselinePerf
                    : now;
                states.set(id, createState(data, recvPerf, stateContext));

                let tau = config.DEADRECKON_SMOOTH_MS;
                if (displayed && tau > 0) {
                    const fresh = policy._reckonRaw(id, now);
                    if (fresh) {
                        let dx = displayed.x - fresh.x;
                        let dy = displayed.y - fresh.y;
                        let da = (displayed.angle != null && fresh.angle != null)
                            ? shortestAngleDelta(displayed.angle, fresh.angle)
                            : 0;
                        const snapDist = config.DEADRECKON_SNAP_DIST;
                        if (Math.abs(dx) > snapDist || Math.abs(dy) > snapDist) {
                            dx = 0;
                            dy = 0;
                        }
                        if (dx !== 0 || dy !== 0 || da !== 0) {
                            if (preserveDirection) {
                                const state = states.get(id);
                                const stepMs = 1000 / config.TARGET_FPS;
                                const motionX = velocityToDeltaX(state.velocityX || 0);
                                const motionY = velocityToDeltaY(state.velocityY || 0);
                                const motion = Math.hypot(motionX, motionY);
                                if (motion > 1e-12) {
                                    const correctionAlong =
                                        (dx * motionX + dy * motionY) / motion;
                                    if (correctionAlong > 0) {
                                        tau = Math.max(
                                            tau,
                                            correctionAlong * stepMs / motion);
                                    }
                                }
                                const angularMotion = state.rotationSpeed || 0;
                                if (Math.abs(angularMotion) > 1e-12
                                    && Math.sign(da) === Math.sign(angularMotion)) {
                                    tau = Math.max(
                                        tau,
                                        Math.abs(da) * stepMs / Math.abs(angularMotion));
                                }
                                tau *= 1.05;
                            }
                            smooth.set(id, { dx, dy, da, t0: now, tauMs: tau });
                            return;
                        }
                    }
                }
                smooth.delete(id);
            },

            _reckonRaw(id, nowPerf) {
                const state = states.get(id);
                if (!state) return null;
                const stepMs = 1000 / config.TARGET_FPS;
                let frames = stepMs > 0 ? (nowPerf - state.recvPerf) / stepMs : 0;
                if (!(frames > 0)) frames = 0;
                if (frames > config.DEADRECKON_MAX_FRAMES) {
                    frames = config.DEADRECKON_MAX_FRAMES;
                }
                const out = {
                    x: state.x,
                    y: state.y,
                    velocityX: state.velocityX,
                    velocityY: state.velocityY,
                    rotationSpeed: state.rotationSpeed
                };
                if (frames > 0) {
                    out.x = state.x + velocityToDeltaX(state.velocityX) * frames;
                    out.y = state.y + velocityToDeltaY(state.velocityY) * frames;
                }
                const targetMode = isRotationTarget(state);
                const angularPredictionWindow = state.clampAngular
                    ? getAngularPredictionWindow(state)
                    : null;
                if (state.angle !== null) {
                    if (targetMode) {
                        out.angle = state.angle;
                    } else {
                        const angularFrames = angularPredictionWindow
                            ? integrateRateAngularPredictionFrames(
                                frames, angularPredictionWindow)
                            : frames;
                        out.angle = state.angle + state.rotationSpeed * angularFrames;
                    }
                }
                if (shouldReplay(state) && typeof replay === 'function') {
                    replay(
                        state,
                        frames,
                        out,
                        targetMode,
                        replayContext,
                        angularPredictionWindow);
                }
                return out;
            },

            _replayShip(state, frames, out, targetMode) {
                if (typeof replay === 'function') {
                    replay(
                        state,
                        frames,
                        out,
                        targetMode,
                        replayContext,
                        getAngularPredictionWindow(state));
                }
            },

            _reckonAt(id, nowPerf) {
                const out = policy._reckonRaw(id, nowPerf);
                if (!out) return null;
                const correction = smooth.get(id);
                if (correction) {
                    const tau = correction.tauMs || config.DEADRECKON_SMOOTH_MS;
                    const k = tau > 0
                        ? Math.exp(-(nowPerf - correction.t0) / tau)
                        : 0;
                    if (k <= 1e-3) {
                        smooth.delete(id);
                    } else {
                        out.x += correction.dx * k;
                        out.y += correction.dy * k;
                        if (out.angle !== undefined) {
                            out.angle += correction.da * k;
                        }
                    }
                }
                return out;
            },

            getReckoned(id) {
                return policy._reckonAt(id, nowMs());
            },

            getResting(id) {
                const state = states.get(id);
                if (!state) return null;
                const out = {
                    x: state.x,
                    y: state.y,
                    velocityX: state.velocityX,
                    velocityY: state.velocityY,
                    rotationSpeed: state.rotationSpeed
                };
                if (state.angle !== null) out.angle = state.angle;
                return out;
            },

            remove(id) {
                states.delete(id);
                lastVersions.delete(id);
                smooth.delete(id);
            },

            clear() {
                states.clear();
                lastVersions.clear();
                smooth.clear();
            }
        };
        return policy;
    }

    function hermiteBasis(t) {
        const t2 = t * t;
        const t3 = t2 * t;
        return {
            h00: 2 * t3 - 3 * t2 + 1,
            h10: t3 - 2 * t2 + t,
            h01: -2 * t3 + 3 * t2,
            h11: t3 - t2
        };
    }

    /**
     * Build a scalar quintic trajectory with continuous position, velocity,
     * and acceleration at both ends. Velocities are expressed per millisecond.
     */
    function createMinimumJerkTransition({
        start,
        target,
        startVelocity = 0,
        targetVelocity = 0,
        startAcceleration = 0,
        targetAcceleration = 0,
        startTime,
        endTime
    }) {
        for (const [name, value] of Object.entries({
            start,
            target,
            startVelocity,
            targetVelocity,
            startAcceleration,
            targetAcceleration,
            startTime,
            endTime
        })) {
            if (!Number.isFinite(value)) {
                throw new TypeError(`${name} must be finite`);
            }
        }
        if (!(endTime > startTime)) {
            throw new RangeError('endTime must be greater than startTime');
        }

        const duration = endTime - startTime;
        const duration2 = duration * duration;
        const delta = target - start;
        const c0 = start;
        const c1 = startVelocity * duration;
        const c2 = startAcceleration * duration2 / 2;
        const c3 = 10 * delta
            - (6 * startVelocity + 4 * targetVelocity) * duration
            - (1.5 * startAcceleration - 0.5 * targetAcceleration) * duration2;
        const c4 = -15 * delta
            + (8 * startVelocity + 7 * targetVelocity) * duration
            + (1.5 * startAcceleration - targetAcceleration) * duration2;
        const c5 = 6 * delta
            - 3 * (startVelocity + targetVelocity) * duration
            - 0.5 * (startAcceleration - targetAcceleration) * duration2;

        return Object.freeze({
            startTime,
            endTime,
            duration,
            target,
            targetVelocity,
            targetAcceleration,
            coefficients: Object.freeze([c0, c1, c2, c3, c4, c5])
        });
    }

    function sampleMinimumJerkTransition(transition, now) {
        if (!transition || !Array.isArray(transition.coefficients)) {
            throw new TypeError('transition is required');
        }
        if (!Number.isFinite(now)) throw new TypeError('now must be finite');
        const [c0, c1, c2, c3, c4, c5] = transition.coefficients;
        if (now <= transition.startTime) {
            return Object.freeze({
                value: c0,
                velocity: c1 / transition.duration,
                acceleration: 2 * c2 / (transition.duration * transition.duration),
                done: false
            });
        }
        if (now >= transition.endTime) {
            return Object.freeze({
                value: transition.target,
                velocity: transition.targetVelocity,
                acceleration: transition.targetAcceleration,
                done: true
            });
        }

        const s = (now - transition.startTime) / transition.duration;
        const s2 = s * s;
        const s3 = s2 * s;
        const s4 = s3 * s;
        const value = c0 + c1 * s + c2 * s2 + c3 * s3 + c4 * s4 + c5 * s4 * s;
        const velocity = (c1
            + 2 * c2 * s
            + 3 * c3 * s2
            + 4 * c4 * s3
            + 5 * c5 * s4) / transition.duration;
        const acceleration = (2 * c2
            + 6 * c3 * s
            + 12 * c4 * s2
            + 20 * c5 * s3)
            / (transition.duration * transition.duration);
        return Object.freeze({ value, velocity, acceleration, done: false });
    }

    /**
     * Select a congruent target on a wrapping axis. When already moving, keep
     * the target far enough in that direction for the zero-end-velocity
     * quintic to remain monotone (the scalar threshold is 0.4 * v * duration).
     */
    function unwrapConvergenceTarget({
        start,
        target,
        span,
        velocity = 0,
        duration = 0,
        minimumTravelRatio = 0.4
    }) {
        for (const [name, value] of Object.entries({
            start,
            target,
            span,
            velocity,
            duration,
            minimumTravelRatio
        })) {
            if (!Number.isFinite(value)) {
                throw new TypeError(`${name} must be finite`);
            }
        }
        if (!(span > 0)) throw new RangeError('span must be greater than zero');
        if (duration < 0) throw new RangeError('duration cannot be negative');
        if (minimumTravelRatio < 0) {
            throw new RangeError('minimumTravelRatio cannot be negative');
        }

        let delta = target - start;
        delta -= Math.round(delta / span) * span;
        if (Math.abs(velocity) <= 1e-12 || duration === 0) {
            return start + delta;
        }

        const direction = Math.sign(velocity);
        const minimumTravel = minimumTravelRatio * Math.abs(velocity) * duration;
        const directedTravel = direction * delta;
        if (directedTravel < minimumTravel) {
            const wraps = Math.ceil((minimumTravel - directedTravel) / span);
            delta += direction * wraps * span;
        }
        return start + delta;
    }

    /**
     * Build a wrapped terminal transition. When requested, discard incoming
     * derivatives only when preserving their direction would select an
     * additional full winding over the nearest equivalent target.
     */
    function createWrappedConvergenceTransition({
        start,
        target,
        span,
        startVelocity = 0,
        startAcceleration = 0,
        startTime,
        endTime,
        relaxExtraWinding = false
    }) {
        const duration = endTime - startTime;
        let selectedTarget = unwrapConvergenceTarget({
            start,
            target,
            span,
            velocity: startVelocity,
            duration
        });
        let effectiveVelocity = startVelocity;
        let effectiveAcceleration = startAcceleration;
        let relaxed = false;

        if (relaxExtraWinding) {
            const nearestTarget = unwrapConvergenceTarget({
                start,
                target,
                span
            });
            if (Math.abs(selectedTarget - nearestTarget) > span / 2) {
                selectedTarget = nearestTarget;
                effectiveVelocity = 0;
                effectiveAcceleration = 0;
                relaxed = true;
            }
        }

        return Object.freeze({
            target: selectedTarget,
            relaxed,
            transition: createMinimumJerkTransition({
                start,
                target: selectedTarget,
                startVelocity: effectiveVelocity,
                startAcceleration: effectiveAcceleration,
                startTime,
                endTime
            })
        });
    }

    function interpolateHermiteAngle(options) {
        const previousAngle = options.previousAngle;
        const currentAngle = options.currentAngle;
        const previousRotationSpeed = options.previousRotationSpeed || 0;
        const rotationSpeed = options.rotationSpeed || 0;
        const targetFps = options.targetFps;
        const timeDiff = options.timeDiff;
        const basis = hermiteBasis(options.t);
        const dt = timeDiff / 1000;
        let delta = currentAngle - previousAngle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        if (Math.abs(delta) < 1e-6) return currentAngle;

        const a0 = previousAngle;
        const a1 = a0 + delta;
        let tangent0 = previousRotationSpeed * targetFps * dt;
        let tangent1 = rotationSpeed * targetFps * dt;
        const maxTangent = 3 * Math.abs(delta);
        if (tangent0 * delta < 0) tangent0 = 0;
        else if (Math.abs(tangent0) > maxTangent) {
            tangent0 = Math.sign(tangent0) * maxTangent;
        }
        if (tangent1 * delta < 0) tangent1 = 0;
        else if (Math.abs(tangent1) > maxTangent) {
            tangent1 = Math.sign(tangent1) * maxTangent;
        }
        return basis.h00 * a0
            + basis.h10 * tangent0
            + basis.h01 * a1
            + basis.h11 * tangent1;
    }

    function findSnapshotBracket(snapshots, targetTime) {
        for (let i = snapshots.length - 2; i >= 0; i--) {
            if (targetTime >= snapshots[i].time) {
                return { previous: snapshots[i], current: snapshots[i + 1] };
            }
        }
        return null;
    }

    function createSnapshotInterpolationPolicy(options) {
        const config = options?.config;
        const nowMs = options?.nowMs;
        const validAtToTime = options?.validAtToTime;
        const getDelayForMember = options?.getDelayForMember;
        const velocityToDeltaX = options?.velocityToDeltaX;
        const velocityToDeltaY = options?.velocityToDeltaY;
        const shortestDeltaX = options?.shortestDeltaX;
        const shortestDeltaY = options?.shortestDeltaY;
        const wrapX = options?.wrapX;
        const wrapY = options?.wrapY;
        const distanceBetween = options?.distanceBetween;
        const dependencies = [
            ['config', config],
            ['nowMs', nowMs],
            ['validAtToTime', validAtToTime],
            ['getDelayForMember', getDelayForMember],
            ['velocityToDeltaX', velocityToDeltaX],
            ['velocityToDeltaY', velocityToDeltaY],
            ['shortestDeltaX', shortestDeltaX],
            ['shortestDeltaY', shortestDeltaY],
            ['wrapX', wrapX],
            ['wrapY', wrapY],
            ['distanceBetween', distanceBetween]
        ];
        for (const [name, value] of dependencies) {
            if (name === 'config' ? !value : typeof value !== 'function') {
                throw new TypeError(`${name} is required`);
            }
        }

        const states = new Map();
        const lastVersions = new Map();
        const policy = {
            states,
            lastVersions,

            updateState(objectId, data, ownerMemberId, validAt) {
                const time = validAt != null ? validAtToTime(validAt) : nowMs();
                const snapshot = {
                    data: { ...data },
                    time,
                    velocity: {
                        x: data.velocityX || 0,
                        y: data.velocityY || 0
                    },
                    rotationSpeed: data.rotationSpeed || 0
                };
                const existing = states.get(objectId);
                if (existing) {
                    existing.ownerMemberId = ownerMemberId;
                    const latest = existing.snapshots[existing.snapshots.length - 1];
                    if (latest && snapshot.time < latest.time) {
                        snapshot.time = latest.time;
                    }
                    existing.snapshots.push(snapshot);
                    if (existing.snapshots.length > config.SNAPSHOT_BUFFER_SIZE) {
                        existing.snapshots.shift();
                    }
                } else {
                    states.set(objectId, {
                        ownerMemberId,
                        snapshots: [snapshot]
                    });
                }
            },

            getInterpolated(objectId, renderTime) {
                const state = states.get(objectId);
                if (!state || state.snapshots.length === 0) return null;
                return policy._baseInterpolated(state, renderTime);
            },

            getSettling(objectId, renderTime) {
                const state = states.get(objectId);
                if (!state || state.snapshots.length === 0) return null;
                return policy._baseInterpolated(state, renderTime, true);
            },

            _baseInterpolated(state, renderTime, clampToLatest = false) {
                const snapshots = state.snapshots;
                const latest = snapshots[snapshots.length - 1];
                if (!config.INTERPOLATION_ENABLED) return latest.data;

                const delay = getDelayForMember(state.ownerMemberId);
                const targetTime = renderTime - delay;
                if (targetTime <= snapshots[0].time) return snapshots[0].data;
                if (targetTime >= latest.time) {
                    if (clampToLatest) return latest.data;
                    const extraTime = Math.min(
                        (targetTime - latest.time) / 1000,
                        config.MAX_EXTRAPOLATION);
                    return {
                        ...latest.data,
                        x: wrapX(
                            latest.data.x
                                + velocityToDeltaX(latest.velocity.x)
                                    * extraTime,
                            latest.data),
                        y: wrapY(
                            latest.data.y
                                + velocityToDeltaY(latest.velocity.y)
                                    * extraTime,
                            latest.data),
                        angle: latest.data.angle
                            + (latest.rotationSpeed || 0)
                                * config.TARGET_FPS
                                * extraTime
                    };
                }

                const bracket = findSnapshotBracket(snapshots, targetTime);
                if (!bracket) return latest.data;
                const timeDiff = bracket.current.time - bracket.previous.time;
                if (timeDiff <= 0) return bracket.current.data;
                const effectiveTimeDiff = Math.max(timeDiff, delay * 0.5);
                const t = (targetTime - bracket.previous.time) / effectiveTimeDiff;
                if (policy.shouldSnap(
                    bracket.previous.data,
                    bracket.current.data)) {
                    return bracket.current.data;
                }
                return policy.hermite({
                    previous: bracket.previous.data,
                    previousVelocity: bracket.previous.velocity,
                    previousRotationSpeed: bracket.previous.rotationSpeed,
                    current: bracket.current.data,
                    velocity: bracket.current.velocity,
                    rotationSpeed: bracket.current.rotationSpeed
                }, Math.min(t, 1), effectiveTimeDiff);
            },

            shouldSnap(a, b) {
                if (a.x === undefined || b.x === undefined) return false;
                return distanceBetween(a, b) > config.SNAP_THRESHOLD;
            },

            hermite(state, t, timeDiff) {
                const result = { ...state.current };
                const dt = timeDiff / 1000;
                const basis = hermiteBasis(t);
                if (state.previous.x !== undefined
                    && state.current.x !== undefined) {
                    const dx = shortestDeltaX(
                        state.previous.x,
                        state.current.x,
                        state.current);
                    const p0 = state.previous.x;
                    const p1 = p0 + dx;
                    const m0 = velocityToDeltaX(
                        state.previousVelocity.x || 0) * dt;
                    const m1 = velocityToDeltaX(state.velocity.x || 0) * dt;
                    result.x = wrapX(
                        basis.h00 * p0
                            + basis.h10 * m0
                            + basis.h01 * p1
                            + basis.h11 * m1,
                        state.current);
                }
                if (state.previous.y !== undefined
                    && state.current.y !== undefined) {
                    const dy = shortestDeltaY(
                        state.previous.y,
                        state.current.y,
                        state.current);
                    const p0 = state.previous.y;
                    const p1 = p0 + dy;
                    const m0 = velocityToDeltaY(
                        state.previousVelocity.y || 0) * dt;
                    const m1 = velocityToDeltaY(state.velocity.y || 0) * dt;
                    result.y = wrapY(
                        basis.h00 * p0
                            + basis.h10 * m0
                            + basis.h01 * p1
                            + basis.h11 * m1,
                        state.current);
                }
                if (state.previous.angle !== undefined
                    && state.current.angle !== undefined) {
                    result.angle = interpolateHermiteAngle({
                        previousAngle: state.previous.angle,
                        currentAngle: state.current.angle,
                        previousRotationSpeed: state.previousRotationSpeed,
                        rotationSpeed: state.rotationSpeed,
                        targetFps: config.TARGET_FPS,
                        t,
                        timeDiff
                    });
                }
                return result;
            },

            lerpAngle(a, b, t) {
                let diff = b - a;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                return a + diff * t;
            },

            remove(objectId) {
                states.delete(objectId);
                lastVersions.delete(objectId);
            },

            clear() {
                states.clear();
                lastVersions.clear();
            }
        };
        return policy;
    }

    return {
        createAdaptiveDelayPolicy,
        createDeadReckoningPolicy,
        createSnapshotInterpolationPolicy,
        calculateRateAngularPredictionWindow,
        integrateRateAngularPredictionFrames,
        averageRateAngularPredictionScale,
        createMemberDelay,
        findSnapshotBracket,
        hermiteBasis,
        createMinimumJerkTransition,
        createWrappedConvergenceTransition,
        sampleMinimumJerkTransition,
        unwrapConvergenceTarget,
        interpolateHermiteAngle,
        recomputeAdaptiveDelay
    };
})();

if (typeof window !== 'undefined') {
    window.ReplicationPresentation = ReplicationPresentation;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplicationPresentation;
}
