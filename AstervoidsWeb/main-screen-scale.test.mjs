import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function fittingFixture(overrides = {}) {
    const layout = {
        landscape: true, viewport: 300, headingSpace: 100, scrollTop: 0,
        listHeight: 75.2, contentHeight: 300, actionsHeight: 80,
        groupHeights: [100, 30], utilityHeight: 160,
        ...overrides,
    };
    let height = '';
    let writes = 0;
    const list = {
        getBoundingClientRect: () => ({ height: layout.listHeight }),
        style: {
            marginBottom: '14px',
            getPropertyValue: () => height,
            setProperty(name, value) {
                assert.equal(name, '--session-list-available');
                height = value;
                writes++;
            },
        },
    };
    const elements = {
        'start-screen-content': {
            get scrollTop() { return layout.scrollTop; },
            get scrollHeight() { return layout.contentHeight; },
            getBoundingClientRect: () => ({ top: 20 }),
            style: { paddingBottom: '16px' },
        },
        'menu-columns': {
            getBoundingClientRect: () => ({ top: 20 + layout.headingSpace - layout.scrollTop }),
            style: { rowGap: '10px' },
        },
        'picker-buttons': {
            getBoundingClientRect: () => ({ height: layout.actionsHeight }),
        },
        'menu-utilities': {
            getBoundingClientRect: () => ({ height: layout.utilityHeight }),
            get children() {
                return layout.groupHeights.map(height => ({
                    getBoundingClientRect: () => ({ height }),
                }));
            },
            style: { rowGap: '10px' },
        },
    };
    const { fitSessionListToViewport } = loadInlineGameFunctions(['fitSessionListToViewport'], {
        isSessionPickerVisible: () => true,
        startScreen: { get clientHeight() { return layout.viewport; } },
        document: { getElementById: id => elements[id] },
        getComputedStyle: element => element.style,
        matchMedia: query => {
            assert.equal(query, '(orientation: landscape)');
            return { matches: layout.landscape };
        },
        sessionPicker: { listEl: list },
    });
    return {
        layout, fit: fitSessionListToViewport,
        get height() { return height; },
        get writes() { return writes; },
    };
}

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
    for (const id of ['btn-control-mode', 'btn-difficulty', 'btn-fullscreen', 'btn-leaderboards', 'btn-invite-self', 'btn-invite-friend']) {
        assert.match(source, new RegExp(`<button id="${id}"`));
    }
});

test('leaderboards is second after fullscreen, followed by paired device settings with no reserved slots', () => {
    assert.match(source,
        /<div class="menu-utility-group">\s*<button id="btn-fullscreen"[^>]*>[^<]*<\/button>\s*<button id="btn-leaderboards" class="picker-btn solo">Leaderboards<\/button>\s*<div class="button-row">\s*<button id="btn-control-mode" class="picker-btn solo">🕹️ : Polar<\/button>\s*<button id="btn-difficulty" class="picker-btn solo">🎯 : Dancer<\/button>\s*<\/div>\s*<\/div>/);
    for (const mode of ['fullscreen-active', 'standalone-mode', 'pseudo-fullscreen']) {
        assert.match(source, new RegExp(`\\.${mode} #btn-fullscreen[,\\s][^}]*display: none;`));
    }
});

test('session lists default to two button rows, fit the viewport, and truncate labels without horizontal scrolling', () => {
    const listStyle = source.match(/#session-list \{([^}]+)\}/)?.[1];
    assert.ok(listStyle);
    assert.match(listStyle, /\n\s*height: calc\(2 \* var\(--menu-button-height\) \+ var\(--menu-row-gap\)\);/);
    assert.match(listStyle, /min-height: var\(--menu-button-height\);/);
    assert.match(listStyle, /max-height: var\(--session-list-available, 100dvh\);/);
    assert.match(listStyle, /overflow-x: hidden;/);
    assert.match(listStyle, /overflow-y: auto;/);
    assert.match(listStyle, /overscroll-behavior: contain;/);
    assert.match(listStyle, /touch-action: pan-y;/);
    assert.match(source, /#start-screen-content > \* \{ flex-shrink: 0; \}/);
    const nameStyle = source.match(/\.session-item \.session-name \{([^}]+)\}/)?.[1];
    assert.ok(nameStyle);
    assert.match(nameStyle, /min-width: 0;/);
    assert.match(nameStyle, /white-space: nowrap;/);
    assert.match(nameStyle, /overflow: hidden;/);
    assert.match(nameStyle, /text-overflow: ellipsis;/);
    assert.match(source, /\.session-item \.session-players \{[^}]*white-space: nowrap;/);
});

test('session list fitting reserves fixed controls and never shrinks below the useful landscape budget', () => {
    for (const [overrides, expected] of [
        [{ viewport: 300 }, '90px'],
        [{ viewport: 260 }, '50px'],
        [{ viewport: 240 }, '46px'],
        [{ viewport: 200 }, '46px'],
        [{ viewport: 240, groupHeights: [60, 30] }, '30px'],
        [{ viewport: 300, actionsHeight: 120 }, '50px'],
        [{ viewport: 300, headingSpace: 140 }, '50px'],
        [{ landscape: false, viewport: 600 }, '220px'],
        [{ landscape: false, viewport: 400 }, '20px'],
        [{ landscape: false, viewport: 300 }, '0px'],
        [{ viewport: 300, headingSpace: 100.25, actionsHeight: 80.5 }, '89.25px'],
    ]) {
        const fixture = fittingFixture(overrides);
        fixture.fit();
        assert.equal(fixture.height, expected, JSON.stringify(overrides));
        fixture.fit();
        assert.equal(fixture.writes, 1, 'An unchanged budget does not trigger another layout mutation');
    }
});

test('the list budget is independent of previous list height, grid stretching, scrolling and resize order', () => {
    const fixture = fittingFixture();
    for (const [viewport, expected] of [[300, '90px'], [200, '46px'], [260, '50px'], [300, '90px']]) {
        fixture.layout.viewport = viewport;
        for (const listHeight of [32, 48, 75.2]) {
            Object.assign(fixture.layout, { listHeight, contentHeight: 450, scrollTop: 40 });
            fixture.fit();
            assert.equal(fixture.height, expected);
        }
    }
    fixture.layout.landscape = false;
    fixture.fit();
    assert.equal(fixture.height, '0px', 'Portrait reserves the stacked utility column');
    fixture.layout.landscape = true;
    fixture.fit();
    assert.equal(fixture.height, '90px', 'Returning to landscape releases the portrait budget');
});

test('hidden pickers do not measure or mutate menu layout', () => {
    const { fitSessionListToViewport } = loadInlineGameFunctions(['fitSessionListToViewport'], {
        isSessionPickerVisible: () => false,
    });
    assert.doesNotThrow(fitSessionListToViewport);
});

test('landscape aligns the play and utility groups without reserving hidden button slots', () => {
    const landscape = source.match(/@media \(orientation: landscape\) \{([\s\S]*?)\n {8}\}/)?.[1];
    assert.ok(landscape);
    assert.match(landscape, /#menu-play \{[^}]*display: flex;[^}]*flex-direction: column;/);
    assert.match(landscape, /#picker-buttons \{ margin-top: auto; \}/);
    assert.match(source, /#menu-columns \{[^}]*--menu-row-gap: 11\.2px;/);
    assert.match(landscape, /#menu-utilities \{[^}]*justify-content: space-between;[^}]*gap: var\(--menu-row-gap\);/);
    assert.match(landscape, /\.menu-utility-group \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: var\(--menu-row-gap\);/);
    assert.match(landscape, /#menu-utilities \.picker-btn\.solo \{ margin-top: 0; \}/);
    assert.match(source, /\.menu-utility-group \{ display: contents; \}/);
    assert.equal(source.match(/class="menu-utility-group"/g)?.length, 2);
});

test('session and region pickers share the standard menu row spacing', () => {
    const listStyle = source.match(/#session-list \{([^}]+)\}/)?.[1];
    assert.ok(listStyle);
    assert.match(source, /#menu-columns \{[^}]*--menu-row-gap: 11\.2px;/);
    assert.match(listStyle, /margin-bottom: var\(--menu-row-gap\);/);
});

test('the native region picker shares button dimensions without a visible caption', () => {
    const selectStyle = source.match(/#create-region-select \{([^}]+)\}/)?.[1];
    const buttonStyle = source.match(/#menu-columns \.picker-btn \{([^}]+)\}/)?.[1];
    for (const style of [selectStyle, buttonStyle]) {
        assert.ok(style);
        assert.match(style, /\n\s*width: 100%;/);
        assert.match(style, /\n\s*height: var\(--menu-button-height\);/);
    }
    assert.doesNotMatch(selectStyle, /min-height|appearance|transform/);
    const row = source.match(/<div class="region-select-row"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.ok(row);
    assert.match(row, /<select id="create-region-select" aria-label="Host region"><\/select>/);
    assert.doesNotMatch(row, /<label\b/);
});

test('main-menu buttons keep Solo Play height while lobby, settings and invite actions share rows', () => {
    const buttonStyle = source.match(/#menu-columns \.picker-btn \{([^}]+)\}/)?.[1];
    assert.ok(buttonStyle);
    assert.match(buttonStyle, /width: 100%;/);
    assert.match(source, /#menu-columns \{[^}]*--menu-button-height: 32px;/);
    assert.match(buttonStyle, /height: var\(--menu-button-height\);/);
    assert.match(buttonStyle, /font-size: 11px;/);
    assert.match(buttonStyle, /line-height: 12px;/);
    assert.match(buttonStyle, /padding: 2px min\(8px, 1vw\);/);
    assert.match(buttonStyle, /transition-property: background-color, border-color, color, opacity;/);
    const rowStyle = source.match(/#menu-columns \.button-row \{([^}]+)\}/)?.[1];
    assert.ok(rowStyle);
    assert.match(rowStyle, /flex-direction: row;/);
    assert.match(rowStyle, /gap: 7\.2px;/);
    const rowButtonStyle = source.match(/#menu-columns \.button-row \.picker-btn \{([^}]+)\}/)?.[1];
    assert.ok(rowButtonStyle);
    assert.match(rowButtonStyle, /flex: 1;/);
    assert.match(rowButtonStyle, /min-width: 0;/);
    assert.doesNotMatch(source, /regional-create|create-region-label|#menu-utilities \.button-row \.picker-btn \{/);
});

test('invite actions share one utility row and retain their existing button styling', () => {
    assert.match(source,
        /<div class="menu-utility-group">\s*<div class="button-row">\s*<button id="btn-invite-self" class="picker-btn solo">Invite Self<\/button>\s*<button id="btn-invite-friend" class="picker-btn solo">Invite Friend<\/button>\s*<\/div>\s*<\/div>/);
});

test('paired setting labels fit narrow rows with native font size and compact tracking', () => {
    assert.match(source, /#btn-control-mode,\s*#btn-difficulty \{\s*letter-spacing: 0;\s*\}/);
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
        /\.picker-btn \{[\s\S]*?font-size: 14px;[\s\S]*?padding: 8px 18px;/);
    for (const [selector, property, previous] of [
        ['#menu-columns', 'row-gap', 12],
        ['#menu-utilities', 'gap', 7],
        ['#menu-columns .picker-btn.solo', 'margin-top', 7],
        ['#identity-status', 'margin-bottom', 10],
        ['#session-picker .picker-status', 'margin-bottom', 14],
        ['#region-banner', 'margin-bottom', 9],
        ['.region-select-row', 'margin-bottom', 7],
        ['#picker-buttons', 'gap', 7],
    ]) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const propertyPattern = new RegExp(`(?:^|[;\\n])\\s*${property}: ([\\d.]+)px;`);
        const style = [...source.matchAll(new RegExp(`${escaped} \\{([^}]+)\\}`, 'g'))]
            .map(match => match[1]).find(rule => propertyPattern.test(rule));
        assert.ok(style, `${selector} defines ${property}`);
        const value = Number(style.match(propertyPattern)[1]);
        assert.equal(value, Number((previous * 0.8).toFixed(1)), `${selector} ${property} is reduced by 20%`);
    }
    assert.match(source, /#menu-columns \{[^}]*column-gap: 12px;/);
});
