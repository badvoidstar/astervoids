import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { installOriginGuard } from './origin-guard.mjs';
import { waitForPreview } from './target.mjs';

async function withOrigins(browser, action, status = 302) {
    let destinationRequests = 0;
    let sameOriginDestinationRequests = 0;
    const sockets = new Set();
    const destination = createServer((_, response) => {
        destinationRequests++;
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
            .end('redirect escaped');
    });
    const selected = createServer((request, response) => {
        if (request.url === '/api/regions') {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"regions":[]}');
        } else if (request.url === '/redirect') {
            response.writeHead(status, {
                Location: `http://127.0.0.1:${destination.address().port}/destination`,
            }).end();
        } else if (request.url === '/same-origin-redirect') {
            response.writeHead(status, { Location: '/local-destination' }).end();
        } else if (request.url === '/local-destination') {
            sameOriginDestinationRequests++;
            response.end('same-origin redirect escaped');
        } else if (request.url === '/script.js') {
            response.writeHead(200, { 'Content-Type': 'application/javascript' }).end('window.resourceLoaded = true;');
        } else if (request.url === '/worker.js') {
            response.writeHead(200, { 'Content-Type': 'application/javascript' })
                .end("fetch('/redirect').then(() => postMessage('escaped'), () => postMessage('blocked'));");
        } else if (request.url === '/stream') {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('data: live-stream\n\n');
        } else if (request.url === '/echo') {
            let body = '';
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                response.writeHead(201, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': 'guard-fixture=present; Path=/; HttpOnly',
                }).end(JSON.stringify({ method: request.method, body, cookie: request.headers.cookie ?? '' }));
            });
        } else if (request.url === '/disconnect') {
            request.socket.destroy();
        } else {
            response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>guard fixture</title>');
        }
    });
    selected.on('upgrade', (request, socket) => {
        const accept = createHash('sha1').update(request.headers['sec-websocket-key']
            + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.from([0x81, 4, ...Buffer.from('live')]));
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
        for (const server of [destination, selected]) {
            server.on('connection', socket => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        }
        const baseURL = `http://127.0.0.1:${selected.address().port}`;
        const health = { offOrigin: 0, redirects: 0, requestFailures: 0 };
        await waitForPreview(baseURL, { timeout: 2_000 });
        const page = await context.newPage();
        await installOriginGuard(page, baseURL, health);
        page.setDefaultNavigationTimeout(5_000);
        await action({
            page, baseURL, health,
            destinationURL: `http://127.0.0.1:${destination.address().port}`,
            destinationRequests: () => destinationRequests,
            sameOriginDestinationRequests: () => sameOriginDestinationRequests,
        });
    } finally {
        try {
            await context.close();
        } finally {
            for (const socket of sockets) socket.destroy();
            for (const server of [selected, destination]) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
        }
    }
}

for (const status of [301, 302, 303, 307, 308]) {
    test(`origin guard blocks navigation redirect ${status} before contacting another origin`, async ({ browser }) => {
        await withOrigins(browser, async ({ page, baseURL, health, destinationRequests }) => {
            const rejected = await page.goto(`${baseURL}/redirect`).then(() => false, () => true);
            expect({
                destinationRequests: destinationRequests(),
                offOrigin: health.offOrigin,
                browserLeftSelectedOrigin: page.url().startsWith('http:') && new URL(page.url()).origin !== baseURL,
            }).toEqual({ destinationRequests: 0, offOrigin: 1, browserLeftSelectedOrigin: false });
            expect(rejected, 'Redirected navigation rejects instead of succeeding').toBe(true);
            expect(health.redirects).toBe(1);
            expect(health.requestFailures).toBe(0);
        }, status);
    });

    test(`origin guard blocks fetch redirect ${status} before contacting another origin`, async ({ browser }) => {
        await withOrigins(browser, async ({ page, baseURL, health, destinationRequests }) => {
            await page.goto(baseURL);
            const rejected = await page.evaluate(() => fetch('/redirect').then(() => false, () => true));
            expect({ destinationRequests: destinationRequests(), offOrigin: health.offOrigin })
                .toEqual({ destinationRequests: 0, offOrigin: 1 });
            expect(rejected, 'Redirected fetch rejects instead of succeeding').toBe(true);
            expect(health.redirects).toBe(1);
            expect(health.requestFailures).toBe(0);
        }, status);
    });
}

test('origin guard blocks redirected script resources before contacting another origin', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health, destinationRequests }) => {
        await page.goto(baseURL);
        const rejected = await page.evaluate(() => new Promise(resolve => {
            const script = document.createElement('script');
            script.onload = () => resolve(false);
            script.onerror = () => resolve(true);
            script.src = '/redirect';
            document.head.append(script);
        }));
        expect(destinationRequests()).toBe(0);
        expect(rejected).toBe(true);
        expect(health).toEqual({ offOrigin: 1, redirects: 1, requestFailures: 0 });
    });
});

test('origin guard retains direct off-origin rejection', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, destinationURL, health, destinationRequests }) => {
        await page.goto(baseURL);
        const rejected = await page.evaluate(url => fetch(url).then(() => false, () => true), destinationURL);
        expect(destinationRequests()).toBe(0);
        expect(rejected).toBe(true);
        expect(health).toEqual({ offOrigin: 1, redirects: 0, requestFailures: 0 });
    });
});

test('origin guard refuses same-origin redirects under the no-redirect policy', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health, sameOriginDestinationRequests }) => {
        await page.goto(baseURL);
        const rejected = await page.evaluate(() => fetch('/same-origin-redirect').then(() => false, () => true));
        expect(sameOriginDestinationRequests()).toBe(0);
        expect(rejected).toBe(true);
        expect(health).toEqual({ offOrigin: 0, redirects: 1, requestFailures: 0 });
    });
});

test('origin guard preserves live same-origin resources, methods, bodies, statuses and cookies', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health }) => {
        await page.goto(baseURL);
        await page.addScriptTag({ url: '/script.js' });
        expect(await page.evaluate(() => window.resourceLoaded)).toBe(true);
        const result = await page.evaluate(async () => {
            const response = await fetch('/echo', { method: 'POST', body: 'live-request' });
            const next = await fetch('/echo');
            return { status: response.status, first: await response.json(), next: await next.json() };
        });
        expect(result).toEqual({
            status: 201,
            first: { method: 'POST', body: 'live-request', cookie: '' },
            next: { method: 'GET', body: '', cookie: 'guard-fixture=present' },
        });
        expect(health).toEqual({ offOrigin: 0, redirects: 0, requestFailures: 0 });
    });
});

test('origin guard aborts a failed live request without an unhandled route rejection', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health }) => {
        await page.goto(baseURL);
        const rejected = await page.evaluate(() => fetch('/disconnect').then(() => false, () => true));
        expect(rejected).toBe(true);
        expect(health).toEqual({ offOrigin: 0, redirects: 0, requestFailures: 1 });
    });
});

test('origin guard preserves a direct live WebSocket handshake and received frame', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health }) => {
        await page.goto(baseURL);
        const result = await page.evaluate(() => new Promise(resolve => {
            const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/websocket');
            const timer = setTimeout(() => { socket.close(); resolve('timed out'); }, 5_000);
            socket.onmessage = event => {
                clearTimeout(timer);
                socket.close();
                resolve(event.data);
            };
            socket.onerror = () => { clearTimeout(timer); resolve('failed'); };
        }));
        expect(result).toBe('live');
        expect(health).toEqual({ offOrigin: 0, redirects: 0, requestFailures: 0 });
    });
});

test('origin guard preserves a live streaming HTTP response without waiting for completion', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health }) => {
        await page.goto(baseURL);
        const result = await page.evaluate(() => new Promise(resolve => {
            const source = new EventSource('/stream');
            const finish = result => { clearTimeout(timer); source.close(); resolve(result); };
            const timer = setTimeout(() => finish('timed out'), 5_000);
            source.onmessage = event => finish(event.data);
            source.onerror = () => finish('failed');
        }));
        expect(result).toBe('live-stream');
        expect(health).toEqual({ offOrigin: 0, redirects: 0, requestFailures: 0 });
    });
});

test('origin guard rejects another page that lacks response interception', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, health, destinationRequests }) => {
        const other = await page.context().newPage();
        const rejected = await other.goto(`${baseURL}/redirect`).then(() => false, () => true);
        expect(destinationRequests()).toBe(0);
        expect(rejected).toBe(true);
        expect(health).toEqual({ offOrigin: 0, redirects: 0, requestFailures: 1 });
    });
});

test('origin guard prevents worker requests from bypassing redirect interception', async ({ browser }) => {
    await withOrigins(browser, async ({ page, baseURL, destinationRequests }) => {
        await page.goto(baseURL);
        const result = await page.evaluate(() => new Promise(resolve => {
            const worker = new Worker('/worker.js');
            const finish = result => { clearTimeout(timer); worker.terminate(); resolve(result); };
            const timer = setTimeout(() => finish('timed out'), 5_000);
            worker.onmessage = event => finish(event.data);
            worker.onerror = () => finish('blocked');
        }));
        expect(destinationRequests()).toBe(0);
        expect(result).toBe('blocked');
    });
});
