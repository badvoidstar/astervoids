/**
 * Leaderboard presentation and a bounded, identity-pinned durable score outbox.
 * Gameplay owns snapshot construction; credentials stay inside PlayerIdentity.
 */
const Leaderboards = (function () {
    const guids = typeof GuidUtils !== 'undefined' ? GuidUtils : require('./guid-utils.js');
    const STORAGE_KEY = 'astervoids.leaderboard-pending.v1';
    const QUEUE_LOCK = 'astervoids.leaderboard-queue';
    const SEND_LOCK = 'astervoids.leaderboard-send';
    const MAX_PENDING = 100;
    const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
    const FIELDS = ['playerId', 'runId', 'score', 'wave', 'teamSize', 'aspectRatio', 'difficulty'];
    const ASPECTS = Object.freeze(['portrait', 'landscape', 'square']);

    function fail(code) {
        return Object.assign(new Error(code), { code });
    }

    function isId(value) {
        return guids.isGuid(value) && value !== EMPTY_GUID;
    }

    function normalizeSnapshot(value) {
        if (!value || Object.keys(value).length !== FIELDS.length
            || !FIELDS.every(key => Object.hasOwn(value, key))
            || !isId(value.playerId) || !isId(value.runId)
            || !Number.isInteger(value.score) || value.score < 0 || value.score > 0xffffffff
            || !Number.isInteger(value.wave) || value.wave < 1 || value.wave > 0x7fffffff
            || !Number.isInteger(value.teamSize) || value.teamSize < 1 || value.teamSize > 0x7fffffff
            || !Number.isFinite(value.aspectRatio) || value.aspectRatio <= 0
            || !Number.isFinite(value.difficulty) || value.difficulty < 0.01 || value.difficulty > 2) {
            throw fail('invalid_score');
        }
        return Object.freeze({
            playerId: value.playerId.toLowerCase(), runId: value.runId.toLowerCase(),
            score: value.score, wave: value.wave, teamSize: value.teamSize,
            aspectRatio: value.aspectRatio, difficulty: value.difficulty,
        });
    }

    function sameSnapshot(left, right) {
        return !!left && !!right && FIELDS.every(key => left[key] === right[key]);
    }

    function snapshotKey(snapshot) {
        return `${snapshot.playerId}:${snapshot.runId}`;
    }

    function mergeSnapshots(previous, next) {
        if (!previous) return next;
        if (previous.playerId !== next.playerId || previous.runId !== next.runId) {
            throw fail('invalid_score');
        }
        const winner = next.score > previous.score
            || (next.score === previous.score && next.wave > previous.wave) ? next : previous;
        return Object.freeze({ ...winner, teamSize: Math.max(previous.teamSize, next.teamSize) });
    }

    function difficultyLabel(value, presets) {
        return presets.find(preset => preset.value === value)?.label ?? `Custom (${value})`;
    }

    function nextFilter(value, values) {
        return values[(values.indexOf(value) + 1) % values.length];
    }

    function validateView(view) {
        if (!view || !Number.isInteger(view.limit) || view.limit < 1 || view.limit > 500
            || !Number.isInteger(view.maxTeamSize) || view.maxTeamSize < 1 || view.maxTeamSize > 0x7fffffff
            || !Array.isArray(view.entries) || view.entries.length > view.limit) {
            throw fail('leaderboard_unavailable');
        }
        let previousScore = Infinity;
        for (const [index, entry] of view.entries.entries()) {
            if (!entry || entry.rank !== index + 1 || typeof entry.name !== 'string' || !entry.name
                || !Number.isInteger(entry.score) || entry.score < 0 || entry.score > 0xffffffff
                || entry.score > previousScore
                || !Number.isInteger(entry.wave) || entry.wave < 1 || entry.wave > 0x7fffffff
                || !Number.isInteger(entry.teamSize) || entry.teamSize < 1 || entry.teamSize > 0x7fffffff
                || !ASPECTS.includes(entry.aspect)
                || !Number.isFinite(entry.difficulty) || entry.difficulty < 0.01 || entry.difficulty > 2) {
                throw fail('leaderboard_unavailable');
            }
            previousScore = entry.score;
        }
        return view;
    }

    function createQuery(query, changed) {
        let generation = 0;
        return {
            close() { generation++; },
            async load(filters) {
                const request = ++generation;
                changed({ state: 'loading' });
                try {
                    const view = validateView(await query({ ...filters }));
                    if (request === generation) changed({ state: 'ready', ...view });
                } catch (error) {
                    if (request === generation) changed({
                        state: 'error',
                        code: error?.code === 'rate_limited' ? 'rate_limited' : 'leaderboard_unavailable',
                    });
                }
            },
        };
    }

    function createOutbox(environment) {
        const { storage, locks, crypto, identity, changed = () => {} } = environment;
        const now = environment.now ?? Date.now;
        const maxPending = environment.maxPending ?? MAX_PENDING;
        let code = null;
        let pending = 0;
        let otherIdentity = 0;
        let nextAttempt = 0;
        let failures = 0;
        let sending = null;
        const captureFailures = new Map();

        function notify(entries) {
            if (entries) {
                pending = entries.length;
                const id = identity.current()?.id;
                otherIdentity = entries.filter(entry => entry.snapshot.playerId !== id).length;
            }
            const captureFailure = captureFailures.values().next().value;
            changed({ pending, otherIdentity, code: captureFailure?.code ?? code });
        }

        function report(error, snapshot) {
            const allowed = new Set([
                'storage_unavailable', 'queue_corrupt', 'queue_full', 'invalid_score',
                'identity_required', 'binding_changed', 'invalid_browser_credential',
                'rate_limited', 'invalid_request', 'leaderboard_unavailable', 'identity_unavailable',
            ]);
            const failureCode = allowed.has(error?.code) ? error.code : 'storage_unavailable';
            if (snapshot) {
                const key = snapshotKey(snapshot);
                captureFailures.set(key, {
                    code: failureCode,
                    snapshot: mergeSnapshots(captureFailures.get(key)?.snapshot, snapshot),
                });
            } else {
                code = failureCode;
            }
            notify();
        }

        function markPersisted(snapshot) {
            const key = snapshotKey(snapshot);
            const failure = captureFailures.get(key);
            if (failure && sameSnapshot(snapshot, mergeSnapshots(snapshot, failure.snapshot))) {
                captureFailures.delete(key);
            }
        }

        async function exclusive(action) {
            if (!locks?.request || !storage || !crypto?.randomUUID) throw fail('storage_unavailable');
            return locks.request(QUEUE_LOCK, action);
        }

        function read() {
            const text = storage.getItem(STORAGE_KEY);
            if (text === null) return [];
            let document;
            try { document = JSON.parse(text); } catch { throw fail('queue_corrupt'); }
            if (document?.version !== 1 || !Array.isArray(document.entries)
                || document.entries.length > maxPending) throw fail('queue_corrupt');
            const keys = new Set();
            return document.entries.map(entry => {
                if (!isId(entry?.generation)) throw fail('queue_corrupt');
                let snapshot;
                try { snapshot = normalizeSnapshot(entry.snapshot); } catch { throw fail('queue_corrupt'); }
                const key = snapshotKey(snapshot);
                if (keys.has(key)) throw fail('queue_corrupt');
                keys.add(key);
                return { generation: entry.generation, snapshot };
            });
        }

        function write(entries) {
            const text = JSON.stringify({ version: 1, entries });
            storage.setItem(STORAGE_KEY, text);
            if (storage.getItem(STORAGE_KEY) !== text) throw fail('storage_unavailable');
        }

        async function refresh() {
            try {
                await exclusive(() => notify(read()));
            } catch (error) { report(error); }
        }

        async function enqueue(value) {
            let snapshot;
            try {
                // Freeze before waiting for a cross-tab lock or a lifecycle reset.
                snapshot = normalizeSnapshot(value);
                await exclusive(() => {
                    const entries = read();
                    const index = entries.findIndex(entry => entry.snapshot.playerId === snapshot.playerId
                        && entry.snapshot.runId === snapshot.runId);
                    if (index < 0 && entries.length >= maxPending) throw fail('queue_full');
                    const previous = index < 0 ? null : entries[index].snapshot;
                    const best = mergeSnapshots(previous, snapshot);
                    if (!sameSnapshot(previous, best)) {
                        const entry = { generation: crypto.randomUUID(), snapshot: best };
                        if (index < 0) entries.push(entry);
                        else entries[index] = entry;
                        write(entries);
                    }
                    markPersisted(best);
                    if (['queue_corrupt', 'storage_unavailable', 'invalid_score'].includes(code)) code = null;
                    notify(entries);
                });
                return true;
            } catch (error) {
                report(error, snapshot);
                return false;
            }
        }

        async function sendOne() {
            const playerId = identity.current()?.id;
            if (!playerId || now() < nextAttempt) return;
            // Sending has its own lock. Network latency never holds the queue
            // lock needed to preserve a newer checkpoint or leave a game.
            await locks.request(SEND_LOCK, { ifAvailable: true }, async lock => {
                if (!lock) return;
                let entry;
                await exclusive(() => {
                    const entries = read();
                    notify(entries);
                    entry = entries.find(candidate => candidate.snapshot.playerId === playerId);
                });
                if (!entry) return;
                try {
                    await identity.saveLeaderboardScore(entry.snapshot);
                    await exclusive(() => {
                        const entries = read();
                        const remaining = entries.filter(candidate => candidate.generation !== entry.generation);
                        if (remaining.length !== entries.length) write(remaining);
                        markPersisted(entry.snapshot);
                        code = null;
                        notify(remaining);
                    });
                    failures = 0;
                    nextAttempt = now() + 5_000;
                } catch (error) {
                    failures++;
                    nextAttempt = now() + Math.max(
                        Math.min(300_000, 15_000 * 2 ** Math.min(failures, 5)),
                        (Number.isFinite(error?.retryAfter) ? error.retryAfter : 0) * 1000);
                    report(error);
                    if (error?.code === 'invalid_request') {
                        await exclusive(() => {
                            const entries = read();
                            const index = entries.findIndex(candidate => candidate.generation === entry.generation);
                            if (index >= 0 && index < entries.length - 1) {
                                entries.push(...entries.splice(index, 1));
                                write(entries);
                                notify(entries);
                            }
                        });
                    }
                }
            });
        }

        function flush() {
            if (!sending) {
                sending = sendOne().catch(report).finally(() => { sending = null; });
            }
            return sending;
        }

        return Object.freeze({ enqueue, flush, refresh });
    }

    function attachDragScroll(element, environment = globalThis) {
        const reducedMotion = environment.matchMedia('(prefers-reduced-motion: reduce)');
        let pointer = null;
        let frame = null;
        let velocity = 0;
        let previousTime = 0;

        function stopInertia() {
            if (frame !== null) environment.cancelAnimationFrame(frame);
            frame = null;
            velocity = 0;
        }

        function move(distance) {
            const before = element.scrollTop;
            const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
            element.scrollTop = Math.max(0, Math.min(maximum, before + distance));
            return element.scrollTop - before;
        }

        function coast(time) {
            const dt = Math.max(0, Math.min(time - previousTime, 64));
            previousTime = time;
            const decay = Math.exp(-dt / 325);
            const distance = velocity * 325 * (1 - decay);
            const moved = move(distance);
            velocity *= decay;
            if (reducedMotion.matches || Math.abs(velocity) < 0.015
                || (dt > 0 && Math.abs(moved) < 0.01)) {
                stopInertia();
            } else {
                frame = environment.requestAnimationFrame(coast);
            }
        }

        function cancel() {
            stopInertia();
            const held = pointer;
            pointer = null;
            element.classList.remove('dragging');
            if (held && element.hasPointerCapture(held.id)) element.releasePointerCapture(held.id);
        }

        element.addEventListener('pointerdown', event => {
            if (!event.isPrimary || event.button !== 0) return;
            cancel();
            element.focus({ preventScroll: true });
            pointer = { id: event.pointerId, y: event.clientY, time: event.timeStamp };
            element.setPointerCapture(event.pointerId);
            element.classList.add('dragging');
            event.preventDefault();
        });
        element.addEventListener('pointermove', event => {
            if (!pointer || pointer.id !== event.pointerId) return;
            const dt = event.timeStamp - pointer.time;
            const moved = move(pointer.y - event.clientY);
            if (dt > 0) velocity = Math.max(-3, Math.min(3, moved / dt));
            pointer.y = event.clientY;
            pointer.time = event.timeStamp;
            event.preventDefault();
        });
        element.addEventListener('pointerup', event => {
            if (!pointer || pointer.id !== event.pointerId) return;
            const speed = event.timeStamp - pointer.time > 100 ? 0 : velocity;
            cancel();
            if (!reducedMotion.matches && Math.abs(speed) >= 0.015) {
                velocity = speed;
                previousTime = environment.performance.now();
                frame = environment.requestAnimationFrame(coast);
            }
        });
        element.addEventListener('pointercancel', cancel);
        element.addEventListener('lostpointercapture', () => { if (pointer) cancel(); });
        element.addEventListener('wheel', stopInertia, { passive: true });
        element.addEventListener('keydown', stopInertia);
        return Object.freeze({ cancel });
    }

    return Object.freeze({
        STORAGE_KEY, MAX_PENDING, ASPECTS, normalizeSnapshot, sameSnapshot, mergeSnapshots,
        difficultyLabel, nextFilter, validateView, createQuery, createOutbox, attachDragScroll,
    });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Leaderboards;
