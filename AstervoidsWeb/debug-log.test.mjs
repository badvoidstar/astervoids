import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DebugLog = require('./wwwroot/js/debug-log.js');

const html = readFileSync(new URL('./wwwroot/index.html', import.meta.url), 'utf8');

function captureConsole(run) {
    const captured = [];
    const originals = {};
    for (const level of ['log', 'warn', 'error']) {
        originals[level] = console[level];
        console[level] = (...args) => captured.push([level, ...args]);
    }
    try {
        run();
    } finally {
        Object.assign(console, originals);
    }
    return captured;
}

test('debug helpers stay silent unless the debug flag is set', () => {
    const previous = globalThis.window;
    globalThis.window = { ASTERVOIDS_DEBUG: false };
    try {
        const quiet = captureConsole(() => {
            DebugLog.log('a');
            DebugLog.warn('b');
            DebugLog.error('c');
        });
        assert.deepEqual(quiet, []);
    } finally {
        globalThis.window = previous;
    }
});

test('debug helpers read the flag per call so it can be toggled live', () => {
    const previous = globalThis.window;
    const win = { ASTERVOIDS_DEBUG: false };
    globalThis.window = win;
    try {
        const captured = captureConsole(() => {
            DebugLog.log('before');
            win.ASTERVOIDS_DEBUG = true;
            DebugLog.log('after', 1);
            DebugLog.warn('warned');
            DebugLog.error('failed');
        });
        assert.deepEqual(captured, [
            ['log', 'after', 1],
            ['warn', 'warned'],
            ['error', 'failed']
        ]);
    } finally {
        globalThis.window = previous;
    }
});

test('debug helpers tolerate a missing window (non-browser hosts)', () => {
    const previous = globalThis.window;
    delete globalThis.window;
    try {
        assert.deepEqual(captureConsole(() => DebugLog.log('x')), []);
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
});

test('debug-log.js loads before every classic script that logs through it', () => {
    const debugLog = html.indexOf('/js/debug-log.js');
    assert.ok(debugLog > 0, 'index.html must load /js/debug-log.js');
    for (const consumer of ['/js/spectator-client.js', '/js/session-client.js', '/js/object-sync.js']) {
        const at = html.indexOf(consumer);
        assert.ok(at > 0, `index.html must load ${consumer}`);
        assert.ok(debugLog < at, `${consumer} must load after debug-log.js`);
    }
    assert.ok(debugLog < html.indexOf('ASTERVOIDS GAME'),
        'debug-log.js must load before the inline runtime destructures it');
});

test('the debug helpers are defined once and shared by every consumer', () => {
    const sources = [
        html,
        ...['spectator-client', 'session-client', 'object-sync'].map(name =>
            readFileSync(new URL(`./wwwroot/js/${name}.js`, import.meta.url), 'utf8'))
    ];
    for (const source of sources) {
        assert.equal(
            [...source.matchAll(/const _(?:log|warn|error) = \(\.\.\./g)].length, 0,
            'consumers must destructure AstervoidsDebugLog instead of redefining helpers');
    }
});
