import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

function touchHarness() {
    const helper = source.match(/    function isMenuScrollTarget\(target\) \{[\s\S]*?\n    \}/)?.[0];
    const stickTarget = source.match(/        function isStickTouchTarget\(target\) \{[\s\S]*?\n        \}/)?.[0];
    const start = source.indexOf('    // Keep gameplay gestures captured');
    const end = source.indexOf('    // ─── Anchor-based analog schemes', start);
    assert.ok(helper && stickTarget && start >= 0 && end > start);
    const handlers = new Map();
    const state = { menuHidden: false, leaderboardHidden: true, touches: 0 };
    const isStickTouchTarget = runInNewContext(
        `${helper}\n${source.slice(start, end)}\n(${stickTarget})`,
        {
            startScreen: { classList: { contains: () => state.menuHidden } },
            leaderboardScreen: { get hidden() { return state.leaderboardHidden; } },
            document: { getElementById: () => ({
                addEventListener(type, handler, options) {
                    assert.equal(options.passive, false);
                    handlers.set(type, handler);
                },
            }) },
            enableTouchControls: () => state.touches++,
            isPersonalScoreScrollTarget: target => !!target?.results,
        });
    return {
        state, isStickTouchTarget,
        dispatch(type, target) {
            let prevented = false;
            handlers.get(type)({ target, preventDefault: () => { prevented = true; } });
            return prevented;
        },
    };
}

function target({ menu = false, results = false, button = false, leaderboard = false } = {}) {
    return {
        results,
        classList: { contains: value => value === 'touch-btn' && button },
        closest: selector => (selector === '#start-screen-content' && menu)
            || (selector === '#leaderboard-screen' && leaderboard) ? {} : null,
    };
}

test('menu descendants keep native touch starts and moves without steering or firing', () => {
    const h = touchHarness();
    const child = target({ menu: true });
    assert.equal(h.dispatch('touchstart', child), false);
    assert.equal(h.dispatch('touchmove', child), false);
    assert.equal(h.state.touches, 1, 'Touch UI still activates when scrolling the menu');
    assert.equal(h.isStickTouchTarget(child), false);
});

test('canvas starts and drags remain captured by the gameplay touch controls', () => {
    const h = touchHarness();
    const canvas = target();
    assert.equal(h.dispatch('touchstart', canvas), true);
    assert.equal(h.dispatch('touchmove', canvas), true);
    assert.equal(h.isStickTouchTarget(canvas), true);
});

test('leaderboard gestures stay in its pointer scroller and never acquire gameplay anchors', () => {
    const h = touchHarness();
    h.state.menuHidden = true;
    h.state.leaderboardHidden = false;
    const child = target({ leaderboard: true });
    assert.equal(h.dispatch('touchstart', child), false);
    assert.equal(h.dispatch('touchmove', child), false);
    assert.equal(h.isStickTouchTarget(child), false);
    h.state.leaderboardHidden = true;
    assert.equal(h.isStickTouchTarget(child), true);
});

test('only visible menu content receives the native scrolling exemption', () => {
    const h = touchHarness();
    h.state.menuHidden = true;
    const child = target({ menu: true });
    assert.equal(h.dispatch('touchstart', child), true);
    assert.equal(h.dispatch('touchmove', child), true);
    assert.equal(h.isStickTouchTarget(child), true);
});

test('results scrolling and dedicated touch buttons retain their existing input routing', () => {
    const h = touchHarness();
    const results = target({ results: true });
    assert.equal(h.dispatch('touchstart', results), false);
    assert.equal(h.dispatch('touchmove', results), false);
    assert.equal(h.isStickTouchTarget(results), false);
    const button = target({ button: true });
    assert.equal(h.dispatch('touchstart', button), false);
    assert.equal(h.dispatch('touchmove', button), true);
    assert.equal(h.isStickTouchTarget(button), false);
    assert.equal(h.isStickTouchTarget(null), false);
});
