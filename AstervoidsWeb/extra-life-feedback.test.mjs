import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'index.html'), 'utf8');

test('extra-life feedback flashes the lives HUD at 5 Hz for five seconds', () => {
    assert.match(
        source,
        /animation: life-award-flash 200ms steps\(1, end\) 25;/);
    assert.match(
        source,
        /text-shadow:\s*0 0 6px #fff,\s*0 0 18px #ff0,\s*0 0 36px #ff0,\s*0 0 54px #ff0;/);
    assert.match(
        source,
        /setTimeout\(\(\) => \{[\s\S]*?livesDisplay\.classList\.remove\('life-award'\);\s*\}, 5000\);/);
});
