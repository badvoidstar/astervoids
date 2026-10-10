import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const require = createRequire(import.meta.url);
const Leaderboards = require('./wwwroot/js/leaderboards.js');
const GuidUtils = require('./wwwroot/js/guid-utils.js');
const { ASTEROID_DIFFICULTY_PRESETS: presets } = require('./wwwroot/js/game-config.js');
const playerId = '00112233-4455-6677-8899-aabbccddeeff';
const otherId = '11223344-5566-7788-99aa-bbccddeeff00';
const runId = '22334455-6677-8899-aabb-ccddeeff0011';
const shipId = '33445566-7788-99aa-bbcc-ddeeff001122';
const sample = (overrides = {}) => ({
    playerId, runId, score: 50, wave: 2, teamSize: 1, aspectRatio: 16 / 9,
    difficulty: 0.65, ...overrides,
});
const view = (overrides = {}) => ({
    limit: 50, maxTeamSize: 4,
    entries: [{ rank: 1, name: 'Pilot', score: 50, wave: 2, teamSize: 1,
        aspect: 'landscape', difficulty: 0.65 }],
    ...overrides,
});
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const drain = () => new Promise(resolve => setImmediate(resolve));

function webLocks() {
    const tails = new Map();
    return {
        request(name, options, action) {
            if (typeof options === 'function') { action = options; options = {}; }
            const previous = tails.get(name);
            if (options.ifAvailable && previous) return Promise.resolve().then(() => action(null));
            const running = (previous ?? Promise.resolve()).then(() => action({ name }));
            const tail = running.catch(() => {}).finally(() => {
                if (tails.get(name) === tail) tails.delete(name);
            });
            tails.set(name, tail);
            return running;
        },
    };
}

function outboxHarness(options = {}) {
    const values = options.values ?? new Map();
    const storage = options.storage ?? {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const state = { id: playerId, now: 0 };
    const requests = [];
    const statuses = [];
    const environment = {
        storage, locks: options.locks ?? webLocks(), crypto: webcrypto,
        now: () => state.now, maxPending: options.maxPending,
        identity: {
            current: () => state.id ? { id: state.id } : null,
            async saveLeaderboardScore(snapshot) {
                requests.push(snapshot);
                return options.save ? options.save(snapshot) : { recorded: true };
            },
        },
        changed: status => statuses.push(status),
    };
    return {
        values, storage, state, requests, statuses, environment,
        outbox: Leaderboards.createOutbox(environment),
        entries: () => JSON.parse(values.get(Leaderboards.STORAGE_KEY)).entries,
    };
}

test('score snapshots reject invalid counters, identity, metadata and extra fields', () => {
    for (const invalid of [
        { score: -1 }, { score: 1.5 }, { score: 0x100000000 }, { wave: 0 }, { wave: 0x80000000 },
        { teamSize: 0 }, { teamSize: 1.1 }, { aspectRatio: NaN }, { aspectRatio: Infinity },
        { aspectRatio: 0 }, { difficulty: 0.009 }, { difficulty: 2.01 }, { difficulty: NaN },
        { playerId: 'guest' }, { runId: '00000000-0000-0000-0000-000000000000' }, { name: 'Imposter' },
    ]) assert.throws(() => Leaderboards.normalizeSnapshot(sample(invalid)), { code: 'invalid_score' });
    const snapshot = Leaderboards.normalizeSnapshot(sample({ playerId: playerId.toUpperCase(), score: 0 }));
    assert.equal(snapshot.playerId, playerId);
    assert.equal(snapshot.score, 0);
    assert.equal(Object.isFrozen(snapshot), true);
});

test('coherent best-score/wave metadata wins while concurrent membership is an independent maximum', () => {
    const original = sample();
    const lower = sample({ score: 49, wave: 10, teamSize: 4, difficulty: 0.2, aspectRatio: 0.5 });
    assert.deepEqual(Leaderboards.mergeSnapshots(original, lower), { ...original, teamSize: 4 });
    const tied = sample({ teamSize: 2, difficulty: 0.2, aspectRatio: 0.5 });
    assert.deepEqual(Leaderboards.mergeSnapshots(original, tied), { ...original, teamSize: 2 });
    const nextWave = sample({ wave: 3, difficulty: 0.35, aspectRatio: 1 });
    assert.deepEqual(Leaderboards.mergeSnapshots(original, nextWave), nextWave);
    const higher = sample({ score: 51, wave: 1, difficulty: 0.5 });
    assert.deepEqual(Leaderboards.mergeSnapshots(original, higher), higher);
    assert.throws(() => Leaderboards.mergeSnapshots(original, sample({ playerId: otherId })),
        { code: 'invalid_score' });
});

test('difficulty labels and filter cycles use Any then every configured preset without adding a Custom filter', () => {
    const values = [null, ...presets.map(preset => preset.value)];
    let selected = null;
    for (const preset of presets) {
        selected = Leaderboards.nextFilter(selected, values);
        assert.equal(Leaderboards.difficultyLabel(selected, presets), preset.label);
    }
    assert.equal(Leaderboards.nextFilter(selected, values), null);
    assert.equal(Leaderboards.difficultyLabel(0.7, presets), 'Custom (0.7)');
    assert.deepEqual(Leaderboards.ASPECTS, ['portrait', 'landscape', 'square']);
});

test('a durable queue survives reopening, includes zero scores and coalesces one player/run', async () => {
    const h = outboxHarness();
    assert.equal(await h.outbox.enqueue(sample({ score: 0 })), true);
    assert.equal(await h.outbox.enqueue(sample()), true);
    assert.equal(h.entries().length, 1);
    const generation = h.entries()[0].generation;
    await h.outbox.enqueue(sample());
    assert.equal(h.entries()[0].generation, generation, 'An identical checkpoint does not dirty the queue');
    const reopened = Leaderboards.createOutbox(h.environment);
    await reopened.flush();
    assert.deepEqual(h.requests, [sample()]);
    assert.deepEqual(h.entries(), []);
    assert.equal(h.statuses.at(-1).pending, 0);
});

test('a slow acknowledgement never removes a newer checkpoint for the same run', async () => {
    const response = deferred();
    const h = outboxHarness({ save: () => response.promise });
    await h.outbox.enqueue(sample());
    const sending = h.outbox.flush();
    await drain();
    const newer = sample({ score: 90, teamSize: 3, wave: 4, difficulty: 0.2, aspectRatio: 0.5 });
    await h.outbox.enqueue(newer);
    response.resolve({ recorded: true });
    await sending;
    assert.deepEqual(h.entries().map(entry => entry.snapshot), [newer]);
    h.state.now += 5_000;
    await h.outbox.flush();
    assert.deepEqual(h.requests, [sample(), newer]);
    assert.deepEqual(h.entries(), []);
});

test('two tabs merge the queue under one lock and only one sends while another request is in flight', async () => {
    const response = deferred();
    const values = new Map();
    const locks = webLocks();
    const first = outboxHarness({ values, locks, save: () => response.promise });
    const second = outboxHarness({ values, locks });
    await Promise.all([
        first.outbox.enqueue(sample()),
        second.outbox.enqueue(sample({ score: 70, teamSize: 2 })),
    ]);
    assert.equal(first.entries().length, 1);
    assert.equal(first.entries()[0].snapshot.score, 70);
    const sending = first.outbox.flush();
    await drain();
    await second.outbox.flush();
    assert.equal(second.requests.length, 0);
    await second.outbox.enqueue(sample({ teamSize: 4 }));
    response.resolve({ recorded: true });
    await sending;
    assert.equal(first.entries()[0].snapshot.score, 70);
    assert.equal(first.entries()[0].snapshot.teamSize, 4);
});

test('frozen snapshots retain their original identity and metadata across retries and rebinding', async () => {
    const h = outboxHarness();
    const mutable = sample();
    const enqueueing = h.outbox.enqueue(mutable);
    mutable.score = 999;
    mutable.aspectRatio = 0.5;
    mutable.difficulty = 0.2;
    await enqueueing;
    h.state.id = otherId;
    await h.outbox.refresh();
    await h.outbox.flush();
    assert.deepEqual(h.requests, []);
    assert.equal(h.statuses.at(-1).otherIdentity, 1);
    await h.outbox.enqueue(sample({ playerId: otherId, score: 80 }));
    await h.outbox.flush();
    assert.equal(h.requests[0].playerId, otherId);
    assert.deepEqual(h.entries().map(entry => entry.snapshot), [sample()]);
    h.state.id = playerId;
    h.state.now += 5_000;
    await h.outbox.flush();
    assert.deepEqual(h.requests[1], sample());
});

test('unbound browsers never submit scores or remove pending records', async () => {
    const h = outboxHarness();
    await h.outbox.enqueue(sample());
    h.state.id = null;
    await h.outbox.flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.entries().length, 1);
});

test('an excluded identity cannot send any previously queued checkpoint', async () => {
    const h = outboxHarness();
    await h.outbox.enqueue(sample());
    h.environment.identity.current = () => ({ id: playerId, excludeFromLeaderboards: true });
    await h.outbox.flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.entries().length, 1, 'Exclusion does not silently delete already queued local data');
});

test('the queue reports capacity instead of evicting unacknowledged records', async () => {
    const h = outboxHarness({ maxPending: 2 });
    await h.outbox.enqueue(sample());
    await h.outbox.enqueue(sample({ runId: otherId }));
    const before = h.values.get(Leaderboards.STORAGE_KEY);
    assert.equal(await h.outbox.enqueue(sample({ runId: shipId })), false);
    assert.equal(h.values.get(Leaderboards.STORAGE_KEY), before);
    assert.equal(h.statuses.at(-1).code, 'queue_full');
    assert.equal(await h.outbox.enqueue(sample({ score: 80 })), true);
    assert.equal(h.entries().length, 2);
    assert.equal(h.entries()[0].snapshot.score, 80);
    assert.equal(h.statuses.at(-1).code, 'queue_full', 'Saving another run cannot recover the rejected run');
    await h.outbox.flush();
    assert.equal(h.statuses.at(-1).code, 'queue_full', 'Sending another run cannot hide a lost capture');
    assert.equal(await h.outbox.enqueue(sample({ runId: shipId })), true);
    assert.equal(h.statuses.at(-1).code, null);
});

test('capture warnings remain until every rejected run has been persisted', async () => {
    const h = outboxHarness({ maxPending: 1 });
    await h.outbox.enqueue(sample());
    assert.equal(await h.outbox.enqueue(sample({ runId: otherId })), false);
    assert.equal(await h.outbox.enqueue(sample({ runId: shipId })), false);
    await h.outbox.flush();
    await h.outbox.enqueue(sample({ runId: otherId }));
    assert.equal(h.statuses.at(-1).code, 'queue_full');
    h.state.now += 5_000;
    await h.outbox.flush();
    assert.equal(h.statuses.at(-1).code, 'queue_full');
    await h.outbox.enqueue(sample({ runId: shipId }));
    assert.equal(h.statuses.at(-1).code, null);
});

test('an older acknowledgement cannot clear a failed newer score or membership checkpoint', async () => {
    const values = new Map();
    let unavailable = false;
    const h = outboxHarness({ values, storage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => {
            if (unavailable) throw new Error('Quota exceeded');
            values.set(key, value);
        },
    } });
    await h.outbox.enqueue(sample());
    unavailable = true;
    assert.equal(await h.outbox.enqueue(sample({ score: 80, wave: 4, teamSize: 3 })), false);
    unavailable = false;
    await h.outbox.flush();
    assert.equal(h.statuses.at(-1).code, 'storage_unavailable');
    await h.outbox.enqueue(sample({ score: 100, teamSize: 2 }));
    assert.equal(h.statuses.at(-1).code, 'storage_unavailable', 'The rejected peak team size is still missing');
    await h.outbox.enqueue(sample({ score: 100, teamSize: 3 }));
    assert.equal(h.statuses.at(-1).code, null);
});

test('corrupt persistent queues are reported and preserved verbatim', async () => {
    for (const corrupt of ['{', '{"version":9,"entries":[]}', JSON.stringify({
        version: 1, entries: [{ generation: webcrypto.randomUUID(), snapshot: sample({ score: -1 }) }],
    })]) {
        const h = outboxHarness();
        h.values.set(Leaderboards.STORAGE_KEY, corrupt);
        assert.equal(await h.outbox.enqueue(sample()), false);
        await h.outbox.flush();
        assert.equal(h.values.get(Leaderboards.STORAGE_KEY), corrupt);
        assert.equal(h.statuses.at(-1).code, 'queue_corrupt');
        assert.equal(h.requests.length, 0);
    }
});

test('storage quota and missing Web Locks fail visibly without claiming durable enqueue', async () => {
    const h = outboxHarness({ storage: {
        getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); },
    } });
    assert.equal(await h.outbox.enqueue(sample()), false);
    assert.equal(h.statuses.at(-1).code, 'storage_unavailable');
    const statuses = [];
    const missing = Leaderboards.createOutbox({ ...h.environment, locks: null, changed: s => statuses.push(s) });
    assert.equal(await missing.enqueue(sample()), false);
    assert.equal(statuses.at(-1).code, 'storage_unavailable');
});

test('rate limits preserve records and honor Retry-After before an exact retry', async () => {
    let fail = true;
    const h = outboxHarness({ save: async () => {
        if (fail) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited', retryAfter: 60 });
        return { recorded: true };
    } });
    await h.outbox.enqueue(sample());
    await h.outbox.flush();
    assert.equal(h.statuses.at(-1).code, 'rate_limited');
    h.state.now = 59_999;
    await h.outbox.flush();
    assert.equal(h.requests.length, 1);
    fail = false;
    h.state.now = 60_000;
    await h.outbox.flush();
    assert.deepEqual(h.requests, [sample(), sample()]);
    assert.equal(h.entries().length, 0);
});

test('binding conflicts are retained, never retargeted or retried in a tight loop', async () => {
    const h = outboxHarness({ save: async () => {
        throw Object.assign(new Error('binding_changed'), { code: 'binding_changed' });
    } });
    await h.outbox.enqueue(sample());
    await h.outbox.flush();
    await h.outbox.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.entries()[0].snapshot.playerId, playerId);
    assert.equal(h.statuses.at(-1).code, 'binding_changed');
});

test('a rejected queued record is preserved without starving other runs', async () => {
    const h = outboxHarness({ save: async snapshot => {
        if (snapshot.runId === runId) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
        return { recorded: true };
    } });
    await h.outbox.enqueue(sample());
    await h.outbox.enqueue(sample({ runId: otherId }));
    await h.outbox.flush();
    assert.equal(h.entries().length, 2);
    assert.equal(h.statuses.at(-1).code, 'invalid_request');
    h.state.now += 30_000;
    await h.outbox.flush();
    assert.deepEqual(h.requests.map(snapshot => snapshot.runId), [runId, otherId]);
    assert.deepEqual(h.entries().map(entry => entry.snapshot.runId), [runId]);
});

test('rejecting an old generation cannot rotate or replace its newer checkpoint', async () => {
    const response = deferred();
    const h = outboxHarness({ save: snapshot => snapshot.score === 50 ? response.promise : { recorded: true } });
    await h.outbox.enqueue(sample());
    await h.outbox.enqueue(sample({ runId: otherId }));
    const sending = h.outbox.flush();
    await drain();
    await h.outbox.enqueue(sample({ score: 80 }));
    const before = h.values.get(Leaderboards.STORAGE_KEY);
    response.reject(Object.assign(new Error('invalid_request'), { code: 'invalid_request' }));
    await sending;
    assert.equal(h.values.get(Leaderboards.STORAGE_KEY), before);
    h.state.now += 30_000;
    await h.outbox.flush();
    assert.equal(h.requests.at(-1).score, 80);
    assert.deepEqual(h.entries().map(entry => entry.snapshot.runId), [otherId]);
});

test('ranked responses enforce configured limits, contiguous ranks, sorting and all required columns', () => {
    assert.deepEqual(Leaderboards.validateView(view()), view());
    assert.deepEqual(Leaderboards.validateView(view({ entries: [], limit: 2, maxTeamSize: 7 })).entries, []);
    for (const invalid of [
        view({ limit: 0 }), view({ limit: 501 }), view({ maxTeamSize: 0 }),
        view({ entries: [{ ...view().entries[0], rank: 2 }] }),
        view({ entries: [{ ...view().entries[0], score: null }] }),
        view({ entries: [{ ...view().entries[0], wave: 0 }] }),
        view({ entries: [{ ...view().entries[0], name: null }] }),
        view({ entries: [{ ...view().entries[0], aspect: 'Any' }] }),
        view({ entries: [{ ...view().entries[0], teamSize: 0 }] }),
        view({ entries: [{ ...view().entries[0], difficulty: 3 }] }),
        view({ limit: 1, entries: [view().entries[0], { ...view().entries[0], rank: 2 }] }),
        view({ entries: [view().entries[0], { ...view().entries[0], rank: 2, score: 51 }] }),
    ]) assert.throws(() => Leaderboards.validateView(invalid), { code: 'leaderboard_unavailable' });
    const historicCapacity = view({
        maxTeamSize: 2, entries: [{ ...view().entries[0], teamSize: 4 }],
    });
    assert.equal(Leaderboards.validateView(historicCapacity).entries[0].teamSize, 4,
        'Any can still show historical runs after session capacity is lowered');
});

test('stale successes, failures and closed-screen results cannot overwrite the latest filtered view', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const replies = [first, second, third];
    const changes = [];
    const query = Leaderboards.createQuery(() => replies.shift().promise, change => changes.push(change));
    const old = query.load({ difficulty: 0.2 });
    const current = query.load({ difficulty: 0.5 });
    second.resolve(view());
    await current;
    const final = changes.at(-1);
    first.reject(new Error('older query failed'));
    await old;
    assert.equal(changes.at(-1), final);
    assert.equal(final.state, 'ready');
    const closed = query.load({});
    query.close();
    third.resolve(view({ entries: [] }));
    await closed;
    assert.equal(changes.at(-1).state, 'loading');
});

test('malformed and unavailable queries show errors, not a success-shaped empty leaderboard', async () => {
    const changes = [];
    const query = Leaderboards.createQuery(async () => ({ entries: [] }), change => changes.push(change));
    await query.load({});
    assert.equal(changes.at(-1).state, 'error');
    assert.equal(changes.at(-1).code, 'leaderboard_unavailable');
});

test('leaderboard buttons keep a fixed single-line height with a single-column fallback', () => {
    const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
    const style = source.match(/#leaderboard-screen \.picker-btn \{([^}]+)\}/)?.[1];
    assert.ok(style);
    assert.match(style, /\bheight: 36px;/);
    assert.match(style, /min-width: 0;/);
    assert.match(style, /white-space: nowrap;/);
    assert.match(style, /transition-property: background-color, border-color, color, opacity;/);
    assert.match(source, /#leaderboard-filters \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(source, /#btn-leaderboards \{[^}]*white-space: nowrap;/);
});

test('filter layout fits all columns together using the CSS width allowance and measured gap', () => {
    const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
    const style = source.match(/#leaderboard-filters \{([^}]+)\}/)?.[1];
    const minimum = Number(style.match(/--leaderboard-filter-min-width: (\d+)px;/)?.[1]);
    const gap = Number(style.match(/\bgap: (\d+)px;/)?.[1]);
    assert.equal(minimum, 220, 'Trim the old 240px allowance without shrinking normal label fonts');
    assert.ok(gap > 0);
    let width = 0;
    const group = {
        children: [{}, {}, {}], style: {},
        getBoundingClientRect: () => ({ width }),
    };
    const environment = {
        getComputedStyle(element) {
            assert.equal(element, group);
            return {
                columnGap: `${gap}px`,
                getPropertyValue(property) {
                    assert.equal(property, '--leaderboard-filter-min-width');
                    return `${minimum}px`;
                },
            };
        },
    };
    const rowMinimum = group.children.length * minimum + (group.children.length - 1) * gap;
    for (const [available, columns] of [
        [rowMinimum + 1, 3], [rowMinimum, 3], [rowMinimum - 0.25, 1],
        [rowMinimum - 1, 1], [2 * minimum + gap, 1], [156, 1],
        [rowMinimum, 3], [rowMinimum - 1, 1], [rowMinimum + 1, 3],
    ]) {
        width = available;
        Leaderboards.fitFilterLayout(group, environment);
        assert.equal(group.style.gridTemplateColumns, `repeat(${columns}, minmax(0, 1fr))`,
            `All three filters share the mode at ${width}px, independent of the previous layout`);
    }
    width = 0;
    Leaderboards.fitFilterLayout(group, {
        getComputedStyle() { assert.fail('Hidden groups must not be measured'); },
    });
    assert.equal(group.style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
    width = 156;
    Leaderboards.fitFilterLayout(group, environment);
    assert.equal(group.style.gridTemplateColumns, 'repeat(1, minmax(0, 1fr))',
        'Reopening at a narrower size recalculates the layout');
});

test('the menu inherits shared button typography and numeric table headers align with their values', () => {
    const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
    const menuStyle = source.match(/#btn-leaderboards \{([^}]+)\}/)?.[1];
    assert.ok(menuStyle);
    assert.doesNotMatch(menuStyle, /font(?:-[a-z-]+)?:|letter-spacing:/);
    assert.match(source,
        /#leaderboard-table :is\(th, td\):nth-child\(1\),\s*#leaderboard-table :is\(th, td\):nth-child\(4\) \{ text-align: center;/);
    assert.match(source, /#leaderboard-table :is\(th, td\):nth-child\(3\) \{ text-align: right;/);
    assert.match(source,
        /<th scope="col" title="Wave reached in the run that produced this score">Wave<\/th>/);
});

test('button fitting uses native font sizes and available content width, restoring size after widening', () => {
    const button = {
        clientWidth: 144, defaultFontSize: 13,
        textContent: 'Aspect Ratio : Landscape',
        style: { removeProperty(key) { assert.equal(key, 'font-size'); delete this.fontSize; } },
    };
    let target;
    const width = () => target.textContent.length
        * parseFloat(target.style.fontSize ?? target.defaultFontSize) * 0.7;
    const environment = {
        getComputedStyle: element => ({
            fontSize: `${element.defaultFontSize}px`, paddingLeft: '8px', paddingRight: '8px',
        }),
        document: { createRange: () => ({
            selectNodeContents(element) { target = element; },
            getBoundingClientRect: () => ({ width: width() }),
        }) },
    };
    Leaderboards.fitButtonLabels([button], environment);
    assert.ok(parseFloat(button.style.fontSize) < 13);
    assert.ok(width() <= button.clientWidth - 16, 'The full label fits inside both padding edges');
    assert.deepEqual(Object.keys(button.style).sort(), ['fontSize', 'removeProperty']);
    button.textContent = 'Team Size : 2147483647';
    Leaderboards.fitButtonLabels([button], environment);
    assert.ok(width() <= button.clientWidth - 16, 'Configured capacity does not overflow the label');
    button.clientWidth = 300;
    Leaderboards.fitButtonLabels([button], environment);
    assert.equal(button.style.fontSize, undefined, 'Wider buttons regain their normal CSS font size');
    button.clientWidth = 0;
    Leaderboards.fitButtonLabels([button], {
        getComputedStyle() { assert.fail('Hidden buttons must not be measured'); },
    });
});

function dragHarness(reduced = false) {
    const handlers = new Map();
    const frames = new Map();
    const classes = new Set();
    let frameId = 0;
    let held = null;
    let time = 0;
    const element = {
        scrollTop: 0, scrollHeight: 2000, clientHeight: 300,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        addEventListener: (type, handler) => handlers.set(type, handler),
        focus() {}, setPointerCapture: id => { held = id; },
        hasPointerCapture: id => held === id, releasePointerCapture: () => { held = null; },
    };
    const environment = {
        matchMedia: () => ({ matches: reduced }), performance: { now: () => time },
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
    };
    const drag = Leaderboards.attachDragScroll(element, environment);
    return {
        element, frames, classes, drag,
        event(type, y = 0, advance = 16, overrides = {}) {
            time += advance;
            handlers.get(type)({
                isPrimary: true, button: 0, pointerId: 1, clientY: y, timeStamp: time,
                preventDefault() {}, ...overrides,
            });
        },
        frame() {
            time += 16;
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach(callback => callback(time));
        },
    };
}

for (const pointerType of ['mouse', 'touch']) {
    test(`${pointerType} hold-drag scroll preserves velocity on release, decelerates and stops`, () => {
        const h = dragHarness();
        h.event('pointerdown', 250, 16, { pointerType });
        h.event('pointermove', 218, 16, { pointerType });
        assert.equal(h.element.scrollTop, 32);
        h.event('pointerup', 218, 1, { pointerType });
        const release = h.element.scrollTop;
        h.frame();
        const firstDistance = h.element.scrollTop - release;
        assert.ok(firstDistance > 0);
        const afterFirst = h.element.scrollTop;
        h.frame();
        assert.ok(h.element.scrollTop - afterFirst < firstDistance, 'Velocity decays rather than scrolling forever');
        for (let step = 0; step < 400 && h.frames.size; step++) h.frame();
        assert.equal(h.frames.size, 0);
        assert.ok(h.element.scrollTop > release);
        assert.ok(h.element.scrollTop <= h.element.scrollHeight - h.element.clientHeight);
        assert.equal(h.classes.has('dragging'), false);
    });
}

test('a stationary hold, cancellation, wheel/keyboard input and reduced motion stop inertia', () => {
    for (const stop of ['pointercancel', 'wheel', 'keydown']) {
        const h = dragHarness();
        h.event('pointerdown', 250);
        h.event('pointermove', 220);
        if (stop !== 'pointercancel') h.event('pointerup', 220, 1);
        h.event(stop);
        assert.equal(h.frames.size, 0, stop);
    }
    const held = dragHarness();
    held.event('pointerdown', 250);
    held.event('pointermove', 220);
    held.event('pointerup', 220, 101);
    assert.equal(held.frames.size, 0);
    const reduced = dragHarness(true);
    reduced.event('pointerdown', 250);
    reduced.event('pointermove', 220);
    reduced.event('pointerup', 220, 1);
    assert.equal(reduced.element.scrollTop, 30);
    assert.equal(reduced.frames.size, 0);
});

test('secondary pointers and right clicks do not scroll; drag and coast clamp at both ends', () => {
    const h = dragHarness();
    h.event('pointerdown', 250, 16, { isPrimary: false });
    h.event('pointermove', 220);
    assert.equal(h.element.scrollTop, 0);
    h.event('pointerdown', 250, 16, { button: 2 });
    h.event('pointermove', 220);
    assert.equal(h.element.scrollTop, 0);
    h.event('pointerdown', 250);
    h.event('pointermove', 300);
    assert.equal(h.element.scrollTop, 0);
    h.event('pointermove', -3000);
    assert.equal(h.element.scrollTop, 1700);
    h.event('pointerup', -3000, 1);
    h.frame();
    assert.equal(h.element.scrollTop, 1700);
    assert.equal(h.frames.size, 0);
});

function captureHarness(options = {}) {
    const snapshots = [];
    const game = {
        mode: options.session ? 'session' : 'solo', state: 'playing', score: 400, wave: 2,
        playerIdentity: options.guest ? null : {
            id: playerId, tag: 'Pilot', ...(options.excluded ? { excludeFromLeaderboards: true } : {}),
        },
        ship: options.spectator ? null : { syncObjectId: shipId, participantId: playerId, score: 25 },
        sessionInfo: options.session ? { id: runId } : null, leaderboardRun: null,
    };
    const session = { id: runId, members: [{ id: playerId }, { id: otherId }] };
    const config = { ASTEROID_DIFFICULTY_FACTOR: 0.65 };
    const dimensions = { width: 800, height: 600 };
    let reports = 0;
    const history = {
        scores: { counters: { [playerId]: 50, [otherId]: 350 } },
        numbers: { counters: { [playerId]: 1, [otherId]: 2 } },
    };
    const scoreView = { history, processedScores: { counters: { [shipId]: 5 } } };
    const functions = loadInlineGameFunctions([
        'beginLeaderboardRun', 'observeLeaderboardMembers', 'currentLeaderboardSnapshot',
        'checkpointLeaderboard', 'finishLeaderboardRun', 'projectParticipantScore',
    ], {
        game, Leaderboards, GuidUtils, CONFIG: config, crypto: { randomUUID: () => runId },
        leaderboardCaptureIssue: '', performance: { now: () => 10 },
        getGameWidth: () => dimensions.width, getGameHeight: () => dimensions.height,
        isSessionMode: () => game.mode === 'session',
        isGameOver: () => game.state === 'gameover',
        SessionClient: { getCurrentSession: () => session },
        getSessionScoreView: () => options.missingHistory ? null : scoreView,
        OBJECT_TYPES: { SHIP: 'ship' },
        ObjectSync: {
            getObjectsByType: () => [
                { id: shipId, data: { participantId: playerId, score: 12 } },
                { id: otherId, data: { participantId: otherId, score: 900 } },
            ],
        },
        leaderboardOutbox: {
            enqueue: async snapshot => {
                snapshots.push(snapshot);
                if (options.enqueue) await options.enqueue;
                return true;
            },
            flush: async () => {},
        },
        renderLeaderboardSaveStatus: () => { reports++; },
    });
    return { ...functions, game, session, config, dimensions, snapshots, reports: () => reports };
}

test('only eligible named players start records, with zero scores valid and a pinned solo run identity', async () => {
    for (const options of [{ guest: true }, { excluded: true }, { spectator: true, session: true }]) {
        const h = captureHarness(options);
        h.beginLeaderboardRun();
        await drain();
        assert.equal(h.game.leaderboardRun, null);
        assert.deepEqual(h.snapshots, []);
    }
    const h = captureHarness();
    h.game.score = 0;
    h.beginLeaderboardRun();
    await drain();
    assert.deepEqual(h.snapshots, [sample({ score: 0, aspectRatio: 4 / 3 })]);
    h.game.playerIdentity = { id: otherId, tag: 'Changed' };
    h.game.score = 10;
    await h.checkpointLeaderboard();
    assert.equal(h.snapshots.at(-1).playerId, playerId, 'In-flight runs cannot be retargeted to a new identity');
});

test('multiplayer submits the personal ledger plus unprocessed local score, never the team total', async () => {
    const h = captureHarness({ session: true });
    h.beginLeaderboardRun();
    await drain();
    assert.deepEqual(h.snapshots, [sample({ score: 70, teamSize: 2, aspectRatio: 4 / 3 })]);
    h.session.members.push({ id: 'guest-member' }, { id: 'spectator-member' });
    h.observeLeaderboardMembers();
    h.session.members.length = 1;
    await h.checkpointLeaderboard();
    assert.equal(h.snapshots.at(-1).teamSize, 4, 'Guests and spectators count as simultaneous members');
    assert.equal(h.snapshots.at(-1).score, 70);
    assert.notEqual(h.snapshots.at(-1).score, h.game.score);
});

test('unknown score histories are visibly unavailable rather than manufacturing zero records', async () => {
    const h = captureHarness({ session: true, missingHistory: true });
    h.beginLeaderboardRun();
    await drain();
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.reports(), 1);
});

test('spectators arriving after game over cannot inflate the finished player membership classification', async () => {
    const h = captureHarness({ session: true });
    h.beginLeaderboardRun();
    await drain();
    h.game.state = 'gameover';
    h.session.members.push({}, {});
    h.observeLeaderboardMembers();
    await h.checkpointLeaderboard();
    assert.equal(h.game.leaderboardRun.teamSize, 2);
    assert.equal(h.snapshots.at(-1).teamSize, 2);
});

test('checkpoint metadata follows the winning score/wave and membership survives same-session reentry', async () => {
    const h = captureHarness({ session: true });
    h.beginLeaderboardRun();
    await drain();
    const original = h.game.leaderboardRun;
    h.session.members.push({}, {});
    h.observeLeaderboardMembers();
    h.session.members.length = 2;
    h.beginLeaderboardRun();
    await drain();
    assert.equal(h.game.leaderboardRun, original);
    assert.equal(original.teamSize, 4);
    h.config.ASTEROID_DIFFICULTY_FACTOR = 0.2;
    h.dimensions.width = 300;
    await h.checkpointLeaderboard();
    assert.equal(h.snapshots.at(-1).difficulty, 0.65, 'Tied score/wave keeps its earlier classification');
    h.game.wave++;
    await h.checkpointLeaderboard();
    assert.equal(h.snapshots.at(-1).difficulty, 0.2);
    assert.equal(h.snapshots.at(-1).aspectRatio, 0.5);
});

test('leave freezes a checkpoint before resetting gameplay, without waiting for network delivery', async () => {
    const saving = deferred();
    const h = captureHarness({ enqueue: saving.promise });
    h.beginLeaderboardRun();
    const finishing = h.finishLeaderboardRun();
    assert.equal(h.game.leaderboardRun, null);
    h.game.score = 0;
    h.game.wave = 0;
    h.config.ASTEROID_DIFFICULTY_FACTOR = 0.2;
    h.dimensions.width = 300;
    saving.resolve();
    assert.equal(await finishing, true);
    assert.equal(h.snapshots.at(-1).score, 400);
    assert.equal(h.snapshots.at(-1).wave, 2);
    assert.equal(h.snapshots.at(-1).difficulty, 0.65);
    assert.equal(h.snapshots.at(-1).aspectRatio, 4 / 3);
});
