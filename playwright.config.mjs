import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { remoteBaseURL } from './browser-smoke/target.mjs';

const remote = Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL');
const baseURL = remote
    ? remoteBaseURL(process.env.BROWSER_SMOKE_BASE_URL)
    : 'http://127.0.0.1:5189';

export default defineConfig({
    testDir: './browser-smoke',
    testMatch: '**/*.spec.mjs',
    testIgnore: remote ? '**/origin-guard.spec.mjs' : [],
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    globalSetup: './browser-smoke/readiness.mjs',
    reporter: remote ? './browser-smoke/safe-reporter.mjs' : 'list',
    outputDir: 'test-results/browser-smoke',
    preserveOutput: 'never',
    use: {
        baseURL,
        browserName: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 900 },
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
        trace: 'off',
        screenshot: 'off',
        video: 'off',
        serviceWorkers: 'block',
    },
    webServer: remote ? undefined : {
        command: `dotnet run --project "${join('AstervoidsWeb', 'AstervoidsWeb.csproj')}" --configuration Release --no-launch-profile${process.env.BROWSER_SMOKE_NO_BUILD === '1' ? ' --no-build' : ''} --urls ${baseURL}`,
        url: `${baseURL}/api/ping`,
        timeout: 120_000,
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
            ASPNETCORE_ENVIRONMENT: 'Production',
            ASPNETCORE_HTTP_PORTS: '',
            ASPNETCORE_HTTPS_PORTS: '',
        },
    },
});
