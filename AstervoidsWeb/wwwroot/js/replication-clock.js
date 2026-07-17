/**
 * Clock synchronization for replicated-object timelines.
 *
 * The service estimates the server UTC axis from minimum-RTT ping samples.
 * All clocks, timers, transport calls, and document visibility are injected so
 * the same state machine is deterministic in tests and portable to other
 * browser games.
 */
const ReplicationClock = (function () {
    function pickMinRttSample(samples) {
        if (!samples || samples.length === 0) return null;
        let best = samples[0];
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].rtt < best.rtt) best = samples[i];
        }
        return best;
    }

    function computeOffsetForSample(sample) {
        return sample.serverTime + sample.rtt / 2 - sample.t3Wall;
    }

    function passesOutlierGate(args) {
        if (!args.initialized) return true;
        const tolerance = Math.max(
            args.gateMs,
            args.gateRttMul * args.lastSampleRtt);
        return Math.abs(args.candidateOffset - args.currentOffset) <= tolerance;
    }

    function emaUpdate(current, target, alpha) {
        return current + alpha * (target - current);
    }

    function requireFunction(value, name) {
        if (typeof value !== 'function') {
            throw new TypeError(`${name} must be a function`);
        }
        return value;
    }

    function create(options) {
        const ping = requireFunction(options?.ping, 'ping');
        const monotonicNowMs = requireFunction(
            options?.monotonicNowMs, 'monotonicNowMs');
        const wallNowMs = requireFunction(options?.wallNowMs, 'wallNowMs');
        const schedule = requireFunction(options?.setTimeout, 'setTimeout');
        const cancel = requireFunction(options?.clearTimeout, 'clearTimeout');
        const visibility = options?.visibility || null;

        const state = {
            offsetMs: 0,
            offsetInitialized: false,
            wallToPerfDelta: null,
            lastSampleRtt: Infinity,
            sampleCount: 0,
            rejectedCount: 0,
            bootstrapBurstSize: options.bootstrapBurstSize ?? 5,
            bootstrapIntervalMs: options.bootstrapIntervalMs ?? 100,
            refreshIntervalMs: options.refreshIntervalMs ?? 30000,
            emaAlpha: options.emaAlpha ?? 0.3,
            outlierGateMs: options.outlierGateMs ?? 20,
            outlierGateRttMul: options.outlierGateRttMul ?? 3,
            running: false,
            generation: 0,
            burstOperation: null,
            loopPromise: null,
            visibilityHandler: null,
            wakeResolve: null
        };

        function isHidden() {
            return !!visibility?.hidden;
        }

        function wait(ms) {
            return new Promise(resolve => schedule(resolve, ms));
        }

        function serverNowMs() {
            return wallNowMs() + state.offsetMs;
        }

        function validAtToMonotonicMs(validAt) {
            if (validAt == null || !Number.isFinite(validAt)) {
                return monotonicNowMs();
            }
            const delta = state.wallToPerfDelta != null
                ? state.wallToPerfDelta
                : monotonicNowMs() - wallNowMs();
            const offset = state.offsetInitialized ? state.offsetMs : 0;
            return validAt - offset + delta;
        }

        async function runPingBurst(
            burstSize,
            generation = state.generation
        ) {
            if (!state.running || generation !== state.generation) return null;
            const samples = [];
            for (let i = 0; i < burstSize; i++) {
                if (!state.running || generation !== state.generation) return null;
                if (isHidden()) break;
                if (i > 0) {
                    await wait(state.bootstrapIntervalMs);
                    if (!state.running || generation !== state.generation) return null;
                }
                try {
                    const t0Perf = monotonicNowMs();
                    const serverTime = await ping();
                    if (!state.running || generation !== state.generation) return null;
                    const t3Perf = monotonicNowMs();
                    const t3Wall = wallNowMs();
                    if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) {
                        continue;
                    }
                    samples.push({
                        rtt: t3Perf - t0Perf,
                        serverTime,
                        t3Wall
                    });
                } catch {
                    // A later refresh retries transient transport failures.
                }
            }

            if (!state.running || generation !== state.generation) return null;
            const winner = pickMinRttSample(samples);
            if (!winner) return null;
            const candidateOffset = computeOffsetForSample(winner);
            if (!passesOutlierGate({
                currentOffset: state.offsetMs,
                lastSampleRtt: state.lastSampleRtt,
                candidateOffset,
                gateMs: state.outlierGateMs,
                gateRttMul: state.outlierGateRttMul,
                initialized: state.offsetInitialized
            })) {
                state.rejectedCount++;
                return null;
            }

            if (!state.offsetInitialized) {
                state.offsetMs = candidateOffset;
                state.offsetInitialized = true;
            } else {
                state.offsetMs = emaUpdate(
                    state.offsetMs,
                    candidateOffset,
                    state.emaAlpha);
            }
            state.lastSampleRtt = winner.rtt;
            state.wallToPerfDelta = monotonicNowMs() - wallNowMs();
            state.sampleCount++;
            return winner;
        }

        function queuePingBurst(
            burstSize,
            generation = state.generation
        ) {
            const previous = state.burstOperation;
            const waitForPrevious = previous?.generation === generation
                ? previous.promise.catch(() => {})
                : Promise.resolve();
            const operation = { generation, promise: null };
            operation.promise = waitForPrevious.then(
                () => runPingBurst(burstSize, generation));
            state.burstOperation = operation;
            return operation.promise.finally(() => {
                if (state.burstOperation === operation) {
                    state.burstOperation = null;
                }
            });
        }

        async function syncLoop(generation) {
            await queuePingBurst(state.bootstrapBurstSize, generation);
            while (state.running && generation === state.generation) {
                await new Promise(resolve => {
                    let timer = null;
                    const wake = () => {
                        if (timer != null) cancel(timer);
                        if (state.wakeResolve === wake) state.wakeResolve = null;
                        resolve();
                    };
                    state.wakeResolve = wake;
                    timer = schedule(wake, state.refreshIntervalMs);
                });
                if (!state.running || generation !== state.generation) break;
                if (isHidden()) continue;
                await queuePingBurst(1, generation);
            }
        }

        function start() {
            if (state.running) return;
            state.lastSampleRtt = Infinity;
            state.running = true;
            const generation = ++state.generation;
            state.loopPromise = syncLoop(generation).catch(() => {
                if (generation === state.generation) state.running = false;
            });
            if (visibility && !state.visibilityHandler) {
                state.visibilityHandler = () => {
                    if (isHidden() || !state.running) return;
                    const wake = state.wakeResolve;
                    const currentGeneration = state.generation;
                    queuePingBurst(
                        state.bootstrapBurstSize,
                        currentGeneration
                    ).then(
                        () => { if (wake) wake(); },
                        () => { if (wake) wake(); });
                };
                visibility.addEventListener(
                    'visibilitychange',
                    state.visibilityHandler);
            }
        }

        function stop() {
            state.running = false;
            state.generation++;
            if (state.wakeResolve) {
                const wake = state.wakeResolve;
                state.wakeResolve = null;
                wake();
            }
            if (visibility && state.visibilityHandler) {
                visibility.removeEventListener(
                    'visibilitychange',
                    state.visibilityHandler);
                state.visibilityHandler = null;
            }
            state.loopPromise = null;
        }

        return {
            state,
            serverNowMs,
            validAtToMonotonicMs,
            runPingBurst,
            queuePingBurst,
            syncLoop,
            start,
            stop,
            isInitialized: () => state.offsetInitialized,
            getSampleRtt: () => state.lastSampleRtt,
            getOffsetMs: () => state.offsetMs
        };
    }

    return {
        create,
        pickMinRttSample,
        computeOffsetForSample,
        passesOutlierGate,
        emaUpdate
    };
})();

if (typeof window !== 'undefined') {
    window.ReplicationClock = ReplicationClock;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReplicationClock;
}
