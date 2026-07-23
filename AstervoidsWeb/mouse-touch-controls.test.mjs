// Unit tests for the mouse-to-movement-touch adapter in the inline game runtime.
// Run with: node --test AstervoidsWeb/mouse-touch-controls.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'wwwroot/index.html'), 'utf8');

const boundsFn = html.match(
    /function isPointWithinRect\(clientX, clientY, rect\) \{[\s\S]*?\n {8}\}/
);
assert.ok(boundsFn, 'isPointWithinRect must be defined in index.html');
// eslint-disable-next-line no-eval
const isPointWithinRect = eval(
    `(${boundsFn[0].replace('function isPointWithinRect', 'function')})`
);

function mouseControlSource() {
    const start = html.indexOf('        // Mouse movement control:');
    const end = html.indexOf('        // Drop any held anchors', start);
    assert.ok(start >= 0, 'mouse movement control must be defined');
    assert.ok(end > start, 'mouse movement control must end before reset handlers');
    return html.slice(start, end);
}

test('canvas hit-test accepts the full renderable region, including all edges', () => {
    const rect = { left: 100, right: 900, top: 200, bottom: 800 };

    assert.equal(isPointWithinRect(100, 200, rect), true);
    assert.equal(isPointWithinRect(900, 800, rect), true);
    assert.equal(isPointWithinRect(850, 500, rect), true,
        'the right half remains valid for mouse movement input');
    assert.equal(isPointWithinRect(99.9, 500, rect), false);
    assert.equal(isPointWithinRect(500, 800.1, rect), false);
});

test('left mouse drag is movement-only and can leave the canvas', () => {
    const source = mouseControlSource();
    const moveStart = source.indexOf("document.addEventListener('mousemove'");
    const mouseUpStart = source.indexOf("document.addEventListener('mouseup'");
    assert.ok(moveStart >= 0, 'mouse movement must be tracked globally');
    assert.ok(mouseUpStart > moveStart, 'left-button release must follow movement handling');

    assert.match(source, /e\.button !== 0/);
    assert.match(source, /isPointWithinRect\(e\.clientX, e\.clientY, canvas\.getBoundingClientRect\(\)\)/);
    assert.match(source, /beginMoveAnchor\(MOUSE_MOVE_TOUCH_ID, e\.clientX, e\.clientY\)/);
    assert.match(source, /updateMoveAnchor\(MOUSE_MOVE_TOUCH_ID, e\.clientX, e\.clientY\)/);
    assert.match(source, /endMoveAnchor\(MOUSE_MOVE_TOUCH_ID\)/);
    assert.match(source, /setMouseMoveControlActive\(true\)/);
    assert.match(source, /setMouseMoveControlActive\(false\)/);
    assert.doesNotMatch(source, /fireTouchId\s*=\s*MOUSE_MOVE_TOUCH_ID/);
    assert.doesNotMatch(
        source.slice(moveStart, mouseUpStart),
        /isPointWithinRect/,
        'a held mouse movement must remain active outside the canvas'
    );
});

test('mouse drag leaves OS cursor styling unchanged', () => {
    assert.doesNotMatch(html, /mouse-move-control-active/);
    assert.doesNotMatch(html, /cursor:\s*none\s*!important/);
});
