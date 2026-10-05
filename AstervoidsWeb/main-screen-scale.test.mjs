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
    assert.match(source,
        /@media \(orientation: landscape\) \{[\s\S]*?#menu-columns \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    for (const id of ['btn-control-mode', 'btn-fullscreen', 'btn-invite-self', 'btn-invite-friend']) {
        assert.match(source, new RegExp(`<button id="${id}"`));
    }
});

test('every main-menu button shares Solo Play sizing without split-width lobby actions', () => {
    const buttonStyle = source.match(/#menu-columns \.picker-btn \{([^}]+)\}/)?.[1];
    assert.ok(buttonStyle);
    assert.match(buttonStyle, /width: 100%;/);
    assert.match(buttonStyle, /height: 32px;/);
    assert.match(buttonStyle, /font-size: 11px;/);
    assert.match(buttonStyle, /line-height: 12px;/);
    assert.match(buttonStyle, /padding-inline: min\(18px, 2vw\);/);
    assert.match(buttonStyle, /transition-property: background-color, border-color, color, opacity;/);
    assert.match(source, /#picker-buttons \.button-row \{[^}]*flex-direction: column;/);
});

test('enabled main-menu labels are uniformly bright without removing disabled indicators', () => {
    const enabledStyle = source.match(/#menu-columns \.picker-btn:not\(:disabled\) \{([^}]+)\}/)?.[1];
    assert.ok(enabledStyle);
    assert.match(enabledStyle, /color: #fff;/);
    const disabledStyle = source.match(/\.picker-btn:disabled \{([^}]+)\}/)?.[1];
    assert.ok(disabledStyle);
    assert.match(disabledStyle, /opacity: 0\.4;/);
    assert.match(disabledStyle, /cursor: not-allowed;/);
});

test('main-screen vertical spacing is compressed without reducing font sizes', () => {
    assert.match(
        source,
        /#start-screen h1 \{[\s\S]*?font-size: clamp\(24px, 5vmin, 38px\);[\s\S]*?margin-bottom: clamp\(11\.2px, 2\.16vmin, 21\.6px\);/);
    assert.match(
        source,
        /#session-list \{[\s\S]*?max-height: 135px;[\s\S]*?margin-bottom: 14\.4px;/);
    assert.match(
        source,
        /\.picker-btn \{[\s\S]*?font-size: 14px;[\s\S]*?padding: 8px 18px;/);
    for (const [selector, property, previous] of [
        ['#menu-columns', 'row-gap', 12],
        ['#menu-utilities', 'gap', 7],
        ['#menu-columns .picker-btn.solo', 'margin-top', 7],
        ['#identity-status', 'margin-bottom', 10],
        ['#session-picker .picker-status', 'margin-bottom', 14],
        ['#session-list', 'margin-bottom', 18],
        ['#region-banner', 'margin-bottom', 9],
        ['.region-select-row', 'gap', 5],
        ['.region-select-row', 'margin-bottom', 7],
        ['#picker-buttons', 'gap', 7],
        ['#picker-buttons .button-row', 'gap', 9],
    ]) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const style = source.match(new RegExp(`${escaped} \\{([^}]+)\\}`))?.[1];
        assert.ok(style, `${selector} exists`);
        const value = Number(style.match(new RegExp(`${property}: ([\\d.]+)px;`))?.[1]);
        assert.equal(value, Number((previous * 0.8).toFixed(1)), `${selector} ${property} is reduced by 20%`);
    }
    assert.match(source, /#menu-columns \{[^}]*column-gap: 12px;/);
});
