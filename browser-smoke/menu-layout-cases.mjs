export function menuLayoutCases(env = process.env) {
    const preview = Object.hasOwn(env, 'BROWSER_SMOKE_BASE_URL');
    const landscapeViewports = [
        { width: 1280, height: 900 }, { width: 900, height: 550 },
        { width: 568, height: 320 }, { width: 400, height: 300 },
        { width: 360, height: 300 }, { width: 320, height: 240 },
    ];
    const states = [];
    if (preview) {
        // Cover every region/role/availability interaction and every mode/role pair,
        // plus the long-region-label, full-list Create state with all controls visible.
        states.push(...[
            ['', false, 0, 'outside', false],
            ['fullscreen-active', false, 6, 'outside', true],
            ['standalone-mode', true, 2, 'outside', false],
            ['pseudo-fullscreen', true, 2, 'outside', true],
            ['fullscreen-active', false, 2, 'host', false],
            ['', false, 6, 'host', true],
            ['pseudo-fullscreen', true, 6, 'host', false],
            ['standalone-mode', true, 0, 'host', true],
            ['standalone-mode', false, 6, 'waiting-member', false],
            ['pseudo-fullscreen', false, 0, 'waiting-member', true],
            ['', true, 2, 'waiting-member', false],
            ['fullscreen-active', true, 0, 'waiting-member', true],
            ['pseudo-fullscreen', false, 0, 'running-member', false],
            ['standalone-mode', false, 2, 'running-member', true],
            ['fullscreen-active', true, 6, 'running-member', false],
            ['', true, 2, 'running-member', true],
            ['', true, 6, 'outside', false],
        ].map(([mode, multiRegion, sessionCount, role, unavailable]) =>
            ({ mode, multiRegion, sessionCount, role, unavailable })));
    } else {
        for (const mode of ['', 'fullscreen-active', 'standalone-mode', 'pseudo-fullscreen'])
        for (const multiRegion of [false, true])
        for (const sessionCount of [0, 2, 6])
        for (const role of ['outside', 'host', 'waiting-member', 'running-member'])
        for (const unavailable of [false, true]) {
            states.push({ mode, multiRegion, sessionCount, role, unavailable });
        }
    }
    const resizeViewports = [
        { width: 568, height: 240 }, { width: 568, height: 280 },
        { width: 568, height: 300 }, { width: 568, height: 320 },
        { width: 568, height: 400 }, { width: 568, height: 320 },
        { width: 568, height: 300 }, { width: 568, height: 280 },
        { width: 360, height: 800 }, { width: 568, height: 240 },
    ];
    // Keep the complete first sweep, then short -> tall -> portrait -> short
    // after hiding fullscreen and again after restoring it. Never deduplicate visits.
    const resizeBoundaries = [resizeViewports[0], resizeViewports[4], resizeViewports[8], resizeViewports[9]];
    return {
        landscape: landscapeViewports.map(viewport => ({ viewport, states })),
        resize: [false, true].map(multiRegion => ({
            multiRegion,
            transitions: [false, true, false].map((fullscreenHidden, index) => ({
                fullscreenHidden,
                viewports: preview && index > 0 ? resizeBoundaries : resizeViewports,
            })),
        })),
    };
}
