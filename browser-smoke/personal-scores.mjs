import { createRequire } from 'node:module';

const { IDENTITY_TAG_PATTERN_SOURCE } = createRequire(import.meta.url)('../AstervoidsWeb/wwwroot/js/game-config.js');
const taggedRowPattern = new RegExp(
    String.raw`^[ \t]*\d+[ \t]+(${IDENTITY_TAG_PATTERN_SOURCE})[ \t]+(\d[\d,]*)[ \t]*$`, 'gm');
const rowPattern = /\bPlayer ([1-9]\d*)(?:\s+\([Yy]ou\))?(?:\s*[:|\u2014]\s*|\s+)(\d{1,3}(?:,\d{3})+|\d+)(?![\d,])\b/g;

export function rankedPersonalResults(participants, maxMembers) {
    if (!Number.isInteger(maxMembers) || maxMembers <= 0) {
        throw new RangeError('Score expectations require the advertised session capacity');
    }
    return [...participants]
        .sort((left, right) => right.score - left.score || left.number - right.number
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .slice(0, Math.floor(maxMembers * 1.5))
        .map(({ number, score, tag }) => tag ? ({ tag, score }) : ({ number, score }));
}

export function personalRows(text) {
    const tagged = [...text.matchAll(taggedRowPattern)]
        .map(match => ({ tag: match[1], score: Number(match[2].replaceAll(',', '')) }));
    if (tagged.length) return tagged;
    return [...text.matchAll(rowPattern)]
        .map(match => ({
            number: Number(match[1]),
            score: Number(match[2].replaceAll(',', '')),
        }));
}

export function personalHudScores(text) {
    const your = text.match(/\bYour Score\s*:?\s*(\d[\d,]*)\b/);
    const team = text.match(/\bTeam Score\s*:?\s*(\d[\d,]*)\b/);
    return {
        your: your ? Number(your[1].replaceAll(',', '')) : null,
        team: team ? Number(team[1].replaceAll(',', '')) : null,
    };
}

// Self-contained because Playwright serializes these functions into the page.
export function personalViewResizeState() {
    const canvas = document.getElementById('game');
    return {
        canvas: { width: canvas.width, height: canvas.height },
        gameViewport: { width: game.viewport.width, height: game.viewport.height },
    };
}

export function personalScoreGeometry() {
    const rectangle = rect => ({
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height,
    });
    const elementBox = id => {
        const element = document.getElementById(id);
        return element ? {
            ...rectangle(element.getBoundingClientRect()),
            fontSize: parseFloat(getComputedStyle(element).fontSize),
        } : null;
    };
    const canvas = document.getElementById('game');
    const canvasBox = canvas?.getBoundingClientRect();
    const vp = typeof game === 'undefined' ? null : game.viewport;
    const gameView = vp && canvasBox && canvas.width && canvas.height ? {
        left: canvasBox.left + vp.x * canvasBox.width / canvas.width,
        top: canvasBox.top + vp.y * canvasBox.height / canvas.height,
        width: vp.width * canvasBox.width / canvas.width,
        height: vp.height * canvasBox.height / canvas.height,
    } : null;
    if (gameView) {
        gameView.right = gameView.left + gameView.width;
        gameView.bottom = gameView.top + gameView.height;
    }
    function visibleText(id) {
        const root = document.getElementById(id);
        const nodes = [];
        let text = '';
        if (!root) return { nodes, text };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            let visible = true;
            for (let element = node.parentElement; element; element = element.parentElement) {
                const style = getComputedStyle(element);
                if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) {
                    visible = false;
                    break;
                }
            }
            if (!visible) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) continue;
            nodes.push({ node, start: text.length, end: text.length + node.data.length });
            text += `${node.data} `;
        }
        return { nodes, text };
    }
    function textBox(flat, start, length) {
        const first = flat.nodes.find(entry => entry.start <= start && start < entry.end);
        const end = start + length;
        const last = flat.nodes.find(entry => entry.start < end && end <= entry.end);
        if (!first || !last) return null;
        const range = document.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, end - last.start);
        return {
            ...rectangle(range.getBoundingClientRect()),
            fontSize: Math.min(
                parseFloat(getComputedStyle(first.node.parentElement).fontSize),
                parseFloat(getComputedStyle(last.node.parentElement).fontSize)),
        };
    }
    const hudText = visibleText('hud');
    const counter = label => {
        const match = hudText.text.match(new RegExp(`\\b${label}\\s*:?\\s*(\\d[\\d,]*)\\b`));
        return match ? textBox(hudText, match.index, match[0].length) : null;
    };
    const your = counter('Your Score');
    const team = counter('Team Score');
    const score = your && team ? {
        left: Math.min(your.left, team.left), right: Math.max(your.right, team.right),
        top: Math.min(your.top, team.top), bottom: Math.max(your.bottom, team.bottom),
    } : null;
    const session = document.getElementById('session-indicator');
    const sessionStyle = session ? getComputedStyle(session) : null;
    const playerText = visibleText('player-indicator');
    const glyphs = element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return { ...rectangle(range.getBoundingClientRect()), fontSize: parseFloat(getComputedStyle(element).fontSize) };
    };
    const rows = [...document.querySelectorAll('#gameover-results tbody tr')].map(row => {
        const cells = row.querySelectorAll('td');
        return {
            tag: cells[1].textContent,
            score: Number(cells[2].textContent.replaceAll(',', '')),
            box: glyphs(row), label: glyphs(cells[1]), value: glyphs(cells[2]),
        };
    });
    const restart = document.getElementById('touch-restart');
    const restartBox = restart?.getBoundingClientRect();
    const restartTarget = restartBox?.width && restartBox.height
        ? document.elementFromPoint(
            restartBox.left + restartBox.width / 2,
            restartBox.top + restartBox.height / 2)
        : null;
    const results = document.getElementById('gameover-results');
    const resultsBox = results?.getBoundingClientRect();
    const resultsStyle = results ? getComputedStyle(results) : null;
    const prompt = document.getElementById('gameover-prompt');
    return {
        viewport: { width: innerWidth, height: innerHeight },
        gameView,
        documentWidth: document.documentElement.scrollWidth,
        your, team, score,
        scoreColumn: elementBox('multiplayer-scores'),
        player: elementBox('player-indicator'),
        playerText: textBox(playerText, 0, playerText.text.trimEnd().length),
        hud: elementBox('hud'),
        compactHud: document.getElementById('hud')?.classList.contains('compact') ?? false,
        session: elementBox('session-indicator'),
        wave: elementBox('wave'),
        lives: elementBox('lives'),
        sessionClips: session ? session.scrollWidth > session.clientWidth + 1 : false,
        sessionOverflow: sessionStyle?.overflowX,
        sessionEllipsis: sessionStyle?.textOverflow,
        rows,
        overlay: elementBox('gameover-overlay'),
        title: elementBox('gameover-title'),
        personalTotal: elementBox('gameover-personal-score'),
        total: elementBox('gameover-score'),
        prompt: prompt && getComputedStyle(prompt).display !== 'none'
            ? elementBox('gameover-prompt') : null,
        results: results ? {
            ...elementBox('gameover-results'),
            clientWidth: results.clientWidth, scrollWidth: results.scrollWidth,
            clientHeight: results.clientHeight, scrollHeight: results.scrollHeight,
            scrollTop: results.scrollTop,
            overflowY: resultsStyle.overflowY,
            clip: {
                left: resultsBox.left + results.clientLeft,
                top: resultsBox.top + results.clientTop,
                right: resultsBox.left + results.clientLeft + results.clientWidth,
                bottom: resultsBox.top + results.clientTop + results.clientHeight,
            },
        } : null,
        headers: results ? [...results.querySelectorAll('caption, th')].map(element => ({
            ...rectangle(element.getBoundingClientRect()),
            fontSize: parseFloat(getComputedStyle(element).fontSize),
        })) : [],
        restart: restartBox ? rectangle(restartBox) : null,
        restartReachable: !!restartTarget?.closest('#touch-restart'),
    };
}
