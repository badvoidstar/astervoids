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
