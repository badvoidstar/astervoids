import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'index.html'), 'utf8');

test('main-screen content is scaled without shrinking its backdrop', () => {
    assert.match(
        source,
        /#start-screen-content \{[\s\S]*?transform: scale\(0\.8\);[\s\S]*?transform-origin: center;/);
    assert.match(
        source,
        /<div id="start-screen">\s*<div id="start-screen-content">\s*<h1>ASTERVOIDS<\/h1>/);
});

test('main-screen vertical spacing is compressed without reducing font sizes', () => {
    assert.match(
        source,
        /#start-screen h1 \{[\s\S]*?font-size: clamp\(24px, 5vmin, 38px\);[\s\S]*?margin-bottom: clamp\(14px, 2\.7vmin, 27px\);/);
    assert.match(
        source,
        /#session-list \{[\s\S]*?max-height: 135px;[\s\S]*?margin-bottom: 18px;/);
    assert.match(
        source,
        /\.picker-btn \{[\s\S]*?font-size: 14px;[\s\S]*?padding: 8px 18px;/);
});
