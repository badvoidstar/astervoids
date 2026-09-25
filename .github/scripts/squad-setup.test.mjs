import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const { parseRoster, parseRoutingRules, triageIssue, isUntriagedIssue } =
  require(join(root, '.squad', 'templates', 'ralph-triage.js'));
const team = read('.squad/team.md');
const routing = read('.squad/routing.md');
const registry = JSON.parse(read('.squad/casting/registry.json')).agents;
const workflowNames = [
  'squad-heartbeat.yml',
  'squad-issue-assign.yml',
  'squad-triage.yml',
  'sync-squad-labels.yml',
];
const workflows = new Map(workflowNames.map((name) => [name, read(`.github/workflows/${name}`)]));

function tableRows(markdown, heading) {
  const section = markdown.split(`## ${heading}\n`)[1]?.split(/\n## /)[0];
  assert.ok(section, `Missing ${heading} table`);
  return section.split('\n').filter((line) => line.startsWith('|')).slice(2)
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

const members = tableRows(team, 'Members').map(([name, role, charter]) => ({ name, role, charter }));
const routes = tableRows(routing, 'Routing Table');
const memberSlug = (name) => Object.keys(registry).find((slug) => registry[slug].persistent_name === name);

// Extract the literal JS blocks, not YAML semantics. Every github-script step must have one.
function scriptBlocks(workflow) {
  const source = workflows.get(workflow);
  const lines = source.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^( +)script: \|\s*$/);
    if (!match) continue;
    const indent = match[1].length + 2;
    const body = [];
    const line = i + 2;
    while (i + 1 < lines.length &&
      (!lines[i + 1].trim() || lines[i + 1].startsWith(' '.repeat(indent)))) {
      body.push(lines[++i].slice(indent));
    }
    blocks.push(new Script(`(async () => {\n${body.join('\n')}\n})()`, {
      filename: `${workflow}:${line}`,
    }));
  }
  assert.equal(blocks.length, [...source.matchAll(/uses: actions\/github-script@/g)].length);
  assert.ok(blocks.length > 0, `${workflow} has no script blocks`);
  return blocks;
}

const scripts = new Map(workflowNames.map((name) => [name, scriptBlocks(name)]));
const repo = { owner: 'fixture-owner', repo: 'fixture-repo' };
const issue = { number: 42, title: 'Unclassified work', body: '', assignees: [] };
const defaultFiles = { '.squad/team.md': team, '.squad/routing.md': routing };

async function run(workflow, index, {
  files = defaultFiles, handlers = {}, title = issue.title, label = 'squad',
} = {}) {
  const calls = [];
  const warnings = [];
  const infos = [];
  const unexpected = [];
  function api(path = []) {
    return new Proxy(() => {}, {
      get: (_, key) => api([...path, key]),
      apply: (_, _this, args) => {
        const method = path.join('.');
        calls.push({ method, args });
        if (!Object.hasOwn(handlers, method)) {
          unexpected.push(method);
          throw new Error(`Unexpected GitHub operation: ${method}`);
        }
        return handlers[method](...args);
      },
    });
  }
  const sandbox = {
    github: api(),
    context: { repo, payload: { issue: { ...issue, title }, label: { name: label } } },
    core: { warning: (message) => warnings.push(message), info: (message) => infos.push(message) },
    require: (name) => {
      assert.equal(name, 'fs', 'Workflow scripts may only load the read-only filesystem mock');
      return {
        existsSync: (path) => Object.hasOwn(files, path),
        readFileSync: (path, encoding) => {
          assert.equal(encoding, 'utf8');
          assert.ok(Object.hasOwn(files, path), `Unexpected file read: ${path}`);
          return files[path];
        },
      };
    },
  };
  try {
    await scripts.get(workflow)[index].runInNewContext(sandbox, { timeout: 1000 });
  } finally {
    assert.deepEqual(unexpected, [], 'Even caught unexpected API calls must fail the test');
  }
  return { calls, warnings, infos };
}

const issueHandlers = {
  'rest.issues.addLabels': async () => ({}),
  'rest.issues.createComment': async () => ({}),
};
const comments = (result) => result.calls.filter((call) => call.method === 'rest.issues.createComment')
  .map((call) => call.args[0].body);
const labels = (result) => result.calls.filter((call) => call.method === 'rest.issues.addLabels')
  .flatMap((call) => Array.from(call.args[0].labels));

test('all versioned setup JSON parses, including portable MCP configuration', () => {
  const paths = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    '.squad', '.copilot', '.mcp.json', '.vscode/settings.json',
  ], { cwd: root, encoding: 'utf8' }).split('\0').filter((path) => /\.json(?:l|\.example)?$/.test(path));
  assert.ok(paths.includes('.mcp.json'));
  assert.ok(paths.includes('.copilot/mcp-config.json'));
  for (const path of paths) {
    const documents = path.endsWith('.jsonl') ? read(path).split('\n').filter((line) => line.trim()) : [read(path)];
    for (const document of documents) {
      assert.doesNotThrow(() => JSON.parse(document), `Invalid setup JSON: ${path}`);
    }
  }
  const config = JSON.parse(read('.mcp.json'));
  assert.equal(config.mcpServers.squad_state.command, 'squad');
  assert.ok(Array.isArray(config.mcpServers.squad_state.args));
});

test('roster, registry and case-sensitive charter paths describe the same team', () => {
  const directories = readdirSync(join(root, '.squad', 'agents'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.equal(members.length, Object.keys(registry).length);
  assert.equal(new Set(members.map((member) => member.name)).size, members.length);
  assert.deepEqual(directories.map((name) => name.toLowerCase()).sort(), Object.keys(registry).sort());
  for (const member of members) {
    const slug = memberSlug(member.name);
    assert.ok(slug, `Missing registry member: ${member.name}`);
    assert.equal(registry[slug].status, 'active');
    const parts = member.charter.split('/');
    assert.deepEqual(parts.slice(0, 2), ['.squad', 'agents']);
    assert.ok(directories.includes(parts[2]), `Charter directory case mismatch: ${member.charter}`);
    assert.equal(parts[2].toLowerCase(), slug);
    assert.equal(parts[3], 'charter.md');
    const heading = read(member.charter).split('\n')[0].split(' \u2014 ')[0];
    assert.equal(heading, `# ${member.name}`);
  }
  assert.deepEqual(parseRoster(team), members.filter(({ name }) => !['Scribe', 'Ralph'].includes(name))
    .map(({ name, role }) => ({ name, role, label: `squad:${memberSlug(name)}` })));
});

test('Ralph parses every configured Routing Table row', () => {
  const rules = parseRoutingRules(routing);
  assert.equal(rules.length, routes.length);
  assert.ok(rules.length > 0);
  assert.deepEqual(rules.map((rule) => [rule.workType, rule.agentName]),
    routes.map(([workType, name]) => [workType, name]));
});

test('conversational aliases stay separate from Ralph issue-routing rules', () => {
  const aliases = tableRows(routing, 'Friendly-Name Resolution')
    .map(([alias, name]) => [alias, name]);
  const expected = tableRows(team, 'Members').filter((row) => row[4])
    .map(([name, , , , alias]) => [alias, name]);
  assert.deepEqual(aliases, expected);
  assert.equal(new Set(aliases.map(([alias]) => alias.toLowerCase())).size, aliases.length);
  assert.equal(aliases.find(([alias]) => alias === 'Morgan')?.[1], 'Scribe');

  const assignableMembers = new Set(parseRoster(team).map(({ name }) => name));
  assert.equal(assignableMembers.has('Scribe'), false);
  for (const rule of parseRoutingRules(routing)) {
    assert.doesNotMatch(rule.workType, /^Addressed to /i);
    assert.ok(assignableMembers.has(rule.agentName), `Unassignable issue route: ${rule.agentName}`);
  }
});

test('configured examples route to their actual members, including Fact Checker', () => {
  for (const [, name, examples] of routes) {
    const title = examples.split(',')[0].replaceAll('`', '');
    const decision = triageIssue({ title, body: '' }, parseRoutingRules(routing), [], parseRoster(team));
    assert.equal(decision?.source, 'routing-rule', title);
    assert.equal(decision.agent.name, name, title);
    assert.equal(decision.agent.label, `squad:${memberSlug(name)}`);
  }
});

test('Ralph still accepts both legacy routing headings and CRLF', () => {
  for (const heading of ['Work Type -> Agent', 'Work Type \u2192 Agent']) {
    const content = routing.replace('## Routing Table', `## ${heading}`).replaceAll('\n', '\r\n');
    const rules = parseRoutingRules(content);
    assert.deepEqual(rules.map((rule) => rule.agentName), routes.map(([, name]) => name));
  }
});

test('Ralph skips pull requests and issues already labeled for a roster member', () => {
  const memberLabels = parseRoster(team).map((member) => member.label);
  assert.equal(isUntriagedIssue({ labels: ['squad'] }, memberLabels), true);
  assert.equal(isUntriagedIssue({ labels: [] }, memberLabels), false);
  assert.equal(isUntriagedIssue({ labels: ['squad'], pull_request: {} }, memberLabels), false);
  for (const name of memberLabels) {
    assert.equal(isUntriagedIssue({ labels: ['squad', name] }, memberLabels), false);
    assert.equal(isUntriagedIssue({ labels: [{ name: 'SQUAD' }, { name: name.toUpperCase() }] },
      memberLabels), false);
  }
});

test('active automation uses pinned actions, literal scripts and matching installed templates', () => {
  for (const [name, source] of workflows) {
    const actions = [...source.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((match) => match[1]);
    assert.ok(actions.length > 0);
    for (const action of actions) {
      assert.match(action, /^actions\/(?:checkout|github-script)@[0-9a-f]{40}(?:\s+#.*)?$/);
    }
    assert.doesNotMatch(source, /pull_request_target:|write-all/);
    assert.equal(source, read(`.squad/templates/workflows/${name}`));
    assert.doesNotMatch(source.split('script: |').slice(1).map((part) => part.split(/\n {0,10}\S/)[0])
      .join('\n'), /\$\{\{/, 'Do not interpolate event data into executable JavaScript');
  }
});

test('optional assignment tokens fall back to the workflow token before scripts run', () => {
  for (const source of workflows.values()) {
    for (const [, token] of source.matchAll(/github-token: (.+)/g)) {
      assert.match(token, /^\$\{\{ secrets\.COPILOT_ASSIGN_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}$/);
    }
  }
});

test('workflow scripts make no GitHub calls when required local inputs are missing', async () => {
  for (const name of workflowNames) {
    for (let index = 0; index < scripts.get(name).length; index++) {
      const result = await run(name, index, { files: {} });
      assert.equal(result.calls.length, 0, `${name} script ${index}`);
    }
  }
});

test('label sync creates missing labels and idempotently updates existing labels', async () => {
  const writes = [];
  const first = await run('sync-squad-labels.yml', 0, {
    handlers: {
      'rest.issues.getLabel': async ({ name }) => {
        if (name === 'squad') return {};
        throw Object.assign(new Error('Not found'), { status: 404 });
      },
      'rest.issues.createLabel': async (args) => writes.push(args),
      'rest.issues.updateLabel': async (args) => writes.push(args),
    },
  });
  assert.equal(first.warnings.length, 0);
  assert.equal(new Set(writes.map(({ name }) => name)).size, writes.length);
  const expected = ['squad', 'squad:copilot', ...members.filter(({ name }) => name !== 'Scribe')
    .map(({ name }) => `squad:${memberSlug(name)}`)];
  assert.deepEqual(writes.filter(({ name }) => name === 'squad' || name.startsWith('squad:'))
    .map(({ name }) => name).sort(), expected.sort());
  for (const write of writes) {
    assert.equal(write.owner, repo.owner);
    assert.equal(write.repo, repo.repo);
    assert.match(write.color, /^[0-9a-f]{6}$/i);
  }
  const updates = [];
  await run('sync-squad-labels.yml', 0, {
    handlers: {
      'rest.issues.getLabel': async () => ({}),
      'rest.issues.updateLabel': async (args) => updates.push(args),
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), JSON.parse(JSON.stringify(writes)));
});

test('label sync surfaces API failures instead of creating labels after a non-404', async () => {
  await assert.rejects(run('sync-squad-labels.yml', 0, {
    handlers: {
      'rest.issues.getLabel': async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      },
    },
  }), /Forbidden/);
});

test('issue assignment resolves every member slug, including squad:fact-checker', async () => {
  for (const { name, role } of members) {
    const result = await run('squad-issue-assign.yml', 0, {
      label: `squad:${memberSlug(name)}`,
      handlers: { 'rest.issues.createComment': async () => ({}) },
    });
    assert.equal(result.warnings.length, 0, name);
    assert.equal(comments(result).length, 1);
    assert.ok(comments(result)[0].includes(`Assigned to ${name} (${role})`), name);
  }
});

test('unknown member labels produce a warning, not an assignment', async () => {
  const result = await run('squad-issue-assign.yml', 0, {
    label: 'squad:nonexistent',
    handlers: { 'rest.issues.createComment': async () => ({}) },
  });
  assert.equal(result.warnings.length, 1);
  assert.match(comments(result)[0], /No squad member found/);
});

test('triage treats issue text as data and falls back to the real Lead', async () => {
  for (const [title, expectedLabel] of [
    ["API endpoint'; throw new Error('issue text must stay data'); //", 'squad:backend'],
    ['Unclassified work', 'squad:lead'],
  ]) {
    const result = await run('squad-triage.yml', 0, { title, handlers: issueHandlers });
    assert.deepEqual(labels(result).filter((label) => label.startsWith('squad:')), [expectedLabel]);
    assert.ok(comments(result)[0].includes(title));
    assert.ok(comments(result)[0].includes('squad:fact-checker'));
    for (const { args: [args] } of result.calls) {
      assert.equal(args.owner, repo.owner);
      assert.equal(args.repo, repo.repo);
      assert.equal(args.issue_number, issue.number);
    }
  }
});

test('heartbeat applies a real routing decision using only labels and a comment', async () => {
  const decision = triageIssue({ title: 'Evidence checks' }, parseRoutingRules(routing), [], parseRoster(team));
  const result = await run('squad-heartbeat.yml', 0, {
    files: { 'triage-results.json': JSON.stringify([{
      issueNumber: issue.number, assignTo: decision.agent.name, label: decision.agent.label,
      reason: decision.reason, source: decision.source,
    }]) },
    handlers: issueHandlers,
  });
  assert.deepEqual(labels(result), ['squad:fact-checker']);
  assert.ok(comments(result)[0].includes(decision.reason));
  assert.equal(result.warnings.length, 0);
  assert.equal((await run('squad-heartbeat.yml', 0, {
    files: { 'triage-results.json': '[]' },
  })).calls.length, 0);
});

test('disabled Copilot auto-assign prevents both assignment workflows from calling GitHub', async () => {
  assert.ok(team.includes('<!-- copilot-auto-assign: false -->'));
  for (const [name, index] of [['squad-heartbeat.yml', 1], ['squad-issue-assign.yml', 1]]) {
    assert.equal((await run(name, index, { label: 'squad:copilot' })).calls.length, 0, name);
  }
});

test('disabled Copilot assignment is acknowledged without claiming work was started', async () => {
  const result = await run('squad-issue-assign.yml', 0, {
    label: 'squad:copilot',
    handlers: { 'rest.issues.createComment': async () => ({}) },
  });
  assert.match(comments(result)[0], /automatic.*disabled/i);
  assert.doesNotMatch(comments(result)[0], /has been assigned|will pick this up automatically/i);
});

test('triage can recommend Copilot without auto-assigning when disabled', async () => {
  // Exercise the supported inline capability format without changing the installed roster.
  const inlineProfile = team.replace(/^.*Good fit.*$/m, '\u{1f7e2} Good fit: test coverage');
  const result = await run('squad-triage.yml', 0, {
    files: { ...defaultFiles, '.squad/team.md': inlineProfile },
    title: 'Improve test coverage',
    handlers: issueHandlers,
  });
  assert.ok(labels(result).includes('squad:copilot'));
  assert.equal(result.warnings.length, 0);
});

test('opted-in Copilot assignment uses the repository default branch, not a hardcoded branch', async () => {
  const files = { ...defaultFiles, '.squad/team.md': team.replace('auto-assign: false', 'auto-assign: true') };
  for (const [name, index, branch] of [
    ['squad-heartbeat.yml', 1, 'main'],
    ['squad-heartbeat.yml', 1, 'fixture-default'],
    ['squad-issue-assign.yml', 1, 'main'],
    ['squad-issue-assign.yml', 1, 'fixture-default'],
  ]) {
    const assignments = [];
    await run(name, index, {
      files, label: 'squad:copilot',
      handlers: {
        'rest.issues.listForRepo': async () => ({
          data: [issue, { ...issue, number: 43, assignees: [{ login: 'already-assigned' }] }],
        }),
        'rest.repos.get': async () => ({ data: { default_branch: branch } }),
        request: async (...args) => assignments.push(args),
      },
    });
    assert.equal(assignments.length, 1);
    const [endpoint, args] = assignments[0];
    assert.equal(endpoint, 'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees');
    assert.equal(args.owner, repo.owner);
    assert.equal(args.repo, repo.repo);
    assert.equal(args.issue_number, issue.number);
    assert.equal(args.agent_assignment.target_repo, `${repo.owner}/${repo.repo}`);
    assert.equal(args.agent_assignment.base_branch, branch);
    assert.deepEqual(Array.from(args.assignees), ['copilot-swe-agent[bot]']);
  }
});
