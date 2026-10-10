import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { remoteBaseURL, assertSingleOriginRegions, waitForPreview } from './target.mjs';
import SafeReporter from './safe-reporter.mjs';
import { allowedGuardOrigins } from './origin-guard.mjs';
import { menuLayoutCases } from './menu-layout-cases.mjs';
import {
    rankedPersonalResults, personalRows, personalHudScores, personalScoreGeometry, personalViewResizeState,
} from './personal-scores.mjs';

const { IDENTITY_TAG_MAX_LENGTH } = createRequire(import.meta.url)('../AstervoidsWeb/wwwroot/js/game-config.js');

test('startup fault fixtures allow only explicit root loopback origins, never a remote bypass', () => {
    const local = 'http://127.0.0.1:5189';
    assert.deepEqual([...allowedGuardOrigins(local, ['http://localhost:5190'])],
        [local, 'http://localhost:5190']);
    const remote = 'https://preview.azurecontainerapps.io';
    assert.deepEqual([...allowedGuardOrigins(remote)], [remote]);
    for (const candidate of [
        'https://example.com', 'http://example.com', 'http://127.0.0.1:5190/path',
        'http://127.0.0.1:5190/?redirect=1', 'http://127.0.0.1:5190/#invite',
        'http://user:password@127.0.0.1:5190', 'invalid',
    ]) {
        assert.throws(() => allowedGuardOrigins(local, [candidate]), /explicitly registered loopback/);
    }
    assert.throws(() => allowedGuardOrigins(remote, [local]), /explicitly registered loopback/);
});

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

test('durable tag rows preserve ranking and do not parse titles as players', () => {
    assert.deepEqual(personalRows('GAME OVER\nTeam Score: 123456\nRank\tPlayer\tScore\n1\tNova-2\t123456\n2\tPilot_1\t0'), [
        { tag: 'Nova-2', score: 123456 }, { tag: 'Pilot_1', score: 0 },
    ]);
    assert.deepEqual(rankedPersonalResults([
        { id: 'a', number: 1, tag: 'Pilot_1', score: 0 },
        { id: 'b', number: 2, tag: 'Nova-2', score: 123456 },
    ], 3), [{ tag: 'Nova-2', score: 123456 }, { tag: 'Pilot_1', score: 0 }]);
});

test('personal result reader retains maximum-length tags and rejects over-limit rows', () => {
    const first = 'A'.repeat(IDENTITY_TAG_MAX_LENGTH);
    const second = 'B'.repeat(IDENTITY_TAG_MAX_LENGTH);
    assert.deepEqual(personalRows(`1\t${first}\t12\n2\t${second}\t0`), [
        { tag: first, score: 12 }, { tag: second, score: 0 },
    ]);
    assert.deepEqual(personalRows(`1\t${first}A\t12`), []);
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
                querySelectorAll: () => [],
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
            querySelectorAll: () => [],
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

test('local menu layout selection preserves every ordered projection and resize revisit', () => {
    const local = menuLayoutCases({});
    const states = [];
    for (const mode of ['', 'fullscreen-active', 'standalone-mode', 'pseudo-fullscreen'])
    for (const multiRegion of [false, true])
    for (const sessionCount of [0, 2, 6])
    for (const role of ['outside', 'host', 'waiting-member', 'running-member'])
    for (const unavailable of [false, true]) {
        states.push({ mode, multiRegion, sessionCount, role, unavailable });
    }
    assert.deepEqual(local.landscape, [
        { width: 1280, height: 900 }, { width: 900, height: 550 },
        { width: 568, height: 320 }, { width: 400, height: 300 },
        { width: 360, height: 300 }, { width: 320, height: 240 },
    ].map(viewport => ({ viewport, states })));
    const viewports = [
        { width: 568, height: 240 }, { width: 568, height: 280 },
        { width: 568, height: 300 }, { width: 568, height: 320 },
        { width: 568, height: 400 }, { width: 568, height: 320 },
        { width: 568, height: 300 }, { width: 568, height: 280 },
        { width: 360, height: 800 }, { width: 568, height: 240 },
    ];
    assert.deepEqual(local.resize, [false, true].map(multiRegion => ({
        multiRegion,
        transitions: [false, true, false].map(fullscreenHidden => ({ fullscreenHidden, viewports })),
    })));
    assert.equal(local.landscape.reduce((count, layout) => count + layout.states.length, 0), 1_152);
    assert.deepEqual(menuLayoutCases({ CI: 'true', BROWSER_SMOKE_NO_BUILD: '1' }), local,
        'Neither CI nor the build shortcut may reduce local coverage');
});

test('preview landscape selection covers boundary viewports and interacting display states', () => {
    const local = menuLayoutCases({});
    const preview = menuLayoutCases({ BROWSER_SMOKE_BASE_URL: 'https://preview.azurecontainerapps.io' });
    assert.deepEqual(preview.landscape.map(layout => layout.viewport), local.landscape.map(layout => layout.viewport));
    const fullStates = new Set(local.landscape[0].states.map(state => JSON.stringify(state)));
    for (const { viewport, states } of preview.landscape) {
        const label = `${viewport.width}x${viewport.height}`;
        assert.equal(states.length, 17, `${label}: an explicitly bounded preview, not the exhaustive matrix`);
        assert.equal(new Set(states.map(state => JSON.stringify(state))).size, states.length,
            `${label}: representatives must not be duplicates`);
        assert.ok(states.every(state => fullStates.has(JSON.stringify(state))), `${label}: only original states are selected`);
        for (const multiRegion of [false, true])
        for (const role of ['outside', 'host', 'waiting-member', 'running-member'])
        for (const unavailable of [false, true]) {
            assert.ok(states.some(state => state.multiRegion === multiRegion
                && state.role === role && state.unavailable === unavailable),
            `${label}: regions=${multiRegion ? 2 : 1} ${role} unavailable=${unavailable}`);
        }
        for (const mode of ['', 'fullscreen-active', 'standalone-mode', 'pseudo-fullscreen']) {
            for (const role of ['outside', 'host', 'waiting-member', 'running-member']) {
                assert.ok(states.some(state => state.mode === mode && state.role === role),
                    `${label}: ${mode || 'windowed'} ${role}`);
            }
            for (const sessionCount of [0, 2, 6]) {
                assert.ok(states.some(state => state.mode === mode && state.sessionCount === sessionCount),
                    `${label}: ${mode || 'windowed'} sessions=${sessionCount}`);
            }
            for (const multiRegion of [false, true])
            for (const unavailable of [false, true]) {
                assert.ok(states.some(state => state.mode === mode
                    && state.multiRegion === multiRegion && state.unavailable === unavailable),
                `${label}: ${mode || 'windowed'} regions=${multiRegion ? 2 : 1} unavailable=${unavailable}`);
            }
        }
        assert.ok(states.some(state => state.mode === '' && state.multiRegion && state.sessionCount === 6
            && state.role === 'outside' && !state.unavailable),
        `${label}: long destination, full list and every control visible together`);
    }
});

test('preview resize selection keeps the full initial sweep and fullscreen boundary returns', () => {
    const local = menuLayoutCases({});
    const preview = menuLayoutCases({ BROWSER_SMOKE_BASE_URL: 'https://preview.azurecontainerapps.io' });
    const boundaries = [
        { width: 568, height: 240 }, { width: 568, height: 400 },
        { width: 360, height: 800 }, { width: 568, height: 240 },
    ];
    assert.deepEqual(preview.resize, [false, true].map(multiRegion => ({
        multiRegion,
        transitions: [
            { fullscreenHidden: false, viewports: local.resize[0].transitions[0].viewports },
            { fullscreenHidden: true, viewports: boundaries },
            { fullscreenHidden: false, viewports: boundaries },
        ],
    })));
    assert.equal(preview.resize.flatMap(layout => layout.transitions)
        .reduce((count, transition) => count + transition.viewports.length, 0), 36);
});

test('menu layout selection defaults to the same remote-mode presence gate as the runner', () => {
    for (const remote of [false, true]) {
        const env = { ...process.env };
        if (remote) env.BROWSER_SMOKE_BASE_URL = 'https://preview.azurecontainerapps.io';
        else delete env.BROWSER_SMOKE_BASE_URL;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e',
            "import { menuLayoutCases } from './browser-smoke/menu-layout-cases.mjs'; console.log(JSON.stringify(menuLayoutCases()));",
        ], { encoding: 'utf8', env, timeout: 10_000 });
        assert.equal(result.status, 0);
        assert.deepEqual(JSON.parse(result.stdout), menuLayoutCases(env));
    }
    assert.deepEqual(menuLayoutCases({ BROWSER_SMOKE_BASE_URL: '' }),
        menuLayoutCases({ BROWSER_SMOKE_BASE_URL: 'https://preview.azurecontainerapps.io' }),
        'An invalid remote value still selects remote mode; target validation, not this selector, rejects it');
    assert.deepEqual(menuLayoutCases(Object.create({ BROWSER_SMOKE_BASE_URL: 'https://preview.azurecontainerapps.io' })),
        menuLayoutCases({}), 'Only an own environment property selects remote mode');
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

test('local and remote configurations use the installed headless shell and keep their server boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'astervoids-smoke-config-'));
    try {
        for (const remote of [false, true]) {
            const env = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
            if (remote) env.BROWSER_SMOKE_BASE_URL = 'https://preview.azurecontainerapps.io';
            else delete env.BROWSER_SMOKE_BASE_URL;
            const result = spawnSync(process.execPath, ['--input-type=module', '-e',
                `import config from './playwright.config.mjs';
                console.log(JSON.stringify({
                    ignore: config.testIgnore, localServer: !!config.webServer,
                    browserName: config.use.browserName, headless: config.use.headless,
                    channel: config.use.channel ?? null, launchOptions: config.use.launchOptions ?? {},
                    projects: config.projects ?? [],
                }));`,
            ], { encoding: 'utf8', env, timeout: 10_000 });
            assert.equal(result.status, 0);
            assert.deepEqual(JSON.parse(result.stdout), {
                ignore: remote ? '**/origin-guard.spec.mjs' : [], localServer: !remote,
                browserName: 'chromium', headless: true, channel: null, launchOptions: {}, projects: [],
            }, 'Neither mode may require full Chromium through a channel, executable or project override');
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('actual Playwright discovery keeps local coverage, bounds preview layouts and skips only the injected identity failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'astervoids-smoke-discovery-'));
    try {
        const inventories = [];
        for (const remote of [false, true]) {
            const env = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
            if (remote) env.BROWSER_SMOKE_BASE_URL = 'https://preview.azurecontainerapps.io';
            else delete env.BROWSER_SMOKE_BASE_URL;
            const result = spawnSync(process.execPath, [
                createRequire(import.meta.url).resolve('@playwright/test/cli'),
                'test', '--list', '--reporter=json',
            ], { encoding: 'utf8', env, timeout: 30_000 });
            assert.equal(result.status, 0, 'Actual smoke discovery succeeds without a server or remote requests');
            const inventory = [];
            const layouts = [];
            function collect(suite) {
                for (const spec of suite.specs ?? []) {
                    for (const scenario of spec.tests) {
                        inventory.push({ file: spec.file, title: spec.title, expectedStatus: scenario.expectedStatus });
                        for (const annotation of scenario.annotations ?? []) {
                            if (annotation.type === 'menu-layout-cases') {
                                layouts.push({ title: spec.title, count: annotation.description });
                            }
                        }
                    }
                }
                for (const child of suite.suites ?? []) collect(child);
            }
            collect(JSON.parse(result.stdout));
            assert.deepEqual(layouts, [
                {
                    title: 'landscape menu stays balanced across deployment, fullscreen and multiplayer visibility states',
                    count: remote ? '102' : '1152',
                },
                {
                    title: 'menu fitting is resize-order independent and only shrinks space the layout can reclaim',
                    count: remote ? '36' : '60',
                },
            ], 'The actual specs select their layout inventory from runner mode, not an always-reduced override');
            inventories.push(inventory);
        }
        const [local, remote] = inventories;
        assert.equal(local.length, 68);
        assert.ok(local.every(scenario => scenario.expectedStatus === 'passed'));
        assert.equal(local.filter(scenario => scenario.file === 'origin-guard.spec.mjs').length, 22);
        const faultTitle = 'identity failure and busy states keep their actions accessible in a reduced-height viewport';
        assert.equal(local.filter(scenario => scenario.title === faultTitle).length, 1);
        assert.equal(remote.length, 46);
        assert.deepEqual(remote, local
            .filter(scenario => scenario.file !== 'origin-guard.spec.mjs')
            .map(scenario => scenario.title === faultTitle
                ? { ...scenario, expectedStatus: 'skipped' } : scenario));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
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

test('remote reporter emits only authored names, outcomes and finite numeric durations', () => {
    const output = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = console.error = (...values) => output.push(values);
    const privateData = 'https://private.example.com identity/session/payload';
    const outcomes = [
        ['passed', 1234], ['failed', 2345.6], ['timedOut', 90_000],
        ['skipped', 0], ['interrupted', 12.4],
    ];
    const invalidDurations = [
        undefined, null, -1, NaN, Infinity, -Infinity, privateData,
        { toString() { throw new Error('A duration must never be coerced from runtime data'); } },
    ];
    try {
        const reporter = new SafeReporter();
        const scenario = {
            title: 'authored smoke scenario',
            location: { file: privateData, line: 1, column: 1 },
            titlePath: () => [privateData, 'authored smoke scenario'],
            annotations: [{ type: 'skip', description: privateData }],
        };
        reporter.onError(new Error(privateData));
        reporter.onStepEnd(null, null, {
            category: 'expect', title: privateData, error: new Error(privateData),
        });
        reporter.onStepEnd(null, null, {
            category: 'test.step', title: 'authored smoke step', error: new Error(privateData),
        });
        for (const [status, duration] of outcomes) {
            const result = {
                status, duration, error: new Error(privateData), errors: [new Error(privateData)],
                attachments: [{ name: privateData, path: privateData, body: Buffer.from(privateData) }],
                stdout: [privateData], stderr: [Buffer.from(privateData)],
            };
            reporter.onStdOut?.(privateData, scenario, result);
            reporter.onStdErr?.(Buffer.from(privateData), scenario, result);
            reporter.onTestEnd(scenario, result);
        }
        for (const duration of invalidDurations) {
            reporter.onTestEnd(scenario, { status: 'failed', duration });
        }
        reporter.onEnd({ status: 'failed' });
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.deepEqual(output, [
        ['Browser smoke setup/runner failed. Target may be unavailable or unsupported; inspect privately.'],
        ['FAILED STEP: authored smoke step'],
        ['PASSED: authored smoke scenario (1234 ms)'],
        ['FAILED: authored smoke scenario (2346 ms)'],
        ['TIMEDOUT: authored smoke scenario (90000 ms)'],
        ['SKIPPED: authored smoke scenario (0 ms)'],
        ['INTERRUPTED: authored smoke scenario (12 ms)'],
        ...invalidDurations.map(() => ['FAILED: authored smoke scenario']),
        ['Browser smoke: failed'],
    ]);
    assert.doesNotMatch(output.flat().join('\n'), /private\.example\.com|identity\/session\/payload/);
});

test('workflow gates build locally and previews only through the safe deployment output', async () => {
    const workflow = (await readFile(new URL('../.github/workflows/azure-deploy.yml', import.meta.url), 'utf8'))
        .replace(/\r\n/g, '\n');
    assert.deepEqual([...workflow.matchAll(/^[ \t]+(?:run: )?(npx playwright install[^\n]*)$/gm)].map(match => match[1]), [
        'npx playwright install --with-deps --only-shell chromium',
        'npx playwright install --with-deps --only-shell chromium',
    ], 'Both CI installs include the headless shell and its Linux system dependencies');
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
