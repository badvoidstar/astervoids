// Regression tests for viewport-scaled analog anchor control geometry.
// Run with: node --test AstervoidsWeb/touch-anchor-scale.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'wwwroot/index.html'), 'utf8');

const scaleFnMatch = html.match(
    /function getAnalogAnchorScale\(\) \{[\s\S]*?\n    \}/
);
assert.ok(scaleFnMatch, 'getAnalogAnchorScale must be defined in index.html');

function getAnalogAnchorScale(referenceDimension, calibrationReference = 390) {
    // eslint-disable-next-line no-new-func
    const createScale = new Function(
        'getReferenceDimension',
        'CONFIG',
        `return (${scaleFnMatch[0]});`
    );
    return createScale(
        () => referenceDimension,
        { ANALOG_ANCHOR_REFERENCE_DIMENSION_PX: calibrationReference }
    )();
}

test('analog anchor scale matches the game reference dimension at a mobile baseline', () => {
    assert.equal(getAnalogAnchorScale(390), 1);
    assert.equal(getAnalogAnchorScale(195), 0.5);
    assert.equal(getAnalogAnchorScale(780), 2);
    assert.match(html, /ANALOG_ANCHOR_REFERENCE_DIMENSION_PX: 390/);
    assert.match(
        html,
        /function getReferenceDimension\(\) \{\s*return Math\.min\(getGameWidth\(\), getGameHeight\(\)\);/);
});

test('rectilinear and polar analog anchors apply scale to input and overlay geometry', () => {
    const updateStart = html.indexOf('        function updateStickAnalog() {');
    const updateEnd = html.indexOf(
        "        gameContainer.addEventListener('touchstart'",
        updateStart
    );
    assert.ok(updateStart >= 0 && updateEnd > updateStart);
    const updateSource = html.slice(updateStart, updateEnd);
    assert.match(updateSource, /const anchorScale = getAnalogAnchorScale\(\);/);
    assert.match(updateSource, /radiusPx: CONFIG\.ANALOG_STICK_RADIUS_PX \* anchorScale/);
    assert.match(
        updateSource,
        /turnDeadzonePx:\s*CONFIG\.ANALOG_RECTILINEAR_TURN_DEADZONE_PX \* anchorScale/);
    assert.match(
        updateSource,
        /thrustDeadzonePx:\s*CONFIG\.ANALOG_RECTILINEAR_THRUST_DEADZONE_PX \* anchorScale/);
    assert.match(
        updateSource,
        /deadZonePx:\s*CONFIG\.ANALOG_POLAR_DEADZONE_PX \* anchorScale/);
    assert.match(
        updateSource,
        /thresholdPx:\s*CONFIG\.ANALOG_POLAR_THRESHOLD_PX \* anchorScale/);
    assert.match(
        updateSource,
        /turnGain: CONFIG\.ANALOG_RECTILINEAR_TURN_GAIN/);
    assert.match(
        updateSource,
        /turnGain: CONFIG\.ANALOG_POLAR_TURN_GAIN/);

    const drawStart = html.indexOf('    function drawAnalogAnchors(ctx) {');
    const drawEnd = html.indexOf('    const fixedStep = {', drawStart);
    assert.ok(drawStart >= 0 && drawEnd > drawStart);
    const drawSource = html.slice(drawStart, drawEnd);
    assert.match(drawSource, /const anchorScale = getAnalogAnchorScale\(\);/);
    assert.match(
        drawSource,
        /ANALOG_RECTILINEAR_TURN_DEADZONE_PX \* anchorScale \* sx/);
    assert.match(
        drawSource,
        /ANALOG_RECTILINEAR_THRUST_DEADZONE_PX \* anchorScale \* sx/);
    assert.match(
        drawSource,
        /ANALOG_POLAR_DEADZONE_PX \* anchorScale \* sx/);
    assert.match(
        drawSource,
        /ANALOG_POLAR_THRESHOLD_PX \* anchorScale \* sx/);
});
