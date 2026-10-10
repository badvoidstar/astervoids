import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY = 'astervoids-validation-v1';
export const WORKFLOW = '.github/workflows/azure-deploy.yml';
const HELPER = '.github/scripts/validation-reuse.mjs';
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_ZIP = 64 * 1024;
const MAX_PROOF = 8 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const require = createRequire(import.meta.url);

export const VALIDATION_STEPS = {
    event_checkout: 'Checkout event commit',
    source: 'Select validation source',
    validation_checkout: 'Checkout validation commit',
    checkout: 'Verify validation checkout',
    dotnet: 'Setup .NET',
    node: 'Setup Node.js',
    restore: 'Restore dependencies',
    npm: 'Install browser smoke tooling',
    chromium: 'Install Chromium',
    bicep: 'Bicep build (template smoke check)',
    inputs: 'Capture validation inputs',
    reuse: 'Verify push validation proof',
    compile: 'Build solution',
    csharp: 'Run tests',
    javascript: 'Run JavaScript tests',
    browser_helpers: 'Validate browser smoke helpers',
    browser: 'Real-browser local playability smoke',
    squad: 'Validate Squad setup',
    workflow_helpers: 'Validate workflow helpers',
};
const PROOF_STEPS = [...Object.values(VALIDATION_STEPS), 'Write validation proof', 'Publish validation proof'];

class Miss extends Error {}
export class CheckoutError extends Error {}
function check(value, reason) {
    if (!value) throw new Miss(reason);
}
function integer(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function inputId(value) {
    return /^[1-9]\d*$/.test(String(value)) && integer(Number(value));
}
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function fingerprint(value) {
    return hash(JSON.stringify(stable(value)));
}
function miss(error, fallback) {
    if (error instanceof CheckoutError) throw error;
    return error instanceof Miss ? error.message : fallback;
}
function recent(value, now) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= MAX_AGE;
}
export function artifactName(runId) {
    return `${POLICY}-${runId}-1`;
}

export function contextFrom(env, event) {
    return {
        repository: env.GITHUB_REPOSITORY,
        repositoryId: Number(env.GITHUB_REPOSITORY_ID),
        runId: Number(env.GITHUB_RUN_ID),
        attempt: Number(env.GITHUB_RUN_ATTEMPT),
        eventName: env.GITHUB_EVENT_NAME,
        eventSha: env.GITHUB_SHA,
        ref: env.GITHUB_REF,
        workflowSha: env.GITHUB_WORKFLOW_SHA,
        workflowRef: env.GITHUB_WORKFLOW_REF,
        server: env.GITHUB_SERVER_URL,
        event,
    };
}

function eligible(context, eventName) {
    const c = context;
    check(c.eventName === eventName, 'event-ineligible');
    check(c.attempt === 1, 'rerun');
    check(/^[\w.-]+\/[\w.-]+$/.test(c.repository) && integer(c.repositoryId)
        && integer(c.runId) && c.server === 'https://github.com', 'repository-ineligible');
    check(c.event.repository?.id === c.repositoryId
        && c.event.repository?.full_name === c.repository, 'repository-ineligible');
    check(SHA.test(c.eventSha) && c.workflowSha === c.eventSha
        && c.workflowRef === `${c.repository}/${WORKFLOW}@${c.ref}`, 'workflow-ineligible');
    if (eventName === 'push') {
        check(c.ref?.startsWith('refs/heads/') && c.ref !== 'refs/heads/main'
            && c.ref !== `refs/heads/${c.event.repository.default_branch}`
            && c.event.deleted === false && c.event.after === c.eventSha, 'production-or-nonbranch');
        return { sha: c.eventSha, branch: c.ref.slice('refs/heads/'.length) };
    }
    const pr = c.event.pull_request;
    check(['opened', 'synchronize', 'reopened'].includes(c.event.action)
        && /^refs\/pull\/[1-9]\d*\/merge$/.test(c.ref), 'pr-ineligible');
    check(pr?.head?.repo?.id === c.repositoryId
        && pr?.head?.repo?.full_name === c.repository
        && pr?.base?.repo?.id === c.repositoryId, 'fork');
    check(SHA.test(pr.head.sha) && typeof pr.head.ref === 'string' && pr.base.ref === 'main', 'pr-ineligible');
    return { sha: pr.head.sha, branch: pr.head.ref };
}

export class Git {
    constructor(cwd = process.cwd()) { this.cwd = cwd; }
    run(...args) {
        return execFileSync('git', args, {
            cwd: this.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20_000, maxBuffer: 1024 * 1024,
        }).trim();
    }
    assertCheckout(sha) {
        try {
            if (!SHA.test(sha) || this.run('rev-parse', '--verify', 'HEAD') !== sha
                || this.run('rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD')
                throw new Error();
            this.run('cat-file', '-e', `${sha}^{commit}`);
            this.run('diff', '--quiet', 'HEAD', '--');
        } catch {
            throw new CheckoutError('checkout-unavailable-or-mismatched');
        }
    }
    source(sha, repository) {
        try {
            check(SHA.test(sha), 'source-objects-unavailable');
            check(this.run('remote', 'get-url', 'origin') === `https://github.com/${repository}`, 'checkout-origin');
            try { this.run('cat-file', '-e', `${sha}^{commit}`); }
            catch { this.run('fetch', '--no-tags', '--depth=1', 'origin', sha); }
            return this.identity(sha);
        } catch (error) { throw new Miss(miss(error, 'source-objects-unavailable')); }
    }
    identity(sha) {
        return {
            checkoutSha: sha,
            checkoutTree: this.run('rev-parse', '--verify', `${sha}^{tree}`),
            workflowBlob: this.run('rev-parse', '--verify', `${sha}:${WORKFLOW}`),
            helperBlob: this.run('rev-parse', '--verify', `${sha}:${HELPER}`),
        };
    }
}

function equalTree(context, git, eventGit = git) {
    const head = eligible(context, 'pull_request');
    const source = git.source(head.sha, context.repository);
    eventGit.assertCheckout(context.eventSha);
    check(eventGit.identity(context.eventSha).checkoutTree === source.checkoutTree, 'different-tree');
    return { ...head, ...source };
}
export function selectCheckout(context, git, sourceId) {
    git.assertCheckout(context.eventSha);
    const fallback = { sha: context.eventSha, reason: 'event-checkout' };
    try {
        check(inputId(sourceId) && Number(sourceId) !== context.runId, 'no-planned-source');
        const head = equalTree(context, git);
        return { sha: head.sha, reason: 'identical-tree-head' };
    } catch (error) {
        return { ...fallback, reason: miss(error, 'source-objects-unavailable') };
    }
}

export function githubApi(endpoint, binary = false, execute = execFileSync) {
    try {
        const output = execute('gh', [
            'api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint,
        ], {
            encoding: binary ? undefined : 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20_000, maxBuffer: binary ? MAX_ZIP : 2 * 1024 * 1024,
        });
        return binary ? output : JSON.parse(output);
    } catch { throw new Miss('api-unavailable'); }
}
function apiFor(api, context) {
    return async (path, binary = false) => {
        try { return await api(`repos/${context.repository}/actions/${path}`, binary); }
        catch { throw new Miss('api-unavailable'); }
    };
}
async function workflowId(api) {
    const workflow = await api('workflows/azure-deploy.yml');
    check(integer(workflow.id) && workflow.path === WORKFLOW && workflow.state === 'active', 'workflow-identity');
    return workflow.id;
}
function sourceRun(run, c, head, expectedWorkflow, sourceId, now) {
    check(run.id === Number(sourceId) && run.id !== c.runId && run.run_attempt === 1, 'source-attempt');
    check(run.event === 'push' && run.head_sha === head.sha && run.head_branch === head.branch
        && run.head_branch !== 'main' && run.head_branch !== c.event.repository.default_branch, 'source-event');
    check(run.repository?.id === c.repositoryId && run.repository?.full_name === c.repository
        && run.head_repository?.id === c.repositoryId
        && run.head_repository?.full_name === c.repository, 'source-repository');
    check(run.workflow_id === expectedWorkflow && run.path === WORKFLOW, 'source-workflow');
    check(recent(run.created_at, now), 'source-stale');
    check(['queued', 'in_progress', 'completed'].includes(run.status)
        && (run.status === 'completed' ? run.conclusion === 'success' : run.conclusion === null), 'source-run-unsuccessful');
}
async function sourceJob(api, run) {
    const response = await api(`runs/${run.id}/attempts/1/jobs?per_page=100`);
    check(Array.isArray(response.jobs) && response.total_count === response.jobs.length
        && response.jobs.length <= 100, 'source-jobs-incomplete');
    const jobs = response.jobs.filter(job => job.name === 'Build Application');
    check(jobs.length === 1, 'source-build-missing');
    const job = jobs[0];
    check(integer(job.id) && job.run_id === run.id && job.run_attempt === 1
        && job.head_sha === run.head_sha, 'source-job-identity');
    return job;
}
function successfulBuild(job) {
    check(job.status === 'completed' && job.conclusion === 'success', 'source-build-not-successful');
    check(Array.isArray(job.steps), 'source-steps-incomplete');
    let previous = 0;
    for (const name of PROOF_STEPS) {
        const matches = job.steps.filter(step => step.name === name);
        check(matches.length === 1 && matches[0].status === 'completed'
            && matches[0].conclusion === 'success' && integer(matches[0].number)
            && matches[0].number > previous, 'source-step-not-successful');
        previous = matches[0].number;
    }
}
function artifactMetadata(artifact, c, run, now) {
    check(integer(artifact.id) && artifact.name === artifactName(run.id)
        && artifact.expired === false, 'proof-unavailable');
    check(artifact.workflow_run?.id === run.id
        && artifact.workflow_run?.repository_id === c.repositoryId
        && artifact.workflow_run?.head_repository_id === c.repositoryId
        && artifact.workflow_run?.head_sha === run.head_sha
        && artifact.workflow_run?.head_branch === run.head_branch, 'artifact-owner');
    check(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0
        && artifact.size_in_bytes <= MAX_ZIP
        && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), 'artifact-digest-or-size');
    check(recent(artifact.created_at, now) && Date.parse(artifact.expires_at) > now
        && Date.parse(artifact.created_at) >= Date.parse(run.created_at)
        && Date.parse(artifact.expires_at) - Date.parse(artifact.created_at) <= MAX_AGE + 60_000, 'artifact-stale');
}
async function findArtifact(api, c, run, now) {
    const response = await api(`runs/${run.id}/artifacts?per_page=100`);
    check(Array.isArray(response.artifacts) && response.total_count === response.artifacts.length
        && response.artifacts.length <= 100, 'artifact-list-incomplete');
    const artifacts = response.artifacts.filter(item => item.name === artifactName(run.id));
    check(artifacts.length === 1, 'proof-unavailable');
    artifactMetadata(artifacts[0], c, run, now);
    return artifacts[0];
}

export async function plan({ context: c, git, api = githubApi, now = Date.now() }) {
    git.assertCheckout(c.eventSha);
    const fallback = { group: `${POLICY}-full-${c.runId}-${c.attempt}`, source_id: '', reason: 'no-source' };
    try {
        const head = equalTree(c, git);
        const request = apiFor(api, c);
        const workflow = await workflowId(request);
        const response = await request(`workflows/azure-deploy.yml/runs?event=push&head_sha=${head.sha}&per_page=20`);
        check(Array.isArray(response.workflow_runs) && response.total_count === response.workflow_runs.length
            && response.workflow_runs.length <= 20, 'source-list-incomplete');
        const candidate = response.workflow_runs.find(run => run.head_sha === head.sha && run.head_branch === head.branch);
        check(candidate && integer(candidate.id), 'no-source');
        const run = await request(`runs/${candidate.id}`);
        sourceRun(run, c, head, workflow, candidate.id, now);
        const job = await sourceJob(request, run);
        let reason;
        if (job.status === 'in_progress' && job.conclusion === null && recent(job.started_at, now)) {
            reason = 'source-running';
        } else {
            check(job.status === 'completed', 'source-not-running');
            successfulBuild(job);
            await findArtifact(request, c, run, now);
            reason = 'source-proof-ready';
        }
        return { group: `${POLICY}-${c.repositoryId}-${head.sha}`, source_id: String(run.id), reason };
    } catch (error) {
        return { ...fallback, reason: miss(error, 'plan-unavailable') };
    }
}

// Every validation subprocess gets this environment, not the event/ref, token,
// deployment settings, or arbitrary inherited application configuration.
export function validationEnvironment(env, cwd) {
    const work = join(cwd, '.validation-work');
    return {
        PATH: env.PATH,
        HOME: env.HOME,
        ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
        ...(env.DOTNET_ROOT ? { DOTNET_ROOT: env.DOTNET_ROOT } : {}),
        CI: 'true',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        BROWSER_SMOKE_NO_BUILD: '1',
        TEMP: work,
        TMP: work,
        TMPDIR: work,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
    };
}
function prepareEnvironment(env, cwd) {
    const clean = validationEnvironment(env, cwd);
    mkdirSync(clean.TMPDIR, { recursive: true });
    writeFileSync(clean.GIT_CONFIG_GLOBAL, '');
    return clean;
}
export async function effectiveInputs(env, cwd, execute = execFileSync) {
    check(env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux'
        && env.RUNNER_ARCH === 'X64' && /^ubuntu\d+$/.test(env.ImageOS)
        && /^\d{8}\.\d+\.\d+$/.test(env.ImageVersion), 'runner-inputs-unknown');
    const clean = prepareEnvironment(env, cwd);
    check(clean.PATH && clean.HOME && clean.DOTNET_ROOT && !Object.hasOwn(clean, 'BROWSER_SMOKE_BASE_URL'), 'inputs-unknown');
    const command = (file, args) => {
        let value;
        try {
            value = execute(file, args, {
                cwd, env: clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
            }).trim();
        } catch { throw new Miss('tool-inputs-unavailable'); }
        check(value.length > 0, 'tool-inputs-unknown');
        return value;
    };
    const files = [
        'AstervoidsWeb/obj/project.assets.json',
        'AstervoidsWeb.Tests/obj/project.assets.json',
        'node_modules/.package-lock.json',
        'node_modules/playwright-core/browsers.json',
    ];
    const inputs = {
        environment: clean,
        image: [env.ImageOS, env.ImageVersion, env.RUNNER_OS, env.RUNNER_ARCH],
        hardware: [release(), totalmem(), cpus().map(cpu => cpu.model)],
        node: process.versions,
        dotnet: command('dotnet', ['--info']),
        npm: command('npm', ['--version']),
        git: command('git', ['--version']),
        bash: command('bash', ['--version']),
        azure: JSON.parse(command('az', ['version', '--output', 'json'])),
        bicep: command('az', ['bicep', 'version']),
        packages: command('dpkg-query', ['-W', '-f=${binary:Package}=${Version}\n']),
        browser: command('node', ['--input-type=module', '-e',
            "import { chromium } from 'playwright'; import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; const b = await chromium.launchServer(); try { console.log(createHash('sha256').update(readFileSync(b.process().spawnfile)).digest('hex')); } finally { await b.close(); }"]),
        dependencies: Object.fromEntries(files.map(file => [file, hash(readFileSync(join(cwd, file)))])),
    };
    check(/Version:\s+\d+\.\d+\.\d+/.test(inputs.dotnet)
        && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(inputs.npm)
        && /^git version \d+\.\d+\.\d+/.test(inputs.git)
        && /^GNU bash.*\d+\.\d+/.test(inputs.bash)
        && /^\d+\.\d+\.\d+$/.test(inputs.azure?.['azure-cli'])
        && /^Bicep CLI version \d+\.\d+\.\d+/.test(inputs.bicep)
        && inputs.packages.split('\n').every(line => /^[a-z0-9][a-z0-9+.:_-]*=\S+$/.test(line)),
    'tool-inputs-unknown');
    check(inputs.hardware[0] && inputs.hardware[1] > 0 && inputs.hardware[2].length > 0
        && inputs.hardware[2].every(model => typeof model === 'string' && model.length > 0), 'runner-inputs-unknown');
    check(DIGEST.test(inputs.browser), 'browser-inputs-unknown');
    return fingerprint(inputs);
}
export async function capture({ context: c, git, eventGit = git, env, cwd, probe = effectiveInputs }) {
    const sha = env.VALIDATION_SHA;
    git.assertCheckout(sha);
    try {
        if (c.eventName === 'pull_request') {
            const head = equalTree(c, git, eventGit);
            check(sha === head.sha, 'event-checkout-full');
        } else {
            eligible(c, 'push');
            check(sha === c.eventSha, 'checkout-ineligible');
        }
        const identity = git.source(sha, c.repository);
        const value = await probe(env, cwd);
        check(DIGEST.test(value), 'inputs-unknown');
        return { eligible: 'true', fingerprint: value, ...identity, reason: 'inputs-captured' };
    } catch (error) {
        return { eligible: 'false', reason: miss(error, 'inputs-unavailable') };
    }
}

export async function readProofArchive(bytes) {
    check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ZIP, 'artifact-digest-or-size');
    const { yauzl } = require('playwright-core/lib/utilsBundle');
    return new Promise((resolveProof, reject) => {
        const fail = () => reject(new Miss('artifact-invalid'));
        yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
            if (error) return fail();
            if (zip.entryCount !== 1) { zip.close(); return fail(); }
            zip.on('error', fail);
            zip.on('entry', entry => {
                if (entry.fileName !== 'proof.json' || entry.isEncrypted()
                    || ![0, 8].includes(entry.compressionMethod)
                    || entry.uncompressedSize > MAX_PROOF || entry.uncompressedSize === 0) {
                    zip.close();
                    return fail();
                }
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError) { zip.close(); return fail(); }
                    const chunks = [];
                    let length = 0;
                    stream.on('error', fail);
                    stream.on('data', chunk => {
                        length += chunk.length;
                        if (length > MAX_PROOF) { stream.destroy(); zip.close(); fail(); }
                        else chunks.push(chunk);
                    });
                    stream.on('end', () => {
                        zip.close();
                        try {
                            check(length === entry.uncompressedSize, 'artifact-invalid');
                            resolveProof(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                        } catch { fail(); }
                    });
                });
            });
            zip.readEntry();
        });
    });
}

function proofFields(c, identity, workflow, inputFingerprint, runId) {
    return {
        policy: POLICY, mode: 'full', repository: c.repository, repositoryId: c.repositoryId,
        workflowId: workflow, workflowPath: WORKFLOW, workflowSha: identity.checkoutSha,
        ...identity, fingerprint: inputFingerprint, runId, runAttempt: 1,
    };
}
export function makeProof({ context: c, git, inputs, workflow, steps, now = Date.now() }) {
    eligible(c, 'push');
    git.assertCheckout(c.eventSha);
    check(inputs.eligible === 'true' && DIGEST.test(inputs.fingerprint) && integer(workflow), 'inputs-unavailable');
    const identity = git.source(c.eventSha, c.repository);
    check(Object.entries(identity).every(([key, value]) => inputs[key] === value), 'checkout-ineligible');
    for (const id of Object.keys(VALIDATION_STEPS))
        check(steps[id]?.outcome === 'success' && steps[id]?.conclusion === 'success', 'validation-not-full');
    check(steps.reuse.outputs?.hit === 'false', 'validation-not-full');
    return { ...proofFields(c, identity, workflow, inputs.fingerprint, c.runId), createdAt: new Date(now).toISOString() };
}

export async function verify({ context: c, git, eventGit = git, sourceId, inputs, api = githubApi, now, clock = Date.now }) {
    const fallback = { hit: 'false', reason: 'no-planned-source' };
    try {
        check(inputId(sourceId) && Number(sourceId) !== c.runId, 'no-planned-source');
        const head = equalTree(c, git, eventGit);
        git.assertCheckout(head.sha);
        check(inputs.eligible === 'true' && DIGEST.test(inputs.fingerprint), 'inputs-unavailable');
        const identity = git.source(head.sha, c.repository);
        check(Object.entries(identity).every(([key, value]) => inputs[key] === value), 'inputs-checkout-mismatch');
        const request = apiFor(api, c);
        const workflow = await workflowId(request);
        const run = await request(`runs/${sourceId}`);
        sourceRun(run, c, head, workflow, sourceId, now ?? clock());
        const job = await sourceJob(request, run);
        successfulBuild(job);
        const artifact = await findArtifact(request, c, run, now ?? clock());
        const bytes = await request(`artifacts/${artifact.id}/zip`, true);
        check(Buffer.isBuffer(bytes) && bytes.length === artifact.size_in_bytes
            && `sha256:${hash(bytes)}` === artifact.digest, 'artifact-digest-mismatch');
        const proof = await readProofArchive(bytes);
        const expected = proofFields(c, identity, workflow, inputs.fingerprint, run.id);
        check(proof && typeof proof === 'object' && !Array.isArray(proof)
            && Object.keys(proof).sort().join() === [...Object.keys(expected), 'createdAt'].sort().join(), 'proof-schema');
        check(Object.entries(expected).every(([key, value]) => proof[key] === value), 'proof-inputs-or-provenance');
        check(recent(proof.createdAt, now ?? clock()) && Date.parse(proof.createdAt) >= Date.parse(job.started_at)
            && Date.parse(proof.createdAt) <= Date.parse(job.completed_at), 'proof-stale');
        // A deployment may still be running. Only the attempt-specific Build
        // must be terminal, and a rerun/deletion between reads invalidates reuse.
        const finalJob = await sourceJob(request, run);
        successfulBuild(finalJob);
        check(finalJob.id === job.id, 'source-job-changed');
        const finalArtifact = await request(`artifacts/${artifact.id}`);
        artifactMetadata(finalArtifact, c, run, now ?? clock());
        check(fingerprint(finalArtifact) === fingerprint(artifact), 'artifact-changed');
        const finalRun = await request(`runs/${sourceId}`);
        const finalNow = now ?? clock();
        sourceRun(finalRun, c, head, workflow, sourceId, finalNow);
        artifactMetadata(finalArtifact, c, finalRun, finalNow);
        check(recent(proof.createdAt, finalNow), 'proof-stale');
        return { hit: 'true', reason: 'verified-push-proof', source_id: String(run.id), artifact_id: String(artifact.id) };
    } catch (error) {
        return { ...fallback, reason: miss(error, 'verification-unavailable') };
    }
}

function report(phase, result, env) {
    const identity = `${inputId(result.source_id) ? ` Source run: ${result.source_id}.` : ''}`
        + `${inputId(result.artifact_id) ? ` Artifact: ${result.artifact_id}.` : ''}`;
    console.log(`validation-reuse ${phase}: ${result.reason}.${identity}`);
    if (env.GITHUB_OUTPUT) {
        const allowed = ['group', 'source_id', 'sha', 'eligible', 'hit', 'publish', 'reason', 'artifact_id'];
        for (const key of allowed)
            if (result[key] !== undefined) appendFileSync(env.GITHUB_OUTPUT, `${key}=${result[key]}\n`);
    }
    if (env.GITHUB_STEP_SUMMARY)
        appendFileSync(env.GITHUB_STEP_SUMMARY, `Validation reuse ${phase}: \`${result.reason}\`.${identity}\n`);
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    const env = process.env;
    const cwd = process.cwd();
    if (command === 'exec') {
        if (args.shift() !== '--' || args.length === 0) throw new Error();
        const child = spawnSync(args[0], args.slice(1), { cwd, env: prepareEnvironment(env, cwd), stdio: 'inherit' });
        process.exit(child.status ?? 1);
    }
    const c = contextFrom(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')));
    const git = new Git(cwd);
    const eventGit = new Git(join(cwd, '..', 'event'));
    const inputPath = join(cwd, '.validation-work', 'inputs.json');
    let result;
    if (command === 'plan') result = await plan({ context: c, git });
    else if (command === 'select') result = selectCheckout(c, git, env.VALIDATION_SOURCE_ID);
    else if (command === 'checkout') {
        git.assertCheckout(env.VALIDATION_SHA);
        result = { reason: 'checkout-verified' };
    } else if (command === 'capture') {
        result = await capture({ context: c, git, eventGit, env, cwd });
        mkdirSync(join(cwd, '.validation-work'), { recursive: true });
        writeFileSync(inputPath, JSON.stringify(result));
    } else if (command === 'verify' || command === 'publish') {
        try {
            const inputs = JSON.parse(readFileSync(inputPath, 'utf8'));
            if (command === 'verify') {
                result = await verify({ context: c, git, eventGit, inputs, sourceId: env.VALIDATION_SOURCE_ID });
            } else {
                const proof = makeProof({
                    context: c, git, inputs,
                    workflow: await workflowId(apiFor(githubApi, c)),
                    steps: JSON.parse(env.VALIDATION_STEPS),
                });
                const directory = join(cwd, 'test-results', 'validation-proof');
                mkdirSync(directory, { recursive: true });
                writeFileSync(join(directory, 'proof.json'), JSON.stringify(proof));
                result = { publish: 'true', reason: 'full-push-proof-written' };
            }
        } catch (error) {
            result = { hit: 'false', publish: 'false', reason: miss(error, 'proof-unavailable') };
        }
    } else throw new Error();
    report(command, result, env);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`validation-reuse fatal: ${error instanceof CheckoutError ? error.message : 'orchestration-failed'}`);
        process.exitCode = 1;
    });
}
