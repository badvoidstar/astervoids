import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInlineGameFunctions } from './test-support/inline-game.mjs';

// drawBulletsBatched must be a pure rendering optimization: the emitted path
// commands have to match what looping Bullet.draw(ctx) produces, while
// collapsing the per-bullet beginPath/stroke pairs down to one per color.

const CONFIG = {
    BULLET_RADIUS: 0.0033,
    STROKE_COLOR: '#fff',
};

const SHIP_COLORS = ['#f00', '#0f0', '#00f', '#ff0'];

function harness({ width = 1000, height = 1000 } = {}) {
    const production = loadInlineGameFunctions([
        'fromNormalizedX', 'fromNormalizedY', 'fromNormalizedSize',
        'getReferenceDimension', 'drawBulletsBatched',
    ], {
        CONFIG,
        SHIP_COLORS,
        getGameWidth: () => width,
        getGameHeight: () => height,
    });
    return production;
}

// Records the exact command stream so batched and per-bullet rendering can be
// compared instruction by instruction.
function recordingCtx() {
    const ops = [];
    return {
        ops,
        strokeStyle: null,
        lineWidth: null,
        beginPath() { ops.push(['beginPath']); },
        closePath() { ops.push(['closePath']); },
        stroke() { ops.push(['stroke', this.strokeStyle, this.lineWidth]); },
        moveTo(x, y) { ops.push(['moveTo', x, y]); },
        lineTo(x, y) { ops.push(['lineTo', x, y]); },
        arc(x, y, r, a0, a1) { ops.push(['arc', x, y, r, a0, a1]); },
    };
}

function bullet(x, y, colorIndex, pendingHit = false) {
    return { x, y, colorIndex, pendingHit };
}

// Mirrors Bullet.draw so the batched output can be checked against the
// unbatched reference. Kept in sync with index.html's Bullet.draw.
function drawOne(h, ctx, b) {
    if (b.pendingHit) return;
    const pixelX = h.fromNormalizedX(b.x);
    const pixelY = h.fromNormalizedY(b.y);
    const pixelRadius = h.fromNormalizedSize(CONFIG.BULLET_RADIUS);
    ctx.strokeStyle = SHIP_COLORS[b.colorIndex] || CONFIG.STROKE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pixelX, pixelY, pixelRadius, 0, Math.PI * 2);
    ctx.stroke();
}

// The circles drawn, independent of batching, as {x,y,r,color} tuples.
function circlesFrom(ops) {
    const circles = [];
    let color = null;
    for (const op of ops) {
        if (op[0] === 'stroke') color = op[1];
    }
    // Re-walk assigning each arc the color of the stroke that flushes it.
    let pending = [];
    color = null;
    const out = [];
    for (const op of ops) {
        if (op[0] === 'arc') pending.push({ x: op[1], y: op[2], r: op[3] });
        else if (op[0] === 'stroke') {
            for (const c of pending) out.push({ ...c, color: op[1] });
            pending = [];
        }
    }
    assert.equal(pending.length, 0, 'every arc must be flushed by a stroke');
    return out;
}

test('batched bullets draw the same circles as per-bullet draw', () => {
    const h = harness();
    const bullets = [
        bullet(0.1, 0.2, 0),
        bullet(0.3, 0.4, 1),
        bullet(0.5, 0.6, 0),
        bullet(0.7, 0.8, 2),
    ];

    const batched = recordingCtx();
    h.drawBulletsBatched(batched, bullets);

    const reference = recordingCtx();
    for (const b of bullets) drawOne(h, reference, b);

    // Same circles, same colors — order within a color is preserved.
    const got = circlesFrom(batched.ops);
    const want = circlesFrom(reference.ops);
    assert.equal(got.length, want.length);
    for (const c of want) {
        assert.ok(
            got.some(g => g.x === c.x && g.y === c.y && g.r === c.r && g.color === c.color),
            `missing circle ${JSON.stringify(c)}`);
    }
});

test('batched bullets emit one stroke per distinct color, not one per bullet', () => {
    const h = harness();
    // 3 colors across 9 bullets.
    const bullets = [];
    for (let i = 0; i < 9; i++) bullets.push(bullet(0.1 * i, 0.2, i % 3));

    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, bullets);

    const strokes = ctx.ops.filter(o => o[0] === 'stroke');
    const begins = ctx.ops.filter(o => o[0] === 'beginPath');
    const arcs = ctx.ops.filter(o => o[0] === 'arc');
    assert.equal(arcs.length, 9, 'every bullet is still drawn');
    assert.equal(strokes.length, 3, 'one stroke per color');
    assert.equal(begins.length, 3, 'one path per color');
    assert.deepEqual(strokes.map(s => s[1]), ['#f00', '#0f0', '#00f']);
    for (const s of strokes) assert.equal(s[2], 2, 'lineWidth preserved');
});

test('each arc is preceded by a moveTo to its own start point', () => {
    // Without this, consecutive arcs in one path are joined by a stray chord.
    const h = harness();
    const bullets = [bullet(0.1, 0.2, 0), bullet(0.6, 0.7, 0)];

    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, bullets);

    const drawing = ctx.ops.filter(o => o[0] === 'moveTo' || o[0] === 'arc');
    assert.equal(drawing.length, 4);
    for (let i = 0; i < drawing.length; i += 2) {
        const move = drawing[i];
        const arc = drawing[i + 1];
        assert.equal(move[0], 'moveTo');
        assert.equal(arc[0], 'arc');
        // arc starts at angle 0 → (cx + r, cy)
        assert.equal(move[1], arc[1] + arc[3]);
        assert.equal(move[2], arc[2]);
    }
    assert.equal(ctx.ops.filter(o => o[0] === 'lineTo').length, 0);
});

test('pendingHit bullets are hidden and do not open an empty path', () => {
    const h = harness();
    const bullets = [
        bullet(0.1, 0.2, 0, true),
        bullet(0.3, 0.4, 1),
        bullet(0.5, 0.6, 0, true),
    ];

    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, bullets);

    assert.equal(ctx.ops.filter(o => o[0] === 'arc').length, 1);
    const strokes = ctx.ops.filter(o => o[0] === 'stroke');
    assert.equal(strokes.length, 1, 'only the visible color is stroked');
    assert.equal(strokes[0][1], '#0f0');
});

test('all bullets pendingHit draws nothing', () => {
    const h = harness();
    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, [bullet(0.1, 0.2, 0, true), bullet(0.3, 0.4, 1, true)]);
    assert.deepEqual(ctx.ops, []);
});

test('empty and missing bullet lists are no-ops', () => {
    const h = harness();
    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, []);
    h.drawBulletsBatched(ctx, null);
    h.drawBulletsBatched(ctx, undefined);
    assert.deepEqual(ctx.ops, []);
});

test('unknown colorIndex falls back to the default stroke color', () => {
    const h = harness();
    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, [bullet(0.1, 0.2, 99), bullet(0.3, 0.4, undefined)]);

    const strokes = ctx.ops.filter(o => o[0] === 'stroke');
    // Both fall back to the same color, so they merge into one path.
    assert.equal(strokes.length, 1);
    assert.equal(strokes[0][1], CONFIG.STROKE_COLOR);
    assert.equal(ctx.ops.filter(o => o[0] === 'arc').length, 2);
});

test('radius matches fromNormalizedSize and is identical for every bullet', () => {
    const h = harness({ width: 1280, height: 720 });
    const ctx = recordingCtx();
    h.drawBulletsBatched(ctx, [bullet(0.1, 0.2, 0), bullet(0.3, 0.4, 1)]);

    const expected = h.fromNormalizedSize(CONFIG.BULLET_RADIUS);
    const arcs = ctx.ops.filter(o => o[0] === 'arc');
    assert.equal(arcs.length, 2);
    for (const a of arcs) assert.equal(a[3], expected);
});
