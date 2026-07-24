import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'wwwroot', 'srvmon', 'index.html'), 'utf8');

test('srvmon loads the regional bootstrap and RTT service', () => {
    assert.match(source, /<script src="\/region-bootstrap\.js"><\/script>/);
    assert.match(source, /<script src="\/js\/region-service\.js"><\/script>/);
    assert.match(source, /await window\.RegionService\.load\(\)/);
    assert.match(source, /window\.RegionService\.bestRegion\(\)/);
});

test('srvmon polls the selected regional monitor endpoint with CORS', () => {
    assert.match(source, /selectedRegion\.hostname/);
    assert.match(source, /\/api\/srvmon/);
    assert.match(source, /fetch\(url, \{ cache: 'no-store', mode: 'cors' \}\)/);
    assert.match(source, /selectRegion\(regionSelectEl\.value, true\)/);
});
