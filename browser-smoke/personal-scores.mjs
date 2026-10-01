const rowPattern = /\bPlayer ([1-9]\d*)(?:\s+\([Yy]ou\))?(?:\s*[:|\u2014]\s*|\s+)(\d{1,3}(?:,\d{3})+|\d+)(?![\d,])\b/g;

export function rankedPersonalResults(participants, maxMembers) {
    if (!Number.isInteger(maxMembers) || maxMembers <= 0) {
        throw new RangeError('Score expectations require the advertised session capacity');
    }
    return [...participants]
        .sort((left, right) => right.score - left.score || left.number - right.number
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .slice(0, Math.floor(maxMembers * 1.5))
        .map(({ number, score }) => ({ number, score }));
}

export function personalRows(text) {
    return [...text.matchAll(rowPattern)]
        .map(match => ({
            number: Number(match[1]),
            score: Number(match[2].replaceAll(',', '')),
        }));
}

export function personalHudScores(text) {
    const your = text.match(/\byour score\s*:?\s*(\d[\d,]*)\b/);
    const team = text.match(/\bteam score\s*:?\s*(\d[\d,]*)\b/);
    return {
        your: your ? Number(your[1].replaceAll(',', '')) : null,
        team: team ? Number(team[1].replaceAll(',', '')) : null,
    };
}

// Self-contained because Playwright serializes this function into the page.
export function personalScoreGeometry() {
    const rectangle = rect => ({
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height,
    });
    const elementBox = id => {
        const element = document.getElementById(id);
        return element ? rectangle(element.getBoundingClientRect()) : null;
    };
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
    const your = counter('your score');
    const team = counter('team score');
    const score = your && team ? {
        left: Math.min(your.left, team.left), right: Math.max(your.right, team.right),
        top: Math.min(your.top, team.top), bottom: Math.max(your.bottom, team.bottom),
    } : null;
    const session = document.getElementById('session-indicator');
    const sessionStyle = session ? getComputedStyle(session) : null;
    const terminalText = visibleText('gameover-overlay');
    const rows = [...terminalText.text.matchAll(
        /\bPlayer ([1-9]\d*)(?:\s+\([Yy]ou\))?(?:\s*[:|\u2014]\s*|\s+)(\d{1,3}(?:,\d{3})+|\d+)(?![\d,])\b/g,
    )].map(match => ({
        number: Number(match[1]),
        score: Number(match[2].replaceAll(',', '')),
        box: textBox(terminalText, match.index, match[0].length),
        label: textBox(terminalText, match.index, `Player ${match[1]}`.length),
        value: textBox(terminalText, match.index + match[0].lastIndexOf(match[2]), match[2].length),
    }));
    const restart = document.getElementById('touch-restart');
    const restartBox = restart?.getBoundingClientRect();
    const restartTarget = restartBox?.width && restartBox.height
        ? document.elementFromPoint(
            restartBox.left + restartBox.width / 2,
            restartBox.top + restartBox.height / 2)
        : null;
    return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        your, team, score,
        hud: elementBox('hud'),
        session: elementBox('session-indicator'),
        wave: elementBox('wave'),
        lives: elementBox('lives'),
        sessionClips: session ? session.scrollWidth > session.clientWidth + 1 : false,
        sessionOverflow: sessionStyle?.overflowX,
        sessionEllipsis: sessionStyle?.textOverflow,
        rows,
        restart: restartBox ? rectangle(restartBox) : null,
        restartReachable: !!restartTarget?.closest('#touch-restart'),
    };
}
