import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { remoteBaseURL } from './target.mjs';

const require = createRequire(import.meta.url);
try {
    remoteBaseURL(process.env.BROWSER_SMOKE_BASE_URL);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test'], {
    stdio: 'inherit',
    env: process.env,
});
child.on('error', () => {
    console.error('Unable to start browser smoke runner.');
    process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
