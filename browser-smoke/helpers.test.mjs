import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { remoteBaseURL, assertSingleOriginRegions, waitForPreview } from './target.mjs';
import SafeReporter from './safe-reporter.mjs';

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
