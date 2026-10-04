import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'index.html'), 'utf8');

test('main-screen content uses native layout without scaling text or shrinking its backdrop', () => {
    const contentStyle = source.match(/#start-screen-content \{([^}]+)\}/)?.[1];
    assert.ok(contentStyle);
    assert.doesNotMatch(contentStyle, /transform/);
    assert.match(
        contentStyle, /max-height: 100%;[\s\S]*overflow-y: auto;/);
    assert.match(
        source,
        /<div id="start-screen">\s*<div id="start-screen-content">\s*<h1>ASTERVOIDS<\/h1>/);
});

test('portrait menu utilities stack and landscape uses a native two-column layout', () => {
    assert.match(source, /#menu-columns \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(source, /@media \(orientation: landscape\) \{/);
    assert.match(source, /#menu-utilities \.picker-btn \{[\s\S]*?min-height: 44px;/);
    for (const id of ['btn-control-mode', 'btn-fullscreen', 'btn-invite-self', 'btn-invite-friend']) {
        assert.match(source, new RegExp(`<button id="${id}"`));
    }
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
