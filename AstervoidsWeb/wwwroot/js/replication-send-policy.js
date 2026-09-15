/**
 * Game-agnostic outbound replication policies.
 *
 * These policies decide whether state is worth enqueueing. They do not
 * serialize data, call ObjectSync, choose a transport cadence, or own
 * backpressure. Callers retain those responsibilities and may use the boolean
 * compatibility methods or the explicit { send, immediate } decisions.
 */
const ReplicationSendPolicy = (function () {
    function requireFunction(value, name) {
        if (typeof value !== 'function') {
            throw new TypeError(`${name} must be a function`);
        }
        return value;
    }

    /**
     * Heartbeat deadline, quantized onto a fixed wall-clock grid.
     *
     * Unaligned deadlines (`lastSentMs + heartbeatMs`) inherit the phase of
     * whenever each object last changed, so re-anchors trickle across the
     * transport's flush opportunities one or two objects at a time. Each of
     * those tiny batches still pays the full hub-frame envelope, and the
     * resulting packet rate rises with the device's display refresh rate,
     * because a finer frame grid services an arbitrary deadline sooner.
     * Quantizing makes every object's heartbeat land on the same instant, so
     * they coalesce into one batch regardless of refresh rate.
     *
     * The grid is anchored to the caller's LOCAL monotonic clock
     * (`performance.now()`, whose origin is this document's navigation time),
     * deliberately NOT the NTP-synced server clock: a shared server-time grid
     * would make every member of a session burst on the same boundary and
     * correlate server fan-out and ingress queueing. Per-document origins keep
     * senders naturally decorrelated.
     *
     * `floor((lastSentMs + heartbeatMs) / heartbeatMs) * heartbeatMs` lies in
     * `(lastSentMs, lastSentMs + heartbeatMs]`, which gives two properties:
     *   - the aligned deadline can only fire EARLIER than the unaligned one, so
     *     receiver-visible staleness never regresses; and
     *   - consecutive heartbeat deadlines stay at least `heartbeatMs` apart
     *     (firing at or after a grid point pushes the next one a full period
     *     out), so the heartbeat packet rate is unchanged.
     *
     * This decides only WHEN state becomes eligible. It does not know about
     * frames or about the transport's flush cadence, which remains the sole
     * authority on when bytes leave.
     *
     * Degenerate/unset periods fall back to the plain elapsed comparison so a
     * missing or non-positive configuration behaves exactly as before.
     */
    function heartbeatDue(nowMs, lastSentMs, heartbeatMs) {
        if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
            return (nowMs - lastSentMs) >= heartbeatMs;
        }
        const deadline =
            Math.floor((lastSentMs + heartbeatMs) / heartbeatMs) * heartbeatMs;
        return nowMs >= deadline;
    }

    function createBallisticGate(options) {
        const config = options?.config;
        const isDeterministic = requireFunction(
            options?.isDeterministic, 'isDeterministic');
        const nowMs = requireFunction(options?.nowMs, 'nowMs');
        if (!config) throw new TypeError('config is required');

        const baselines = new Map();

        function setBaseline(id, state, now) {
            baselines.set(id, {
                ...state,
                lastSentMs: now,
                prevX: state.x,
                prevY: state.y,
                prevAngle: state.angle
            });
        }

        function decide(id, state) {
            if (!config.SEND_ON_CHANGE_ENABLED || !isDeterministic()) {
                return { send: true, immediate: false, reason: 'unthrottled' };
            }

            const normalized = {
                x: state.x,
                y: state.y,
                angle: state.angle,
                vx: state.vx || 0,
                vy: state.vy || 0,
                rs: state.rs || 0
            };
            const now = nowMs();
            const baseline = baselines.get(id);
            if (!baseline) {
                setBaseline(id, normalized, now);
                return { send: true, immediate: false, reason: 'seed' };
            }

            let reason = null;
            if (Math.abs(normalized.vx - baseline.vx) > config.SEND_ON_CHANGE_VEL_EPS
                || Math.abs(normalized.vy - baseline.vy) > config.SEND_ON_CHANGE_VEL_EPS
                || Math.abs(normalized.rs - baseline.rs) > config.SEND_ON_CHANGE_ROT_EPS) {
                reason = 'motion-change';
            } else if (Math.abs(normalized.x - baseline.prevX) > config.SEND_ON_CHANGE_WRAP_JUMP
                || Math.abs(normalized.y - baseline.prevY) > config.SEND_ON_CHANGE_WRAP_JUMP) {
                reason = 'wrap';
            } else if (heartbeatDue(
                now, baseline.lastSentMs, config.SEND_ON_CHANGE_HEARTBEAT_MS)) {
                reason = 'heartbeat';
            }

            if (reason) {
                setBaseline(id, normalized, now);
                return { send: true, immediate: false, reason };
            }

            baseline.prevX = normalized.x;
            baseline.prevY = normalized.y;
            baseline.prevAngle = normalized.angle;
            return { send: false, immediate: false, reason: 'unchanged' };
        }

        return {
            baselines,
            decide,
            shouldSend(id, x, y, angle, vx, vy, rs) {
                return decide(id, { x, y, angle, vx, vy, rs }).send;
            },
            remove(id) {
                baselines.delete(id);
            },
            clear() {
                baselines.clear();
            }
        };
    }

    function createControlEdgeGate(options) {
        const getRotationEpsilon = requireFunction(
            options?.getRotationEpsilon, 'getRotationEpsilon');
        const epsilon = options?.epsilon ?? 1e-4;
        let last = null;

        function isEdge(ship) {
            const rotationEpsilon = getRotationEpsilon();
            const state = {
                rs: ship.rotationSpeed || 0,
                th: ship.thrustInput || 0,
                br: ship.brakeInput || 0,
                thrusting: !!ship.thrusting
            };
            const previous = last;
            last = state;
            if (!previous) return false;
            if ((Math.abs(state.rs) > rotationEpsilon)
                !== (Math.abs(previous.rs) > rotationEpsilon)) return true;
            if (state.rs * previous.rs < 0) return true;
            if (state.thrusting !== previous.thrusting) return true;
            if ((state.th > epsilon) !== (previous.th > epsilon)) return true;
            if ((state.br > epsilon) !== (previous.br > epsilon)) return true;
            return false;
        }

        return {
            EPS: epsilon,
            isEdge,
            reset() {
                last = null;
            }
        };
    }

    function createShipGate(options) {
        const config = options?.config;
        const isDeterministic = requireFunction(
            options?.isDeterministic, 'isDeterministic');
        const nowMs = requireFunction(options?.nowMs, 'nowMs');
        const getTransitionKey = options?.getTransitionKey == null
            ? state => state.invulnerable || 0
            : requireFunction(options.getTransitionKey, 'getTransitionKey');
        if (!config) throw new TypeError('config is required');

        const baselines = new Map();

        function capture(ship, now) {
            return {
                thrustInput: ship.thrustInput || 0,
                brakeInput: ship.brakeInput || 0,
                turnControlMode: ship.turnControlMode || 0,
                turnTarget: ship.turnTarget || 0,
                turnTargetAngle: ship.turnTargetAngle || 0,
                turnMagnitude: ship.turnMagnitude || 0,
                turnBias: ship.turnBias || 0,
                thrusting: !!ship.thrusting,
                transitionKey: getTransitionKey(ship),
                lastSentMs: now
            };
        }

        function decide(id, ship, force = false) {
            if (!config.SHIP_SEND_ON_CHANGE_ENABLED
                || !config.SHIP_INPUT_REPLAY_ENABLED
                || !isDeterministic()) {
                return {
                    send: true,
                    immediate: !!force,
                    reason: force ? 'forced' : 'unthrottled'
                };
            }

            const now = nowMs();
            const baseline = baselines.get(id);
            if (force || !baseline) {
                baselines.set(id, capture(ship, now));
                return {
                    send: true,
                    immediate: !!force,
                    reason: force ? 'forced' : 'seed'
                };
            }

            const epsilon = config.SEND_ON_CHANGE_VEL_EPS;
            const rotationEpsilon = config.SEND_ON_CHANGE_ROT_EPS;
            let reason = null;
            if (Math.abs((ship.thrustInput || 0) - baseline.thrustInput) > epsilon
                || Math.abs((ship.brakeInput || 0) - baseline.brakeInput) > epsilon
                || Math.abs((ship.turnTarget || 0) - baseline.turnTarget) > epsilon
                || Math.abs((ship.turnMagnitude || 0) - baseline.turnMagnitude) > epsilon
                || Math.abs((ship.turnBias || 0) - baseline.turnBias) > epsilon
                || Math.abs((ship.turnTargetAngle || 0) - baseline.turnTargetAngle) > rotationEpsilon
                || (ship.turnControlMode || 0) !== baseline.turnControlMode
                || !!ship.thrusting !== baseline.thrusting
                || !Object.is(getTransitionKey(ship), baseline.transitionKey)) {
                reason = 'intent-change';
            } else if (heartbeatDue(
                now, baseline.lastSentMs, config.SEND_ON_CHANGE_HEARTBEAT_MS)) {
                reason = 'heartbeat';
            }

            if (!reason) {
                return { send: false, immediate: false, reason: 'unchanged' };
            }
            baselines.set(id, capture(ship, now));
            return { send: true, immediate: false, reason };
        }

        return {
            baselines,
            decide,
            shouldSend(id, ship, force) {
                return decide(id, ship, force).send;
            },
            remove(id) {
                baselines.delete(id);
            },
            clear() {
                baselines.clear();
            }
        };
    }

    return {
        heartbeatDue,
        createBallisticGate,
        createControlEdgeGate,
        createShipGate
    };
})();

if (typeof window !== 'undefined') {
    window.ReplicationSendPolicy = ReplicationSendPolicy;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplicationSendPolicy;
}
