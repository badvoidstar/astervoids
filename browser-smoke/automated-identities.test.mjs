import test from 'node:test';
import assert from 'node:assert/strict';
import {
    automatedIdentityHeaders, AUTOMATED_IDENTITY_HEADER, configureAutomatedIdentities,
} from './automated-identities.mjs';
import { provisionPlayer } from './identity-helpers.mjs';

function context() {
    const requests = [];
    return { requests, async setExtraHTTPHeaders(headers) { requests.push(headers); } };
}

test('browser UI and API provisioning exclude identities by default without intercepting transport', async () => {
    const browser = context();
    const headers = await automatedIdentityHeaders(browser);
    assert.deepEqual(headers, { [AUTOMATED_IDENTITY_HEADER]: 'true' });
    assert.equal(Object.isFrozen(headers), true);
    assert.deepEqual(browser.requests, [headers]);
    assert.equal(await configureAutomatedIdentities(browser), headers);
    assert.equal(await automatedIdentityHeaders(browser), headers);
    assert.equal(browser.requests.length, 1);
});

test('API provisioning requires persisted exclusion before it can enable a named gameplay fixture', async () => {
    for (const excluded of [undefined, false, true]) {
        const browser = context();
        const requests = [];
        let installed = false;
        browser.addInitScript = async () => { installed = true; };
        browser.request = {
            async post(path, options) {
                requests.push({ path, marker: options.headers[AUTOMATED_IDENTITY_HEADER] });
                assert.equal(options.maxRedirects, 0);
                const creating = path === '/api/identity/root';
                return {
                    status: () => creating ? 201 : 200,
                    json: async () => ({ binding: creating
                        ? { identity: { ...(excluded === undefined ? {} : { excludeFromLeaderboards: excluded }) } }
                        : { etag: 'unbound' } }),
                };
            },
        };
        if (excluded) await provisionPlayer(browser, 'Pilot');
        else await assert.rejects(provisionPlayer(browser, 'Pilot'), /persists the fixture leaderboard policy/);
        assert.equal(installed, excluded === true);
        assert.deepEqual(requests, [
            { path: '/api/identity/resolve', marker: 'true' },
            { path: '/api/identity/root', marker: 'true' },
        ]);
    }
});

test('only the isolated local fixture may explicitly retain real leaderboard persistence', async () => {
    const present = Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL');
    const previous = process.env.BROWSER_SMOKE_BASE_URL;
    delete process.env.BROWSER_SMOKE_BASE_URL;
    try {
        const browser = context();
        const headers = await configureAutomatedIdentities(browser, { isolatedLocalScores: true });
        assert.deepEqual(headers, {});
        assert.equal(await automatedIdentityHeaders(browser), headers);
        assert.deepEqual(browser.requests, [{}]);
        await assert.rejects(configureAutomatedIdentities(browser), /Configure identity automation once/);
    } finally {
        if (present) process.env.BROWSER_SMOKE_BASE_URL = previous;
    }
});

test('any configured remote target forbids the local-score opt-out, including an empty target', async () => {
    const present = Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL');
    const previous = process.env.BROWSER_SMOKE_BASE_URL;
    try {
        for (const target of ['', 'https://preview.example.com']) {
            process.env.BROWSER_SMOKE_BASE_URL = target;
            const browser = context();
            await assert.rejects(configureAutomatedIdentities(browser, { isolatedLocalScores: true }),
                /requires the isolated local browser fixture/);
            assert.deepEqual(browser.requests, []);
            assert.deepEqual(await configureAutomatedIdentities(browser),
                { [AUTOMATED_IDENTITY_HEADER]: 'true' });
        }
    } finally {
        if (present) process.env.BROWSER_SMOKE_BASE_URL = previous;
        else delete process.env.BROWSER_SMOKE_BASE_URL;
    }
});

test('automation cannot change a context policy or bypass it with a truthy non-boolean', async () => {
    const browser = context();
    await configureAutomatedIdentities(browser);
    await assert.rejects(configureAutomatedIdentities(browser, { isolatedLocalScores: 'true' }),
        /requires the isolated local browser fixture/);
    const present = Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL');
    const previous = process.env.BROWSER_SMOKE_BASE_URL;
    delete process.env.BROWSER_SMOKE_BASE_URL;
    try {
        await assert.rejects(configureAutomatedIdentities(browser, { isolatedLocalScores: true }),
            /Configure identity automation once/);
    } finally {
        if (present) process.env.BROWSER_SMOKE_BASE_URL = previous;
    }
    assert.deepEqual(browser.requests, [{ [AUTOMATED_IDENTITY_HEADER]: 'true' }]);
});
