import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
// Both parsers already ship with the pinned browser test tooling.
const { yaml, yazl } = require('playwright-core/lib/utilsBundle');
const helperPath = fileURLToPath(new URL('./validation-reuse.mjs', import.meta.url));
const workflowPath = fileURLToPath(new URL('../workflows/azure-deploy.yml', import.meta.url));
const helperSource = readFileSync(helperPath, 'utf8');
const workflowSource = readFileSync(process.env.REUSE_MUTANT_WORKFLOW || workflowPath, 'utf8').replace(/\r\n/g, '\n');
const reuse = await import(pathToFileURL(process.env.REUSE_MUTANT_HELPER || helperPath).href);
const {
    POLICY, WORKFLOW, VALIDATION_STEPS, Git, CheckoutError, artifactName, plan,
    selectCheckout, capture, makeProof, verify, validationEnvironment, effectiveInputs, readProofArchive,
    githubApi,
} = reuse;
const NOW = Date.parse('2026-10-10T18:00:00Z');
const iso = offset => new Date(NOW + offset).toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const root = resolve(`.validation-reuse-fixtures-${process.pid}-${randomUUID()}`);
const repository = 'fixture-owner/astervoids';
const repositoryId = 123;
const workflowId = 456;
const sourceId = 789;
const currentId = 790;
const apiPrefix = `repos/${repository}/actions/`;
let commits;
let eventGit;
let headGit;

function gitAt(cwd, ...args) {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'Validation fixture', GIT_COMMITTER_NAME: 'Validation fixture',
            GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    }).trim();
}
function commit(cwd, message) {
    gitAt(cwd, 'add', '.');
    gitAt(cwd, 'commit', '--quiet', '-m', message);
    return gitAt(cwd, 'rev-parse', 'HEAD');
}
function mergeCommit(cwd, head, base) {
    return gitAt(cwd, 'commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'Synthetic equal-tree merge');
}
before(() => {
    mkdirSync(root);
    const origin = join(root, 'origin');
    mkdirSync(join(origin, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(origin, '.github', 'scripts'), { recursive: true });
    gitAt(origin, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(origin, '.github', 'workflows', 'azure-deploy.yml'), workflowSource);
    writeFileSync(join(origin, '.github', 'scripts', 'validation-reuse.mjs'), helperSource);
    writeFileSync(join(origin, 'shared.txt'), 'base\n');
    const base = commit(origin, 'Base');
    writeFileSync(join(origin, 'shared.txt'), 'feature\n');
    const head = commit(origin, 'Feature');
    const equal = mergeCommit(origin, head, base);
    gitAt(origin, 'checkout', '--quiet', '--detach', base);
    writeFileSync(join(origin, 'base-only.txt'), 'Genuinely new base content\n');
    commit(origin, 'Advance base');
    gitAt(origin, 'merge', '--quiet', '--no-ff', head, '-m', 'Divergent merge');
    const divergent = gitAt(origin, 'rev-parse', 'HEAD');
    gitAt(origin, 'checkout', '--quiet', '--detach', head);
    writeFileSync(join(origin, '.github', 'workflows', 'azure-deploy.yml'),
        workflowSource.replace('--configuration Release --no-restore', '--configuration Debug --no-restore'));
    const changed = commit(origin, 'Change executed workflow');
    const changedEqual = mergeCommit(origin, changed, base);
    commits = { base, head, equal, divergent, changed, changedEqual };
    for (const [name, sha] of [['event', equal], ['validation', head]]) {
        const path = join(root, name);
        mkdirSync(path);
        gitAt(path, 'init', '--quiet');
        gitAt(path, 'fetch', '--quiet', '--depth=1', origin, sha);
        gitAt(path, 'checkout', '--quiet', '--detach', sha);
        gitAt(path, 'remote', 'add', 'origin', `https://github.com/${repository}`);
    }
    eventGit = new Git(join(root, 'event'));
    headGit = new Git(join(root, 'validation'));
    for (const sha of [head, divergent, changed, changedEqual])
        gitAt(eventGit.cwd, 'fetch', '--quiet', '--depth=1', origin, sha);
});
after(() => rmSync(root, { recursive: true, force: true }));

function context(event = 'pull_request', sha = commits.equal, head = commits.head) {
    const ref = event === 'pull_request' ? 'refs/pull/42/merge' : 'refs/heads/feature';
    return {
        repository, repositoryId, runId: event === 'push' ? sourceId : currentId,
        attempt: 1, eventName: event, eventSha: sha, ref, workflowSha: sha,
        workflowRef: `${repository}/${WORKFLOW}@${ref}`, server: 'https://github.com',
        event: {
            action: 'synchronize', deleted: false, after: sha,
            repository: { id: repositoryId, full_name: repository, default_branch: 'main' },
            pull_request: {
                head: { sha: head, ref: 'feature', repo: { id: repositoryId, full_name: repository } },
                base: { ref: 'main', repo: { id: repositoryId, full_name: repository } },
            },
        },
    };
}
function steps() {
    const result = Object.fromEntries(Object.keys(VALIDATION_STEPS).map(id =>
        [id, { outcome: 'success', conclusion: 'success' }]));
    result.reuse.outputs = { hit: 'false' };
    return result;
}
async function zipBytes(value, options = {}) {
    return new Promise(resolveZip => {
        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
            options.name || 'proof.json', { compress: false });
        if (options.extra) zip.addBuffer(Buffer.from('extra'), 'unexpected.json');
        const chunks = [];
        zip.outputStream.on('data', chunk => chunks.push(chunk));
        zip.outputStream.on('end', () => resolveZip(Buffer.concat(chunks)));
        zip.end();
    });
}
async function scenario() {
    gitAt(eventGit.cwd, 'checkout', '--quiet', '--detach', commits.equal);
    gitAt(headGit.cwd, 'checkout', '--quiet', '--detach', commits.head);
    const c = context();
    const inputs = { eligible: 'true', fingerprint: 'a'.repeat(64), ...headGit.identity(commits.head) };
    const proof = makeProof({ context: context('push', commits.head), git: headGit,
        inputs, workflow: workflowId, steps: steps(), now: NOW - 120_000 });
    const run = {
        id: sourceId, run_attempt: 1, event: 'push', head_sha: commits.head, head_branch: 'feature',
        repository: { id: repositoryId, full_name: repository },
        head_repository: { id: repositoryId, full_name: repository },
        workflow_id: workflowId, path: WORKFLOW, created_at: iso(-600_000),
        status: 'in_progress', conclusion: null,
    };
    const job = {
        id: 987, run_id: sourceId, run_attempt: 1, head_sha: commits.head,
        name: 'Build Application', status: 'completed', conclusion: 'success',
        started_at: iso(-540_000), completed_at: iso(-60_000),
        steps: [...Object.values(VALIDATION_STEPS), 'Write validation proof', 'Publish validation proof']
            .map((name, index) => ({ name, number: index + 2, status: 'completed', conclusion: 'success' })),
    };
    const artifact = {
        id: 654, name: artifactName(sourceId), expired: false,
        created_at: iso(-90_000), expires_at: iso(-90_000 + 86_400_000),
        workflow_run: { id: sourceId, repository_id: repositoryId, head_repository_id: repositoryId,
            head_sha: commits.head, head_branch: 'feature' },
    };
    const f = {
        c, inputs, proof, run, job, artifact, calls: [], intercept: null,
        workflow: { id: workflowId, path: WORKFLOW, state: 'active' },
        runList: { total_count: 1, workflow_runs: [run] },
        jobs: { total_count: 1, jobs: [job] },
        artifacts: { total_count: 1, artifacts: [artifact] },
        async repack(value = proof, options) {
            f.bytes = await zipBytes(value, options);
            artifact.digest = `sha256:${digest(f.bytes)}`;
            artifact.size_in_bytes = f.bytes.length;
        },
        async api(path, binary) {
            assert.ok(path.startsWith(apiPrefix), 'API access stays inside the current repository');
            const suffix = path.slice(apiPrefix.length);
            f.calls.push(suffix);
            const count = f.calls.filter(call => call === suffix).length;
            if (f.intercept) await f.intercept(suffix, count);
            let value;
            if (suffix === 'workflows/azure-deploy.yml') value = f.workflow;
            else if (suffix === `workflows/azure-deploy.yml/runs?event=push&head_sha=${f.c.event.pull_request.head.sha}&per_page=20`) value = f.runList;
            else if (suffix === `runs/${sourceId}`) value = f.run;
            else if (suffix === `runs/${sourceId}/attempts/1/jobs?per_page=100`) value = f.jobs;
            else if (suffix === `runs/${sourceId}/artifacts?per_page=100`) value = f.artifacts;
            else if (suffix === 'artifacts/654/zip') { assert.equal(binary, true); return f.bytes; }
            else if (suffix === 'artifacts/654') value = f.artifact;
            else throw new Error(`Unexpected test API path: ${suffix}`);
            return structuredClone(value);
        },
        plan: () => plan({ context: c, git: eventGit, api: f.api, now: NOW }),
        verify: () => verify({ context: c, git: headGit, eventGit, sourceId: String(sourceId),
            inputs, api: f.api, now: NOW }),
    };
    await f.repack();
    return f;
}
function fullPlan(result) {
    assert.equal(result.source_id, '');
    assert.match(result.group, new RegExp(`^${POLICY}-full-`));
}

test('real equal-tree commits select the immutable head, with a fresh detached shallow checkout', async () => {
    const f = await scenario();
    assert.notEqual(commits.head, commits.equal);
    assert.equal(eventGit.identity(commits.equal).checkoutTree, headGit.identity(commits.head).checkoutTree);
    assert.throws(() => headGit.identity(commits.equal), 'Validation checkout must not depend on having the merge object');
    assert.deepEqual(selectCheckout(f.c, eventGit, String(sourceId)),
        { sha: commits.head, reason: 'identical-tree-head' });
    assert.equal(headGit.run('rev-parse', '--is-shallow-repository'), 'true');
    headGit.assertCheckout(commits.head);
    const result = await capture({ context: f.c, git: headGit, eventGit,
        env: { VALIDATION_SHA: commits.head }, cwd: headGit.cwd, probe: async () => 'a'.repeat(64) });
    assert.equal(result.eligible, 'true');
    assert.equal(result.checkoutSha, commits.head);
});

test('tree gate rejects a genuinely divergent merge, not just a different commit ID', async () => {
    const f = await scenario();
    f.c.eventSha = f.c.workflowSha = commits.divergent;
    gitAt(eventGit.cwd, 'checkout', '--quiet', '--detach', commits.divergent);
    assert.notEqual(eventGit.identity(commits.divergent).checkoutTree, headGit.identity(commits.head).checkoutTree);
    const result = await f.plan();
    fullPlan(result);
    assert.equal(result.reason, 'different-tree');
    assert.equal(f.calls.length, 0, 'Tree mismatch is rejected before any source discovery');
    assert.deepEqual(selectCheckout(f.c, eventGit, String(sourceId)),
        { sha: commits.divergent, reason: 'different-tree' });
});

test('missing immutable event checkout is fatal, not a successful miss', async () => {
    const f = await scenario();
    f.c.eventSha = 'f'.repeat(40);
    await assert.rejects(f.plan(), CheckoutError);
    assert.throws(() => selectCheckout(f.c, eventGit, String(sourceId)), CheckoutError);
    await assert.rejects(capture({ context: f.c, git: headGit, env: { VALIDATION_SHA: commits.equal } }), CheckoutError);
});

test('missing head objects and failed fetch retain the intended event checkout', async () => {
    const f = await scenario();
    f.c.event.pull_request.head.sha = 'f'.repeat(40);
    const git = new Git(eventGit.cwd);
    const original = git.run.bind(git);
    git.run = (...args) => {
        if (args[0] === 'fetch') throw new Error('private-api-error-sentinel');
        return original(...args);
    };
    const result = await plan({ context: f.c, git, api: f.api, now: NOW });
    fullPlan(result);
    assert.equal(result.reason, 'source-objects-unavailable');
    assert.equal(selectCheckout(f.c, git, String(sourceId)).sha, commits.equal);
});

test('changed workflow has a different real blob and cannot satisfy an old proof', async () => {
    const f = await scenario();
    assert.notEqual(eventGit.identity(commits.changed).workflowBlob, f.proof.workflowBlob);
    f.proof.workflowBlob = eventGit.identity(commits.changed).workflowBlob;
    await f.repack();
    assert.equal((await f.verify()).reason, 'proof-inputs-or-provenance');
});

test('source-first running Build uses server-side queue without downloading or polling', async () => {
    const f = await scenario();
    f.job.status = 'in_progress';
    f.job.conclusion = null;
    const result = await f.plan();
    assert.deepEqual(result, { group: `${POLICY}-${repositoryId}-${commits.head}`,
        source_id: String(sourceId), reason: 'source-running' });
    assert.equal(f.calls.filter(path => path.includes('/jobs?')).length, 1);
    assert.ok(f.calls.every(path => !path.includes('artifact')));
});

test('completed Build proof is eligible while the source deployment is still running', async () => {
    const f = await scenario();
    assert.equal((await f.plan()).reason, 'source-proof-ready');
    const result = await f.verify();
    assert.deepEqual(result, { hit: 'true', reason: 'verified-push-proof',
        source_id: String(sourceId), artifact_id: '654' });
    assert.equal(f.run.status, 'in_progress');
    assert.ok(f.calls.includes(`runs/${sourceId}/attempts/1/jobs?per_page=100`));
    assert.equal(f.calls.at(-1), `runs/${sourceId}`, 'Final source refresh immediately precedes a hit');
});

for (const [arrival, mutate, reason] of [
    ['PR-first', f => { f.runList = { total_count: 0, workflow_runs: [] }; }, 'no-source'],
    ['push workflow queued', f => { f.run.status = 'queued'; f.jobs = { total_count: 0, jobs: [] }; }, 'source-build-missing'],
    ['push Build merely queued', f => { f.job.status = 'queued'; f.job.conclusion = null; }, 'source-not-running'],
    ['completed without proof', f => { f.artifacts = { total_count: 0, artifacts: [] }; }, 'proof-unavailable'],
]) {
    test(`arrival order: ${arrival} cannot join or block the source group`, async () => {
        const f = await scenario();
        mutate(f);
        const result = await f.plan();
        fullPlan(result);
        assert.equal(result.reason, reason);
        assert.equal(selectCheckout(f.c, eventGit, result.source_id).sha, commits.equal);
    });
}

for (const [label, mutate, reason] of [
    ['fork', c => { c.event.pull_request.head.repo.id++; }, 'fork'],
    ['rerun', c => { c.attempt = 2; }, 'rerun'],
    ['manual', c => { c.eventName = 'workflow_dispatch'; }, 'event-ineligible'],
    ['push', c => { c.eventName = 'push'; }, 'event-ineligible'],
    ['unexecuted workflow revision', c => { c.workflowSha = commits.head; }, 'workflow-ineligible'],
    ['different workflow path', c => { c.workflowRef = 'other-workflow'; }, 'workflow-ineligible'],
    ['unknown repository', c => { c.repositoryId++; }, 'repository-ineligible'],
    ['unexpected PR action', c => { c.event.action = 'edited'; }, 'pr-ineligible'],
]) {
    test(`ineligible ${label} always validates fully`, async () => {
        const f = await scenario();
        mutate(f.c);
        const result = await f.plan();
        fullPlan(result);
        assert.equal(result.reason, reason);
        assert.equal((await f.verify()).hit, 'false');
        assert.equal(f.calls.length, 0);
    });
}

for (const [label, mutate, reason] of [
    ['run identity', f => { f.run.id++; }, 'source-attempt'],
    ['source rerun attempt', f => { f.run.run_attempt = 2; }, 'source-attempt'],
    ['source is PR (no chains)', f => { f.run.event = 'pull_request'; }, 'source-event'],
    ['wrong head', f => { f.run.head_sha = commits.base; }, 'source-event'],
    ['production source', f => { f.run.head_branch = 'main'; }, 'source-event'],
    ['wrong repository', f => { f.run.repository.id++; }, 'source-repository'],
    ['wrong repository name', f => { f.run.repository.full_name = 'other/repo'; }, 'source-repository'],
    ['wrong head repository', f => { f.run.head_repository.id++; }, 'source-repository'],
    ['wrong workflow ID', f => { f.run.workflow_id++; }, 'source-workflow'],
    ['wrong executed workflow path', f => { f.run.path = '.github/workflows/other.yml'; }, 'source-workflow'],
    ['stale run', f => { f.run.created_at = iso(-86_400_001); }, 'source-stale'],
    ['future run', f => { f.run.created_at = iso(1); }, 'source-stale'],
    ['failed run', f => { f.run.status = 'completed'; f.run.conclusion = 'failure'; }, 'source-run-unsuccessful'],
    ['cancelled run', f => { f.run.status = 'completed'; f.run.conclusion = 'cancelled'; }, 'source-run-unsuccessful'],
    ['missing Build', f => { f.jobs = { total_count: 0, jobs: [] }; }, 'source-build-missing'],
    ['duplicate Build', f => { f.jobs.jobs.push(structuredClone(f.job)); f.jobs.total_count++; }, 'source-build-missing'],
    ['truncated job list', f => { f.jobs.total_count++; }, 'source-jobs-incomplete'],
    ['malformed job list', f => { f.jobs.jobs = null; }, 'source-jobs-incomplete'],
    ['wrong job attempt', f => { f.job.run_attempt = 2; }, 'source-job-identity'],
    ['wrong job owner', f => { f.job.run_id++; }, 'source-job-identity'],
    ['wrong job checkout', f => { f.job.head_sha = commits.base; }, 'source-job-identity'],
    ['running Build is not proof', f => { f.job.status = 'in_progress'; f.job.conclusion = null; }, 'source-build-not-successful'],
    ['failed Build', f => { f.job.conclusion = 'failure'; }, 'source-build-not-successful'],
    ['cancelled Build', f => { f.job.conclusion = 'cancelled'; }, 'source-build-not-successful'],
    ['skipped Build', f => { f.job.conclusion = 'skipped'; }, 'source-build-not-successful'],
    ['missing steps', f => { delete f.job.steps; }, 'source-steps-incomplete'],
    ['skipped validation step', f => { f.job.steps.find(step => step.name === 'Run tests').conclusion = 'skipped'; }, 'source-step-not-successful'],
    ['failed validation step', f => { f.job.steps.find(step => step.name === 'Run tests').conclusion = 'failure'; }, 'source-step-not-successful'],
    ['missing validation step', f => { f.job.steps.splice(5, 1); }, 'source-step-not-successful'],
    ['duplicate validation step', f => { f.job.steps.push(f.job.steps[5]); }, 'source-step-not-successful'],
    ['unordered validation steps', f => { f.job.steps[5].number = 1; }, 'source-step-not-successful'],
]) {
    test(`source gate: ${label}`, async () => {
        const f = await scenario();
        mutate(f);
        assert.deepEqual(await f.verify(), { hit: 'false', reason });
    });
}

test('every source validation and publication step must be truly completed/successful', async () => {
    const f = await scenario();
    for (const step of f.job.steps) {
        step.conclusion = 'skipped';
        assert.equal((await f.verify()).reason, 'source-step-not-successful', step.name);
        step.conclusion = 'success';
        step.status = 'in_progress';
        assert.equal((await f.verify()).reason, 'source-step-not-successful', step.name);
        step.status = 'completed';
    }
});

test('no self reuse, missing planner outputs or malformed source IDs', async () => {
    const f = await scenario();
    for (const candidate of [String(currentId), undefined, '', 'not-an-id', '789\n', true, '-1']) {
        const result = await verify({ context: f.c, git: headGit, eventGit, inputs: f.inputs,
            sourceId: candidate, api: f.api, now: NOW });
        assert.deepEqual(result, { hit: 'false', reason: 'no-planned-source' });
    }
    assert.equal(f.calls.length, 0);
});

for (const [label, mutate, reason] of [
    ['absent', f => { f.artifacts = { total_count: 0, artifacts: [] }; }, 'proof-unavailable'],
    ['duplicate', f => { f.artifacts.artifacts.push(f.artifact); f.artifacts.total_count++; }, 'proof-unavailable'],
    ['truncated list', f => { f.artifacts.total_count++; }, 'artifact-list-incomplete'],
    ['wrong name', f => { f.artifact.name = 'other-proof'; }, 'proof-unavailable'],
    ['expired', f => { f.artifact.expired = true; }, 'proof-unavailable'],
    ['wrong run owner', f => { f.artifact.workflow_run.id++; }, 'artifact-owner'],
    ['wrong repository owner', f => { f.artifact.workflow_run.repository_id++; }, 'artifact-owner'],
    ['fork owner', f => { f.artifact.workflow_run.head_repository_id++; }, 'artifact-owner'],
    ['wrong owner SHA', f => { f.artifact.workflow_run.head_sha = commits.base; }, 'artifact-owner'],
    ['wrong owner branch', f => { f.artifact.workflow_run.head_branch = 'main'; }, 'artifact-owner'],
    ['missing digest', f => { delete f.artifact.digest; }, 'artifact-digest-or-size'],
    ['wrong digest', f => { f.artifact.digest = `sha256:${'b'.repeat(64)}`; }, 'artifact-digest-mismatch'],
    ['oversized', f => { f.artifact.size_in_bytes = 65_537; }, 'artifact-digest-or-size'],
    ['size mismatch', f => { f.artifact.size_in_bytes++; }, 'artifact-digest-mismatch'],
    ['expired date', f => { f.artifact.expires_at = iso(-1); }, 'artifact-stale'],
    ['long retention', f => { f.artifact.expires_at = iso(172_800_000); }, 'artifact-stale'],
    ['stale', f => { f.artifact.created_at = iso(-86_400_001); }, 'artifact-stale'],
    ['future date', f => { f.artifact.created_at = iso(1); }, 'artifact-stale'],
]) {
    test(`artifact gate: ${label}`, async () => {
        const f = await scenario();
        mutate(f);
        assert.deepEqual(await f.verify(), { hit: 'false', reason });
    });
}

test('archive digest is enforced on actual downloaded bytes, not upload warnings', async () => {
    const f = await scenario();
    f.bytes[f.bytes.length - 1] ^= 1;
    assert.deepEqual(await f.verify(), { hit: 'false', reason: 'artifact-digest-mismatch' });
});

test('bounded standard ZIP reader rejects corrupt, extra, misplaced, oversized and invalid JSON proof entries', async () => {
    for (const bytes of [
        Buffer.from('not a zip'),
        await zipBytes({}, { extra: true }),
        await zipBytes({}, { name: 'subdirectory/proof.json' }),
        await zipBytes('x'.repeat(8193)),
        await zipBytes('not JSON'),
        Buffer.alloc(65_537),
    ]) await assert.rejects(readProofArchive(bytes), /artifact-/);
    const f = await scenario();
    f.bytes = Buffer.from('not a zip');
    f.artifact.digest = `sha256:${digest(f.bytes)}`;
    f.artifact.size_in_bytes = f.bytes.length;
    assert.deepEqual(await f.verify(), { hit: 'false', reason: 'artifact-invalid' });
});

test('every proof identity/fingerprint field is bound independently, with no extra payloads', async () => {
    const f = await scenario();
    for (const key of Object.keys(f.proof).filter(key => key !== 'createdAt')) {
        const old = f.proof[key];
        f.proof[key] = typeof old === 'number' ? old + 1 : `${old}-changed`;
        await f.repack();
        assert.deepEqual(await f.verify(), { hit: 'false', reason: 'proof-inputs-or-provenance' }, key);
        f.proof[key] = old;
    }
    for (const value of [null, [], { ...f.proof, secret: 'private-hostname-sentinel' }, { policy: POLICY }]) {
        await f.repack(value);
        assert.deepEqual(await f.verify(), { hit: 'false', reason: 'proof-schema' });
    }
    for (const createdAt of [iso(-86_400_001), iso(1), iso(-550_000), iso(-30_000), 'invalid']) {
        await f.repack({ ...f.proof, createdAt });
        assert.deepEqual(await f.verify(), { hit: 'false', reason: 'proof-stale' });
    }
});

test('unknown or mismatching effective inputs cannot hit', async () => {
    const f = await scenario();
    for (const mutate of [
        () => { f.inputs.eligible = 'false'; },
        () => { f.inputs.eligible = 'true'; f.inputs.fingerprint = ''; },
        () => { f.inputs.fingerprint = 'b'.repeat(64); },
        () => { f.inputs.fingerprint = 'a'.repeat(64); f.inputs.checkoutTree = commits.base; },
    ]) {
        mutate();
        assert.equal((await f.verify()).hit, 'false');
    }
    const inputs = await capture({ context: f.c, git: headGit, eventGit, cwd: headGit.cwd,
        env: { VALIDATION_SHA: commits.head }, probe: async () => { throw new Error('private-input-sentinel'); } });
    assert.deepEqual(inputs, { eligible: 'false', reason: 'inputs-unavailable' });
    await assert.rejects(effectiveInputs({}, headGit.cwd), /runner-inputs-unknown/);
});

test('fingerprint uses real restored files and every effective runner/tool input without event metadata', async () => {
    const cwd = join(root, 'input-probe');
    const files = [
        'AstervoidsWeb/obj/project.assets.json', 'AstervoidsWeb.Tests/obj/project.assets.json',
        'node_modules/.package-lock.json', 'node_modules/playwright-core/browsers.json',
    ];
    for (const path of files) {
        const absolute = join(cwd, path);
        mkdirSync(resolve(absolute, '..'), { recursive: true });
        writeFileSync(absolute, '{"version":"1","integrity":"sha512-fixture"}');
    }
    const env = {
        RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
        ImageOS: 'ubuntu24', ImageVersion: '20261009.1.0', DOTNET_ROOT: '/usr/share/dotnet',
        HOME: cwd, PATH: process.env.PATH, GITHUB_SHA: 'not-a-validation-input',
    };
    const commands = new Map([
        ['dotnet --info', '.NET SDK:\n Version: 10.0.100\n.NET runtime 10.0.0'],
        ['npm --version', '10.9.4'], ['git --version', 'git version 2.51.0'],
        ['bash --version', 'GNU bash 5.2.21'],
        ['az version --output json', '{"azure-cli":"2.80.0","extensions":{}}'],
        ['az bicep version', 'Bicep CLI version 0.37.4'],
        ['dpkg-query -W -f=${binary:Package}=${Version}\n', 'libc6=2.39\nlibfontconfig1=2.15.0'],
    ]);
    const execute = (file, args, options) => {
        assert.equal(options.cwd, cwd);
        assert.equal(options.env.CI, 'true');
        assert.ok(!Object.hasOwn(options.env, 'GITHUB_SHA'));
        assert.ok(!Object.hasOwn(options.env, 'BROWSER_SMOKE_BASE_URL'));
        if (file === 'node') {
            assert.match(args[2], /chromium\.launchServer\(\)/);
            assert.match(args[2], /readFileSync\(b\.process\(\)\.spawnfile\)/);
            return 'c'.repeat(64);
        }
        const value = commands.get([file, ...args].join(' '));
        assert.notEqual(value, undefined, 'All executed input probes are known');
        return value;
    };
    const first = await effectiveInputs(env, cwd, execute);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await effectiveInputs({ ...env, GITHUB_SHA: 'other-event', CI: 'false' }, cwd, execute), first);
    for (const path of files) {
        const absolute = join(cwd, path);
        const original = readFileSync(absolute);
        writeFileSync(absolute, '{"version":"changed"}');
        assert.notEqual(await effectiveInputs(env, cwd, execute), first, path);
        writeFileSync(absolute, original);
    }
    for (const [key, value] of commands) {
        commands.set(key, key.startsWith('az version') ? '{"azure-cli":"2.81.0"}' : `${value}-changed`);
        assert.notEqual(await effectiveInputs(env, cwd, execute), first, key);
        commands.set(key, value);
    }
    for (const patch of [{ ImageVersion: '20261010.1.0' }, { ImageOS: 'ubuntu26' }, { DOTNET_ROOT: 'other-dotnet' },
        { PATH: `${env.PATH}-changed` }, { HOME: `${cwd}-changed` }])
        assert.notEqual(await effectiveInputs({ ...env, ...patch }, cwd, execute), first);
    assert.notEqual(await effectiveInputs(env, cwd, (file, args, options) =>
        file === 'node' ? 'd'.repeat(64) : execute(file, args, options)), first, 'Actual browser binary hash matters');
    await assert.rejects(effectiveInputs(env, cwd, () => { throw new Error('private-tool-error'); }), /tool-inputs-unavailable/);
    await assert.rejects(effectiveInputs(env, cwd, (file, args, options) =>
        file === 'node' ? 'unknown-binary' : execute(file, args, options)), /browser-inputs-unknown/);
    for (const [fileName, invalid] of [['dotnet', ''], ['npm', 'unknown'], ['az', '{}']]) {
        await assert.rejects(effectiveInputs(env, cwd, (file, args, options) =>
            file === fileName ? invalid : execute(file, args, options)), /tool-inputs-unknown/);
    }
});

test('real gh adapter bounds JSON/archive reads and never surfaces API error bodies', () => {
    const endpoint = `${apiPrefix}runs/${sourceId}`;
    const execute = (file, args, options) => {
        assert.equal(file, 'gh');
        assert.deepEqual(args, ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint]);
        assert.equal(options.timeout, 20_000);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(options.maxBuffer, options.encoding ? 2 * 1024 * 1024 : 64 * 1024);
        return options.encoding ? '{"id":789}' : Buffer.from('archive');
    };
    assert.deepEqual(githubApi(endpoint, false, execute), { id: sourceId });
    assert.deepEqual(githubApi(endpoint, true, execute), Buffer.from('archive'));
    for (const execute of [
        () => { throw new Error('private-token-and-hostname-sentinel'); },
        () => 'not-json-private-sentinel',
    ]) assert.throws(() => githubApi(endpoint, false, execute), error => error.message === 'api-unavailable');
});

for (const [endpoint, occurrence] of [
    ['workflows/azure-deploy.yml', 1],
    [`runs/${sourceId}`, 1],
    [`runs/${sourceId}/attempts/1/jobs?per_page=100`, 1],
    [`runs/${sourceId}/artifacts?per_page=100`, 1],
    ['artifacts/654/zip', 1],
    [`runs/${sourceId}/attempts/1/jobs?per_page=100`, 2],
    ['artifacts/654', 1],
    [`runs/${sourceId}`, 2],
]) {
    test(`API error cannot become a hit: ${endpoint} read ${occurrence}`, async () => {
        const f = await scenario();
        f.intercept = (path, count) => {
            if (path === endpoint && count === occurrence) throw new Error('private-token-and-hostname-sentinel');
        };
        assert.deepEqual(await f.verify(), { hit: 'false', reason: 'api-unavailable' });
    });
}

test('planner API discovery errors never join the source queue or disclose private responses', async () => {
    const f = await scenario();
    f.intercept = path => {
        if (path.includes('/runs?')) throw new Error('private-token-and-hostname-sentinel');
    };
    const result = await f.plan();
    fullPlan(result);
    assert.equal(result.reason, 'api-unavailable');
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

for (const [label, mutate] of [
    ['attempt changed', f => { f.run.run_attempt = 2; }],
    ['run cancelled', f => { f.run.status = 'completed'; f.run.conclusion = 'cancelled'; }],
    ['Build changed', f => { f.job.id++; }],
    ['Build failed', f => { f.job.conclusion = 'failure'; }],
    ['validation step skipped', f => { f.job.steps[5].conclusion = 'skipped'; }],
    ['artifact expired', f => { f.artifact.expired = true; }],
    ['artifact digest changed', f => { f.artifact.digest = `sha256:${'b'.repeat(64)}`; }],
]) {
    test(`final refresh fails closed: ${label}`, async () => {
        const f = await scenario();
        f.intercept = (path, count) => {
            if (path === `runs/${sourceId}/attempts/1/jobs?per_page=100` && count === 2) mutate(f);
        };
        assert.equal((await f.verify()).hit, 'false');
    });
}

test('final decision rechecks age/expiry at the current clock, not at request start', async () => {
    const f = await scenario();
    f.artifact.expires_at = iso(1000);
    let time = NOW;
    f.intercept = (path, count) => {
        if (path === `runs/${sourceId}` && count === 2) time += 2000;
    };
    const result = await verify({ context: f.c, git: headGit, eventGit, sourceId: String(sourceId),
        inputs: f.inputs, api: f.api, clock: () => time });
    assert.deepEqual(result, { hit: 'false', reason: 'artifact-stale' });
});

test('publication requires a first-attempt nonproduction full push and every actual step outcome', async () => {
    const f = await scenario();
    const c = context('push', commits.head);
    const params = { context: c, git: headGit, inputs: f.inputs, workflow: workflowId, steps: steps(), now: NOW };
    assert.equal(makeProof(params).mode, 'full');
    for (const id of Object.keys(VALIDATION_STEPS)) {
        params.steps[id].outcome = 'skipped';
        assert.throws(() => makeProof(params), /validation-not-full/, id);
        params.steps[id].outcome = 'success';
        params.steps[id].conclusion = 'failure';
        assert.throws(() => makeProof(params), /validation-not-full/, id);
        params.steps[id].conclusion = 'success';
    }
    params.steps.reuse.outputs.hit = 'true';
    assert.throws(() => makeProof(params), /validation-not-full/);
    params.steps = steps();
    for (const event of ['pull_request', 'workflow_dispatch']) {
        c.eventName = event;
        assert.throws(() => makeProof(params), /event-ineligible/);
    }
    c.eventName = 'push';
    c.attempt = 2;
    assert.throws(() => makeProof(params), /rerun/);
    c.attempt = 1;
    c.ref = 'refs/heads/main';
    c.workflowRef = `${repository}/${WORKFLOW}@${c.ref}`;
    assert.throws(() => makeProof(params), /production-or-nonbranch/);
});

test('validation child environment preserves local CI semantics but excludes orchestration and private inputs', () => {
    const env = validationEnvironment({
        PATH: process.env.PATH, HOME: root, DOTNET_ROOT: 'dotnet-tool-path',
        CI: 'false', GITHUB_SHA: 'event-sentinel', GITHUB_REF: 'ref-sentinel',
        GITHUB_TOKEN: 'private-token-sentinel', GH_TOKEN: 'private-token-sentinel',
        BROWSER_SMOKE_BASE_URL: 'https://private-hostname-sentinel.example.com',
        CUSTOM_DOMAIN: 'private-hostname-sentinel', Identity__Provider: 'AzureTable',
        NODE_OPTIONS: '--require untrusted.js', BASH_ENV: 'untrusted.sh',
    }, root);
    assert.equal(env.CI, 'true');
    assert.equal(env.BROWSER_SMOKE_NO_BUILD, '1');
    assert.equal(env.TMPDIR, join(root, '.validation-work'));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.ok(!Object.hasOwn(env, 'BROWSER_SMOKE_BASE_URL'));
    assert.doesNotMatch(JSON.stringify(env), /sentinel|GITHUB_|GH_TOKEN|AzureTable|untrusted/);
    const result = spawnSync(process.execPath, [helperPath, 'exec', '--', process.execPath, '-e',
        "console.log(JSON.stringify({ci:process.env.CI,noBuild:process.env.BROWSER_SMOKE_NO_BUILD,remote:Object.hasOwn(process.env,'BROWSER_SMOKE_BASE_URL'),git:process.env.GITHUB_SHA,token:process.env.GH_TOKEN}));"],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'private-sentinel', GH_TOKEN: 'private-sentinel',
        BROWSER_SMOKE_BASE_URL: 'https://private.example.com' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ci: 'true', noBuild: '1', remote: false });
    const failure = spawnSync(process.execPath, [helperPath, 'exec', '--', process.execPath, '-e', 'process.exit(23)'],
        { cwd: root, encoding: 'utf8', env: process.env });
    assert.equal(failure.status, 23, 'Real validation failure is not converted into an optimization miss');
});

test('actual CLI fallback outputs and summaries contain only fixed reasons and public checkout identity', async () => {
    const f = await scenario();
    const eventPath = join(root, 'event-payload.json');
    const output = join(root, 'step-output');
    const summary = join(root, 'step-summary');
    f.c.event.pull_request.head.repo.id++;
    f.c.event.privateTestValue = 'private-token-hostname-and-payload-sentinel';
    writeFileSync(eventPath, JSON.stringify(f.c.event));
    const env = {
        ...process.env,
        GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(repositoryId),
        GITHUB_RUN_ID: String(currentId), GITHUB_RUN_ATTEMPT: '1',
        GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: commits.equal, GITHUB_REF: f.c.ref,
        GITHUB_WORKFLOW_SHA: commits.equal, GITHUB_WORKFLOW_REF: f.c.workflowRef,
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        VALIDATION_SOURCE_ID: String(sourceId), GH_TOKEN: 'private-token-sentinel',
    };
    for (const command of ['plan', 'select']) {
        const child = spawnSync(process.execPath, [helperPath, command], { cwd: eventGit.cwd, env, encoding: 'utf8' });
        assert.equal(child.status, 0);
        assert.match(child.stdout, new RegExp(`validation-reuse ${command}: fork`));
        assert.equal(child.stderr, '');
        assert.doesNotMatch(child.stdout + readFileSync(output, 'utf8') + readFileSync(summary, 'utf8'), /private-|payload|GH_TOKEN/);
    }
    assert.match(readFileSync(output, 'utf8'), new RegExp(`sha=${commits.equal}`));
    assert.match(readFileSync(output, 'utf8'), new RegExp(`group=${POLICY}-full-${currentId}-1`));
});

function parsedWorkflow(source = workflowSource) {
    const parsed = yaml.parseDocument(source, { uniqueKeys: true });
    assert.deepEqual(parsed.errors, []);
    return parsed.toJS();
}
function expression(value, github, needs, status = {}) {
    const source = value.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    return Function('github', 'needs', 'format', 'cancelled', 'success', `return (${source});`)(
        github, needs, (template, ...args) => template.replace(/\{(\d+)\}/g, (_, index) => args[index]),
        () => status.cancelled ?? false, () => status.success ?? false);
}

test('actual YAML contract preserves the Build gate, full fallback, validation commands and deployment interlock', () => {
    const workflow = parsedWorkflow();
    const { validation_plan: planner, build, deploy } = workflow.jobs;
    assert.equal(build.name, 'Build Application');
    assert.equal(build.needs, 'validation_plan');
    assert.equal(build.if, '${{ !cancelled() }}');
    assert.equal(expression(build.if, {}, {}, { success: false }), true, 'Planner failure still runs Build');
    assert.equal(expression(build.if, {}, {}, { success: false, cancelled: true }), false);
    assert.equal(deploy.needs, 'build');
    assert.equal(deploy.if, "github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
    assert.deepEqual(deploy.concurrency, { group: 'astervoids-azure-resource-mutations', 'cancel-in-progress': false });
    assert.ok(deploy.steps.findIndex(step => step.run?.includes('--verify-deployment-ref'))
        < deploy.steps.findIndex(step => step.id === 'vars'));
    assert.deepEqual(deploy.steps[0], { name: 'Checkout code', uses: 'actions/checkout@v5' });
    assert.equal(workflow.env, undefined);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    for (const job of [planner, build]) assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
    assert.deepEqual(deploy.permissions, { 'id-token': 'write', contents: 'read' });
    for (const name of ['CERT_KEY_VAULT_SECRET_URL', 'CERT_KEY_VAULT_CERT_NAME', 'CERT_READER_IDENTITY_ID'])
        assert.equal(deploy.env[name], `\${{ secrets.${name} }}`);
    assert.equal(deploy.env.DOTNET_VERSION, '10.0.x');
    assert.equal(planner.if, "github.event_name == 'pull_request'");
    assert.equal(planner.steps[0].with.ref, '${{ github.sha }}');
    assert.equal(build.concurrency['cancel-in-progress'], false);
    assert.equal(build.concurrency.queue, 'max');
    assert.deepEqual(build.defaults.run, { 'working-directory': 'validation',
        shell: 'node .github/scripts/validation-reuse.mjs exec -- bash --noprofile --norc -e -o pipefail {0}' });
    const byId = Object.fromEntries(build.steps.filter(step => step.id).map(step => [step.id, step]));
    for (const [id, name] of Object.entries(VALIDATION_STEPS)) {
        assert.equal(byId[id]?.name, name, id);
        assert.equal(byId[id]['continue-on-error'], undefined, id);
    }
    assert.equal(byId.event_checkout.with.ref, '${{ github.sha }}');
    assert.equal(byId.event_checkout.with.path, 'event');
    assert.equal(byId.validation_checkout.with.ref, '${{ steps.source.outputs.sha }}');
    assert.equal(byId.validation_checkout.with.path, 'validation');
    assert.equal(byId.source.env.VALIDATION_SOURCE_ID, '${{ needs.validation_plan.outputs.source_id }}');
    assert.equal(byId.checkout.env.VALIDATION_SHA, '${{ steps.source.outputs.sha }}');
    for (const step of [planner.steps[0], byId.event_checkout, byId.validation_checkout]) {
        assert.equal(step.uses, 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
        assert.equal(step.with['persist-credentials'], false);
    }
    assert.equal(byId.dotnet.uses, 'actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1');
    assert.equal(byId.dotnet.with['dotnet-version'], '10.0.x');
    assert.equal(byId.node.uses, 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444');
    assert.deepEqual(byId.node.with, { 'node-version': 22, cache: 'npm', 'cache-dependency-path': 'validation/package-lock.json' });
    const commands = {
        restore: 'dotnet restore astervoids.sln',
        npm: 'npm ci --ignore-scripts --no-audit --no-fund',
        chromium: 'npx playwright install --with-deps --only-shell chromium',
        compile: 'dotnet build astervoids.sln --configuration Release --no-restore',
        csharp: 'dotnet test astervoids.sln --configuration Release --no-build --verbosity normal',
        javascript: 'node --test AstervoidsWeb/*.test.mjs',
        browser_helpers: 'npm run test:browser:helpers',
        browser: 'npm run test:browser',
        squad: 'node --test .github/scripts/squad-setup.test.mjs',
        workflow_helpers: 'bash .github/scripts/workflow-helpers.test.sh',
    };
    const conditional = ['compile', 'csharp', 'javascript', 'browser_helpers', 'browser', 'squad', 'workflow_helpers'];
    for (const [id, command] of Object.entries(commands)) {
        assert.equal(byId[id].run, command, id);
        assert.equal(byId[id].shell, undefined, `${id} uses the clean validation environment`);
        assert.equal(byId[id].if, conditional.includes(id) ? "steps.reuse.outputs.hit != 'true'" : undefined);
    }
    assert.equal(byId.browser['timeout-minutes'], 5);
    assert.deepEqual(byId.browser.env, { BROWSER_SMOKE_NO_BUILD: '1' });
    assert.match(byId.bicep.run, /az bicep build --file infra\/main.bicep --outfile test-results\/main.compiled.json/);
    assert.equal(byId.bicep.if, undefined);
    for (const id of ['source', 'checkout', 'inputs', 'reuse', 'proof'])
        assert.equal(byId[id].shell, 'bash', `${id} alone needs orchestration metadata`);
    for (const id of ['checkout', 'inputs', 'reuse']) assert.equal(byId[id].if, undefined);
    assert.equal(byId.proof.if, "github.event_name == 'push' && github.run_attempt == 1 && github.ref != 'refs/heads/main' && steps.inputs.outputs.eligible == 'true' && steps.reuse.outputs.hit == 'false'");
    assert.equal(byId.proof['continue-on-error'], true);
    const upload = build.steps.at(-1);
    assert.equal(upload.name, 'Publish validation proof');
    assert.equal(upload.if, "steps.proof.outputs.publish == 'true'");
    assert.equal(upload['continue-on-error'], true);
    assert.equal(upload.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    assert.deepEqual(upload.with, {
        name: `${POLICY}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
        path: 'validation/test-results/validation-proof/proof.json', 'retention-days': 1,
        'compression-level': 0, 'if-no-files-found': 'error',
    });
    assert.doesNotMatch(JSON.stringify([planner, build]), /secrets\.|CUSTOM_DOMAIN|checks.*write|BROWSER_SMOKE_BASE_URL|workflow_run/);
});

test('actual YAML scheduling expression isolates production/reruns/manual/PR-first/planner failures', () => {
    const group = parsedWorkflow().jobs.build.concurrency.group;
    const github = { event_name: 'push', run_attempt: 1, ref: 'refs/heads/feature',
        repository_id: repositoryId, sha: commits.head, run_id: sourceId };
    const needs = { validation_plan: { outputs: {} } };
    const sourceGroup = `${POLICY}-${repositoryId}-${commits.head}`;
    assert.equal(expression(group, github, needs), sourceGroup);
    for (const patch of [{ run_attempt: 2 }, { ref: 'refs/heads/main' }, { event_name: 'workflow_dispatch' },
        { event_name: 'pull_request' }]) {
        const actual = { ...github, ...patch };
        assert.equal(expression(group, actual, needs), `${POLICY}-full-${actual.run_id}-${actual.run_attempt}`);
    }
    github.event_name = 'pull_request';
    github.run_id = currentId;
    needs.validation_plan.outputs.group = sourceGroup;
    assert.equal(expression(group, github, needs), sourceGroup);
    assert.equal(expression(group, { ...github, run_attempt: 2 }, needs), `${POLICY}-full-${currentId}-2`,
        'Rerun-failed-jobs must ignore an earlier successful planner output');
    assert.equal(expression(group, { ...github, event_name: 'workflow_dispatch' }, needs), `${POLICY}-full-${currentId}-1`);
    needs.validation_plan.outputs.group = `${POLICY}-full-${currentId}-1`;
    assert.equal(expression(group, github, needs), `${POLICY}-full-${currentId}-1`);
    const conditional = parsedWorkflow().jobs.build.steps.find(step => step.id === 'compile').if;
    for (const value of ['', undefined, 'false', 'true']) {
        const actual = Function('steps', `return (${conditional});`)({ reuse: { outputs: { hit: value } } });
        assert.equal(actual, value !== 'true', 'Only a verified explicit hit may omit full validation');
    }
});

test('critical mutations of production helper/YAML are rejected by the unchanged contract tests', {
    skip: process.env.REUSE_MUTATION_CHILD === '1',
}, () => {
    const mutations = [
        ['tree', 'helper', "check(eventGit.identity(context.eventSha).checkoutTree === source.checkoutTree, 'different-tree');",
            "check(true, 'different-tree');", 'tree gate rejects'],
        ['skipped', 'helper', "matches[0].conclusion === 'success'",
            "['success', 'skipped'].includes(matches[0].conclusion)", 'source gate: skipped validation step'],
        ['attempt', 'helper', 'run.id !== c.runId && run.run_attempt === 1',
            'run.id !== c.runId', 'source gate: source rerun attempt'],
        ['api-hit', 'helper', "return { ...fallback, reason: miss(error, 'verification-unavailable') };",
            "return { ...fallback, hit: 'true', reason: miss(error, 'verification-unavailable') };", 'API error cannot become a hit'],
        ['deploy-dependency', 'workflow', '    needs: build\n', '    needs: validation_plan\n', 'actual YAML contract'],
        ['planner-green', 'workflow', '    if: ${{ !cancelled() }}\n', '    if: ${{ success() }}\n', 'actual YAML contract'],
    ];
    for (const [label, kind, beforeText, afterText, pattern] of mutations) {
        const source = kind === 'helper' ? helperSource : workflowSource;
        assert.equal(source.split(beforeText).length, 2, `${label}: uniquely mutate actual production bytes`);
        const path = join(root, kind === 'helper' ? `mutant-${label}.mjs` : `mutant-${label}.yml`);
        writeFileSync(path, source.replace(beforeText, afterText));
        try {
            const env = { ...process.env, REUSE_MUTATION_CHILD: '1',
                [kind === 'helper' ? 'REUSE_MUTANT_HELPER' : 'REUSE_MUTANT_WORKFLOW']: path };
            delete env.NODE_TEST_CONTEXT;
            const child = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, fileURLToPath(import.meta.url)], {
                cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
                env,
            });
            assert.equal(child.status, 1, `${label}: the actual regression must make the suite fail\n${child.stdout}\n${child.stderr}`);
            assert.match(child.stdout, /AssertionError|ERR_ASSERTION/, `${label}: must fail an assertion, not tooling/setup`);
        } finally { rmSync(path, { force: true }); }
    }
});
