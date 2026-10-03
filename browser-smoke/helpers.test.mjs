import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { remoteBaseURL, assertSingleOriginRegions, waitForPreview } from './target.mjs';
import SafeReporter from './safe-reporter.mjs';
import {
    rankedPersonalResults, personalRows, personalHudScores, personalScoreGeometry, personalViewResizeState,
} from './personal-scores.mjs';

test('personal score expectation uses the advertised capacity and highest scorers on overflow', () => {
    const participants = Array.from({ length: 10 }, (_, index) => ({
        id: String(index), number: index + 1, score: index === 9 ? 123456 : 0,
    }));
    assert.deepEqual(rankedPersonalResults(participants, 4), [
        { number: 10, score: 123456 }, { number: 1, score: 0 },
        { number: 2, score: 0 }, { number: 3, score: 0 },
        { number: 4, score: 0 }, { number: 5, score: 0 },
    ]);
    assert.equal(rankedPersonalResults(participants, 3).length, 4);
    assert.equal(rankedPersonalResults(participants, 5).length, 7);
    assert.throws(() => rankedPersonalResults(participants, undefined), /advertised/);
});

test('personal score expectation is independent of peer insertion order', () => {
    const participants = [
        { id: 'b', number: 2, score: 100 }, { id: 'a', number: 1, score: 100 },
        { id: 'c', number: 3, score: 0 },
    ];
    assert.deepEqual(rankedPersonalResults(participants, 4), [
        { number: 1, score: 100 }, { number: 2, score: 100 }, { number: 3, score: 0 },
    ]);
    assert.deepEqual(rankedPersonalResults([...participants].reverse(), 4),
        rankedPersonalResults(participants, 4));
    assert.deepEqual(participants.map(({ id }) => id), ['b', 'a', 'c'], 'The oracle does not mutate inputs');
});

test('personal result reader retains zero scores, stable labels and six-digit values', () => {
    assert.deepEqual(personalRows('Your Score: 123,456\nTeam Score: 246,912\nPlayer 2 (you)\n123,456\nPlayer 1\n123456\nPlayer 3\n0'), [
        { number: 2, score: 123456 }, { number: 1, score: 123456 }, { number: 3, score: 0 },
    ]);
    assert.deepEqual(personalRows('Final Score: 123456'), []);
    assert.deepEqual(personalRows('Player 1 -20'), []);
    assert.deepEqual(personalRows('Player 1: 0\nPlayer 2 (You): 1'), [
        { number: 1, score: 0 }, { number: 2, score: 1 },
    ]);
});

test('personal score reader distinguishes capitalized individual and shared HUD and final labels', () => {
    assert.deepEqual(personalHudScores('Your Score\n123456\nTeam Score\n316,932\nWave: 1\nLives: 5'), {
        your: 123456, team: 316932,
    });
    assert.deepEqual(personalHudScores('Your Score: 0\nTeam Score: 316,932'), { your: 0, team: 316932 });
    assert.deepEqual(personalHudScores('Your Score: 123456 : Player 42\nTeam Score: 316,932 : Session 2026'), {
        your: 123456, team: 316932,
    });
    assert.deepEqual(personalHudScores('Your Score: --\nTeam Score: 316,932'), { your: null, team: 316932 });
    assert.deepEqual(personalHudScores('Score: 123456'), { your: null, team: null });
    assert.deepEqual(personalHudScores('your score 1 team score 2'), { your: null, team: null });
    assert.deepEqual(personalHudScores('Your score 1 Team score 2'), { your: null, team: null });
});

test('score geometry measures the offset creator view, not the fullscreen canvas or browser window', () => {
    const keys = ['document', 'game', 'innerWidth', 'innerHeight'];
    const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    try {
        globalThis.innerWidth = 960;
        globalThis.innerHeight = 800;
        for (const viewport of [
            { x: 358.5, y: 0, width: 243, height: 540 },
            { x: 0, y: 298.75, width: 360, height: 202.5 },
        ]) {
            globalThis.game = { viewport };
            globalThis.document = {
                getElementById: id => id === 'game' ? {
                    width: 960, height: 800,
                    getBoundingClientRect: () => ({
                        left: 12, top: 18, right: 492, bottom: 418, width: 480, height: 400,
                    }),
                } : null,
                documentElement: { scrollWidth: 960 },
            };
            const measured = personalScoreGeometry();
            assert.deepEqual(measured.gameView, {
                left: 12 + viewport.x / 2, top: 18 + viewport.y / 2,
                right: 12 + (viewport.x + viewport.width) / 2,
                bottom: 18 + (viewport.y + viewport.height) / 2,
                width: viewport.width / 2, height: viewport.height / 2,
            });
            assert.notEqual(measured.gameView.width, measured.viewport.width);
            assert.notEqual(measured.gameView.height, measured.viewport.height);
        }
    } finally {
        keys.forEach((key, index) => {
            if (previous[index]) Object.defineProperty(globalThis, key, previous[index]);
            else delete globalThis[key];
        });
    }
});

test('resize readiness requires the canvas backing size and game viewport, not CSS-scaled bounds', () => {
    const keys = ['document', 'game', 'innerWidth', 'innerHeight'];
    const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    try {
        globalThis.innerWidth = 640;
        globalThis.innerHeight = 360;
        const canvas = {
            width: 960, height: 540,
            getBoundingClientRect: () => ({
                left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360,
            }),
        };
        globalThis.document = {
            getElementById: id => id === 'game' ? canvas : null,
            documentElement: { scrollWidth: 640 },
        };
        globalThis.game = { viewport: { x: 358.5, y: 0, width: 243, height: 540 } };
        const expected = {
            canvas: { width: 640, height: 360 },
            gameViewport: { width: 162, height: 360 },
        };
        const scaled = personalScoreGeometry().gameView;
        assert.deepEqual({ width: scaled.width, height: scaled.height }, expected.gameViewport,
            'The previous CSS-based wait passes before the application handles the resize');
        assert.notDeepEqual(personalViewResizeState(), expected,
            'CSS scaling alone cannot release the layout assertions');
        Object.assign(canvas, expected.canvas);
        assert.notDeepEqual(personalViewResizeState(), expected,
            'Updating the canvas alone cannot release checks against a stale game viewport');
        Object.assign(game.viewport, { x: 239, y: 0, ...expected.gameViewport });
        assert.deepEqual(personalViewResizeState(), expected,
            'The wait releases after the synchronous production resize finishes');
    } finally {
        keys.forEach((key, index) => {
            if (previous[index]) Object.defineProperty(globalThis, key, previous[index]);
            else delete globalThis[key];
        });
    }
});

test('only a default single-region ACA origin is accepted remotely', () => {
    assert.equal(remoteBaseURL('https://preview.cluster.azurecontainerapps.io/'),
        'https://preview.cluster.azurecontainerapps.io');
    for (const value of [
        undefined, '', 'not a URL', 'https://example.com',
        'http://preview.azurecontainerapps.io',
        'https://preview.azurecontainerapps.io.example.com',
        'https://user:password@preview.azurecontainerapps.io',
        'https://preview.azurecontainerapps.io:8443',
        'https://preview.azurecontainerapps.io/path',
        'https://preview.azurecontainerapps.io/?secret=value',
        'https://preview.azurecontainerapps.io/#secret',
        'https://apex.azurestaticapps.net',
        'http://127.0.0.1:5189',
    ]) {
        assert.throws(() => remoteBaseURL(value), error =>
            !error.message.includes('password') && !error.message.includes('secret=value')
            && error.message.includes('default *.azurecontainerapps.io'));
    }
});

test('remote command cannot silently fall back to starting a local server', () => {
    const env = { ...process.env };
    delete env.BROWSER_SMOKE_BASE_URL;
    const result = spawnSync(process.execPath, ['browser-smoke/run-remote.mjs'], {
        encoding: 'utf8',
        env,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a root HTTPS URL/);
});

test('remote configuration excludes owned loopback guard regressions and the local app server', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import config from './playwright.config.mjs'; console.log(JSON.stringify({ ignore: config.testIgnore, localServer: !!config.webServer }));",
    ], {
        encoding: 'utf8',
        env: { ...process.env, BROWSER_SMOKE_BASE_URL: 'https://preview.azurecontainerapps.io' },
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ignore: '**/origin-guard.spec.mjs', localServer: false });
});

test('remote manifest refuses private routing and multi-region production without echoing hostnames', () => {
    const baseURL = 'https://preview.azurecontainerapps.io';
    assertSingleOriginRegions({ regions: [] }, baseURL);
    assertSingleOriginRegions({ regions: [{ hostname: `${baseURL}/` }] }, baseURL);
    for (const manifest of [
        {}, { regions: [{ hostname: 'https://private.example.com' }] },
        { regions: [{ hostname: baseURL }, { hostname: baseURL }] },
    ]) {
        assert.throws(() => assertSingleOriginRegions(manifest, baseURL),
            error => !error.message.includes('private.example.com'));
    }
});

async function withServer(handler, action) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await action(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('readiness tolerates only a bounded cold-start then verifies the live manifest', async () => {
    let requests = 0;
    await withServer((request, response) => {
        assert.equal(request.url, '/api/regions');
        if (++requests === 1) {
            response.writeHead(503).end();
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"regions":[]}');
        }
    }, url => waitForPreview(url, { timeout: 2_000, interval: 1 }));
    assert.equal(requests, 2);
});

test('unavailable target fails rather than reporting skipped or successful smoke', async () => {
    await withServer((_, response) => response.writeHead(503).end(), async url => {
        await assert.rejects(waitForPreview(url, { timeout: 60, interval: 5 }),
            /target unavailable.*no gameplay checks ran/);
    });
});

test('readiness never follows a redirect to a private hostname', async () => {
    await withServer((_, response) =>
        response.writeHead(302, { Location: 'https://private.example.com' }).end(),
    async url => {
        await assert.rejects(waitForPreview(url, { timeout: 1_000 }),
            error => /redirected/.test(error.message) && !error.message.includes('private.example.com'));
    });
});

test('remote reporter emits only authored test names and outcomes', () => {
    const output = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = console.error = value => output.push(value);
    try {
        const reporter = new SafeReporter();
        reporter.onError(new Error('https://private.example.com session/payload'));
        reporter.onStepEnd(null, null, {
            category: 'expect', title: 'https://private.example.com session/payload', error: {},
        });
        reporter.onStepEnd(null, null, {
            category: 'test.step', title: 'authored smoke step', error: {},
        });
        reporter.onTestEnd({ title: 'authored smoke scenario' }, {
            status: 'failed',
            errors: [new Error('https://private.example.com session/payload')],
        });
        reporter.onEnd({ status: 'failed' });
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.match(output.join('\n'), /FAILED: authored smoke scenario/);
    assert.match(output.join('\n'), /FAILED STEP: authored smoke step/);
    assert.doesNotMatch(output.join('\n'), /private\.example\.com|session\/payload/);
});

test('workflow gates build locally and previews only through the safe deployment output', async () => {
    const workflow = (await readFile(new URL('../.github/workflows/azure-deploy.yml', import.meta.url), 'utf8'))
        .replace(/\r\n/g, '\n');
    const local = workflow.split('      - name: Real-browser local playability smoke\n')[1]?.split('\n      - name:')[0];
    assert.ok(local);
    assert.match(local, /run: npm run test:browser\n/);
    assert.match(local, /BROWSER_SMOKE_NO_BUILD: '1'/);
    const remote = workflow.split('      - name: Real-browser branch-preview playability smoke\n')[1]?.split('\n      - name:')[0];
    assert.ok(remote);
    assert.match(remote, /if: steps\.vars\.outputs\.is_production != 'true'/);
    assert.match(remote, /run: npm run test:browser:remote/);
    assert.match(remote, /BROWSER_SMOKE_BASE_URL: \$\{\{ steps\.deploy\.outputs\.url \}\}/);
    assert.doesNotMatch(remote, /CUSTOM_|continue-on-error|always\(\)/);
    assert.ok(workflow.indexOf('name: Real-browser branch-preview playability smoke')
        < workflow.indexOf('name: Deployment Summary'));
});
