import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'index.html'), 'utf8');
const functionMatch = source.match(
    /function drawViewportBorder\(ctx, viewport, canvasWidth, canvasHeight\) \{[\s\S]*?\n    \}/);
assert.ok(functionMatch, 'drawViewportBorder must be defined in index.html');

// eslint-disable-next-line no-eval
const drawViewportBorder = eval(`(${functionMatch[0]})`);

function draw(viewport, canvasWidth = 800, canvasHeight = 600) {
    const segments = [];
    let start;
    const ctx = {
        beginPath() {},
        moveTo(x, y) {
            start = [x, y];
        },
        lineTo(x, y) {
            segments.push([start, [x, y]]);
        },
        stroke() {},
    };
    drawViewportBorder(ctx, viewport, canvasWidth, canvasHeight);
    return segments;
}

test('pillarbox border includes only the two interior vertical edges', () => {
    assert.deepEqual(draw({ x: 100, y: 0, width: 600, height: 600 }), [
        [[700, 0], [700, 600]],
        [[100, 600], [100, 0]],
    ]);
});

test('letterbox border includes only the two interior horizontal edges', () => {
    assert.deepEqual(draw({ x: 0, y: 75, width: 800, height: 450 }), [
        [[0, 75], [800, 75]],
        [[800, 525], [0, 525]],
    ]);
});

test('fully inset viewport includes all edges', () => {
    assert.equal(draw({ x: 100, y: 75, width: 600, height: 450 }).length, 4);
});

test('window-filling viewport has no visible border edges', () => {
    assert.deepEqual(draw({ x: 0, y: 0, width: 800, height: 600 }), []);
});
