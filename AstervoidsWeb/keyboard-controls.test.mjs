// Unit tests for keyboard control contracts in the inline game runtime.
// Run with: node --test AstervoidsWeb/keyboard-controls.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'wwwroot/index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker, start);
    assert.ok(start >= 0, `${startMarker} must exist`);
    assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
    return html.slice(start, end);
}

const neutralBrakeMatch = html.match(
    /function getNeutralAnalogBrakeInput\(\) \{[\s\S]*?\n {4}\}/
);
assert.ok(neutralBrakeMatch, 'getNeutralAnalogBrakeInput must be defined');
// eslint-disable-next-line no-new-func
const makeNeutralAnalogBrakeInput = new Function(
    'CONFIG',
    `${neutralBrakeMatch[0]}; return getNeutralAnalogBrakeInput;`
);

function handleInputSource() {
    return sourceBetween('    function handleInput(dt = 1)', '    function checkCollisions()');
}

test('S and Down Arrow use the same configured brake magnitude as a neutral polar analog input', () => {
    assert.equal(
        makeNeutralAnalogBrakeInput({ ANALOG_BRAKE_GAIN: 1, ANALOG_BRAKE_MAX: 1 })(),
        1
    );
    assert.equal(
        makeNeutralAnalogBrakeInput({ ANALOG_BRAKE_GAIN: 0.6, ANALOG_BRAKE_MAX: 1 })(),
        0.6
    );
    assert.equal(
        makeNeutralAnalogBrakeInput({ ANALOG_BRAKE_GAIN: 2, ANALOG_BRAKE_MAX: 0.4 })(),
        0.4
    );
    assert.equal(
        makeNeutralAnalogBrakeInput({ ANALOG_BRAKE_GAIN: 1, ANALOG_BRAKE_MAX: 0 })(),
        0
    );
});

test('S and Down Arrow are independent brake inputs that remain active with a movement anchor', () => {
    const inputSource = sourceBetween('    // Unified input helpers', '    // SECTION 4B:');
    const handleInput = handleInputSource();

    assert.match(inputSource, /brake: \(\) => keys\['KeyS'\] \|\| keys\['ArrowDown'\]/);
    assert.match(handleInput, /const keyboardBrake = input\.brake\(\) \? getNeutralAnalogBrakeInput\(\) : 0/);
    assert.match(handleInput, /Math\.max\(keyboardBrake, stickInput\.polarBrake\)/);
    assert.match(handleInput, /Math\.max\(keyboardBrake, stickInput\.brakeInput\)/);
});

test('Enter resumes the solo pause menu while Escape restarts it', () => {
    const mainKeydown = sourceBetween(
        '    // Track key presses',
        "    document.addEventListener('keyup'"
    );
    const escapeStart = mainKeydown.indexOf("if (e.code === 'Escape')");
    const enterStart = mainKeydown.indexOf("if (e.code === 'Enter')");
    const pauseKeyStart = mainKeydown.indexOf("if (e.code === 'KeyP'");
    assert.ok(escapeStart >= 0 && enterStart > escapeStart && pauseKeyStart > enterStart);

    const escapeBlock = mainKeydown.slice(escapeStart, enterStart);
    const enterBlock = mainKeydown.slice(enterStart, pauseKeyStart);
    const handleInput = handleInputSource();

    assert.match(escapeBlock, /isSessionMode\(\) \|\| sessionPicker\.currentSessionId/);
    assert.match(escapeBlock, /returnToStartScreen\(\)/);
    assert.match(escapeBlock, /game\.state !== 'paused'/);
    assert.match(escapeBlock, /togglePause\(\)/);
    assert.match(enterBlock, /!e\.repeat/);
    assert.match(enterBlock, /game\.state === 'paused'/);
    assert.match(enterBlock, /togglePause\(\)/);
    assert.match(
        handleInput,
        /if \(isGameOver\(\)\) \{[\s\S]*?if \(keys\['Enter'\]\)/
    );
    assert.match(
        handleInput,
        /if \(game\.state === 'paused'\) \{[\s\S]*?if \(keys\['Escape'\]\)/
    );

    assert.match(html, /ESC to pause/);
    assert.match(html, /Down Arrow or S to brake/);
    assert.match(html, /<span>ENTER<\/span> or <span>P<\/span> - Resume/);
    assert.match(html, /<span>DOWN<\/span> \/ <span>S<\/span> - Brake/);
    assert.match(html, /<span>ESC<\/span> - Restart Game/);
    assert.match(html, /Press ENTER for menu/);
});
