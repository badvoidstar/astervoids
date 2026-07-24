// Regression tests for viewport-scaled anchor control geometry.
// Run with: node --test AstervoidsWeb/touch-anchor-scale.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'wwwroot/index.html'), 'utf8');

const scaleFnMatch = html.match(
    /function getTouchAnchorScale\(\) \{[\s\S]*?\n    \}/
);
assert.ok(scaleFnMatch, 'getTouchAnchorScale must be defined in index.html');

function getTouchAnchorScale(referenceDimension, calibrationReference = 390) {
    // eslint-disable-next-line no-new-func
    const createScale = new Function(
        'getReferenceDimension',
        'CONFIG',
        `return (${scaleFnMatch[0]});`
    );
    return createScale(
        () => referenceDimension,
        { TOUCH_ANCHOR_REFERENCE_DIMENSION_PX: calibrationReference }
    )();
}

test('touch anchor scale matches the game reference dimension at a mobile baseline', () => {
    assert.equal(getTouchAnchorScale(390), 1);
    assert.equal(getTouchAnchorScale(195), 0.5);
    assert.equal(getTouchAnchorScale(780), 2);
    assert.match(html, /TOUCH_ANCHOR_REFERENCE_DIMENSION_PX: 390/);
    assert.match(
        html,
        /function getReferenceDimension\(\) \{\s*return Math\.min\(getGameWidth\(\), getGameHeight\(\)\);/);
});

test('rectilinear and polar anchors apply the scale to input and overlay geometry', () => {
    const updateStart = html.indexOf('        function updateStickAnalog() {');
    const updateEnd = html.indexOf(
        "        gameContainer.addEventListener('touchstart'",
        updateStart
    );
    assert.ok(updateStart >= 0 && updateEnd > updateStart);
    const updateSource = html.slice(updateStart, updateEnd);
    assert.match(updateSource, /const anchorScale = getTouchAnchorScale\(\);/);
    assert.match(updateSource, /radiusPx: CONFIG\.TOUCH_STICK_RADIUS_PX \* anchorScale/);
    assert.match(updateSource, /turnDeadzonePx: CONFIG\.TOUCH_STICK_TURN_DEADZONE_PX \* anchorScale/);
    assert.match(updateSource, /thrustDeadzonePx: CONFIG\.TOUCH_STICK_THRUST_DEADZONE_PX \* anchorScale/);
    assert.match(updateSource, /deadZonePx: CONFIG\.TOUCH_POLAR_DEADZONE_PX \* anchorScale/);
    assert.match(updateSource, /thresholdPx: CONFIG\.TOUCH_POLAR_THRESHOLD_PX \* anchorScale/);

    const drawStart = html.indexOf('    function drawStickAnchors(ctx) {');
    const drawEnd = html.indexOf('    const fixedStep = {', drawStart);
    assert.ok(drawStart >= 0 && drawEnd > drawStart);
    const drawSource = html.slice(drawStart, drawEnd);
    assert.match(drawSource, /const anchorScale = getTouchAnchorScale\(\);/);
    assert.match(
        drawSource,
        /TOUCH_STICK_TURN_DEADZONE_PX \* anchorScale \* sx/);
    assert.match(
        drawSource,
        /TOUCH_STICK_THRUST_DEADZONE_PX \* anchorScale \* sx/);
    assert.match(
        drawSource,
        /TOUCH_POLAR_DEADZONE_PX \* anchorScale \* sx/);
    assert.match(
        drawSource,
        /TOUCH_POLAR_THRESHOLD_PX \* anchorScale \* sx/);
});
