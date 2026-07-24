// Unit tests for the mouse-to-touch adapters in the inline game runtime.
// Run with: node --test AstervoidsWeb/mouse-touch-controls.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'wwwroot/index.html'), 'utf8');
const gameConfig = readFileSync(join(here, 'wwwroot/js/game-config.js'), 'utf8');

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

function mouseFireControlSource() {
    const start = html.indexOf('        // Mouse fire control:');
    const end = html.indexOf('        // Drop any held anchors', start);
    assert.ok(start >= 0, 'mouse fire control must be defined');
    assert.ok(end > start, 'mouse fire control must end before reset handlers');
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

test('legacy on-screen movement and fire buttons are absent', () => {
    assert.doesNotMatch(
        html,
        /id="touch-(left|right|thrust|fire)"/);
    assert.doesNotMatch(
        html,
        /const touch = \{/);
    assert.doesNotMatch(
        html,
        /function (setTouchState|setupTouchButton)\(/);
});

test('picker provides a polar-default analog mode toggle instead of a config selector', () => {
    const soloIndex = html.indexOf('id="btn-solo"');
    const controlModeIndex = html.indexOf('id="btn-control-mode"');
    const fullscreenIndex = html.indexOf('id="btn-fullscreen"');
    assert.ok(soloIndex >= 0 && controlModeIndex > soloIndex
        && fullscreenIndex > controlModeIndex);
    assert.match(
        html.slice(soloIndex, controlModeIndex),
        /Start Solo Play/);
    assert.match(
        html.slice(controlModeIndex, fullscreenIndex),
        /🕹️ Polar/);
    assert.match(
        html,
        /let analogControlScheme = ANALOG_CONTROL_SCHEMES\.POLAR/);
    assert.match(
        html,
        /function toggleAnalogControlScheme\(\)/);
    assert.match(
        html,
        /analogControlScheme === ANALOG_CONTROL_SCHEMES\.POLAR[\s\S]*?ANALOG_CONTROL_SCHEMES\.RECTILINEAR/);
    assert.match(
        html,
        /analogControlModeButton\.textContent = `🕹️ \$\{currentLabel\}`/);
    assert.match(
        html,
        /analogControlModeButton\.addEventListener\('click', toggleAnalogControlScheme\)/);
    assert.doesNotMatch(html, /\bANALOG_CONTROL_SCHEME\b/);
    assert.doesNotMatch(gameConfig, /\bANALOG_CONTROL_SCHEME\b/);
});

test('picker labels multiplayer creation consistently', () => {
    assert.match(
        html,
        /id="btn-leave-create" class="picker-btn" disabled>Create Multiplayer<\/button>/);
    assert.match(html, /Create Multiplayer in \$\{regionName\}/);
    assert.match(html, /: 'Create Multiplayer'/);
});

test('right touch and mouse use held firing without an analog anchor', () => {
    const source = mouseFireControlSource();

    assert.match(html, /side === 'fire' && beginFireInput\(t\.identifier\)/);
    assert.match(html, /endFireInput\(t\.identifier\)/);
    assert.doesNotMatch(
        html,
        /fireAnchor|fireCurrent|fireTurnTarget|fireThrustInput|fireBrakeInput/
    );
    assert.doesNotMatch(html, /TOUCH_RIGHT_ANCHOR_EXCLUSIVE_THRUST/);
    assert.doesNotMatch(gameConfig, /TOUCH_RIGHT_ANCHOR_EXCLUSIVE_THRUST/);

    assert.match(source, /e\.button !== 2/);
    assert.match(source, /isPointWithinRect\(e\.clientX, e\.clientY, canvas\.getBoundingClientRect\(\)\)/);
    assert.match(source, /beginFireInput\(MOUSE_FIRE_TOUCH_ID\)/);
    assert.match(source, /endFireInput\(MOUSE_FIRE_TOUCH_ID\)/);
    assert.match(source, /document\.addEventListener\('contextmenu'/);
    assert.match(source, /mouseFireContextMenuTargets\?\.includes\(e\.target\)/);
    assert.match(source, /e\.preventDefault\(\)/);
    assert.doesNotMatch(source, /MOUSE_FIRE_CONTEXT_MENU_GRACE_MS|mouseFireContextMenuDeadline/);

    const rightMouseStart = source.indexOf("gameContainer.addEventListener('mousedown'");
    const mouseMoveStart = source.indexOf("document.addEventListener('mousemove'");
    assert.ok(rightMouseStart >= 0 && mouseMoveStart > rightMouseStart);
    assert.doesNotMatch(
        source.slice(rightMouseStart, mouseMoveStart),
        /mouseMoveControlActive/,
        'right-click firing must remain available while left-click movement is held'
    );
});
