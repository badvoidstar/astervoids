import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCleanup } from './cleanup-orphans.mjs';

const subscription = '00000000-0000-0000-0000-000000000000';
const principal = '11111111-1111-1111-1111-111111111111';
const sha = 'a'.repeat(40);
const root = `/subscriptions/${subscription}/resourceGroups/rg-production/providers`;
const endpoint = name => `https://${name}.table.core.windows.net/`;
const environment = 'feature-retired';
const shellCache = new Map();
function shell(args) {
  const key = JSON.stringify(args);
  if (!shellCache.has(key)) {
    const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
    shellCache.set(key, execFileSync(bash, args, { encoding: 'utf8' }));
  }
  return shellCache.get(key);
}
const sanitize = branch => shell([fileURLToPath(new URL('./sanitize-branch-name.sh', import.meta.url)), branch]).trim();
function account(env = environment, name = 'examplebranchstore', kind = 'branch', retention = 'branch-orphan') {
  return {
    id: `${root}/Microsoft.Storage/storageAccounts/${name}`, name,
    type: 'Microsoft.Storage/storageAccounts', resourceGroup: 'rg-production',
    provisioningState: 'Succeeded', creationTime: '2026-01-01T00:00:00Z',
    primaryEndpoints: { table: endpoint(name) },
    tags: {
      'azd-env-name': env, 'astervoids-data': 'player-identity',
      'astervoids-deployment-kind': kind, 'astervoids-retention': retention
    }
  };
}
function app(name = `ca-web-${environment}`, env = environment, store = 'examplebranchstore') {
  return {
    id: `${root}/Microsoft.App/containerApps/${name}`, name,
    type: 'Microsoft.App/containerApps', resourceGroup: 'rg-production',
    tags: { 'azd-env-name': env }, identity: { type: 'SystemAssigned', principalId: principal },
    properties: {
      provisioningState: 'Succeeded', latestRevisionName: `${name}--rev1`,
      configuration: { activeRevisionsMode: 'Single' },
      template: { containers: [{
        name: 'main',
        env: [
          { name: 'Identity__Provider', value: 'AzureTable' },
          { name: 'Identity__TableEndpoint', value: endpoint(store) },
          { name: 'Identity__TableName', value: 'PlayerIdentity' }
        ]
      }] }
    }
  };
}
function revision(deployment) {
  return {
    id: `${deployment.id}/revisions/${deployment.properties.latestRevisionName}`,
    name: deployment.properties.latestRevisionName,
    properties: { active: true, template: deployment.properties.template }
  };
}
const argument = (args, key) => args[args.indexOf(key) + 1];

function fixture({ withApp = true, withStore = true } = {}) {
  const state = {
    branches: ['main'], apps: withApp ? [app()] : [], stores: withStore ? [account()] : [],
    revisions: new Map(), cname: [], txt: [], environments: [], certificates: new Map()
  };
  const calls = [], logs = [], counts = new Map();
  let intercept = () => undefined;
  const run = (command, args) => {
    calls.push([command, ...args]);
    let operation;
    if (command === 'bash') {
      assert.ok(['sanitize-branch-name.sh', 'orphan-safety.sh'].includes(basename(args[0])));
      return shell(args);
    }
    if (command === 'git' && args[0] === 'check-ref-format') {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    if (command === 'git') {
      assert.deepEqual(args, ['ls-remote', '--heads', 'origin']);
      operation = 'branches';
    } else {
      assert.equal(command, 'az', 'no unmocked CLI commands');
      assert.equal(argument(args, '--resource-group'), 'rg-production');
      assert.ok(args.includes('--only-show-errors'));
      assert.ok(!args.includes('--no-wait'));
      operation = args.slice(0, args.indexOf(args.find(value => value.startsWith('--')))).join(' ');
    }
    const count = (counts.get(operation) ?? 0) + 1;
    counts.set(operation, count);
    const intercepted = intercept(operation, count, args, state);
    if (intercepted !== undefined) return intercepted;
    switch (operation) {
      case 'branches': return state.branches.map(branch => `${sha}\trefs/heads/${branch}`).join('\n');
      case 'containerapp list': return JSON.stringify(state.apps);
      case 'storage account list': return JSON.stringify(state.stores);
      case 'containerapp revision list': {
        assert.ok(args.includes('--all'), 'active and latest revisions must not be hidden by CLI filtering');
        const name = argument(args, '--name');
        return JSON.stringify(state.revisions.get(name) ?? [revision(state.apps.find(value => value.name === name))]);
      }
      case 'containerapp delete':
        assert.ok(args.includes('--yes'));
        state.apps = state.apps.filter(value => value.name !== argument(args, '--name'));
        return '';
      case 'storage account delete':
        assert.ok(args.includes('--yes'));
        state.stores = state.stores.filter(value => value.name !== argument(args, '--name'));
        return '';
      case 'network dns record-set cname list': return JSON.stringify(state.cname);
      case 'network dns record-set txt list': return JSON.stringify(state.txt);
      case 'containerapp env list': return JSON.stringify(state.environments);
      case 'containerapp env certificate list':
        return JSON.stringify(state.certificates.get(argument(args, '--name')) ?? []);
      case 'network dns record-set cname delete':
      case 'network dns record-set txt delete':
      case 'containerapp env certificate delete': return '';
      default: assert.fail(`Unexpected mocked CLI operation: ${operation}`);
    }
  };
  const runner = createCleanup({ run, log: line => logs.push(line) });
  return {
    state, calls, logs, runner,
    intercept: fn => { intercept = fn; },
    deletes: () => calls.filter(call => call[0] === 'az' && call.includes('delete'))
  };
}
function noDeletes(f) { assert.deepEqual(f.deletes(), []); }
function failWithoutDeletes(f, pattern = /discovery|inventory|configuration|metadata|endpoint/i) {
  assert.throws(() => f.runner.cleanup(), pattern);
  noDeletes(f);
}

test('deletes a confirmed orphan app first, confirms absence, then retires its store', () => {
  const f = fixture();
  assert.deepEqual(f.runner.cleanup(), { apps: 1, stores: 1, dns: 0 });
  assert.deepEqual(f.deletes().map(call => call.slice(1, 4)), [
    ['containerapp', 'delete', '--name'], ['storage', 'account', 'delete']
  ]);
  const [appDelete, storeDelete] = f.deletes().map(call => f.calls.indexOf(call));
  assert.ok(f.calls.slice(appDelete + 1, storeDelete).some(call => call.slice(0, 3).join(' ') === 'az containerapp list'));
  assert.ok(f.calls.slice(appDelete + 1, storeDelete).some(call => call.slice(0, 2).join(' ') === 'git ls-remote'));
  assert.deepEqual(f.runner.cleanup(), { apps: 0, stores: 0, dns: 0 }, 'reruns are idempotent');
});

for (const retention of ['manual', 'branch-orphan']) {
  test(`independently discovers an older orphan with no app (${retention})`, () => {
    const f = fixture({ withApp: false });
    f.state.stores[0].tags['astervoids-retention'] = retention;
    assert.deepEqual(f.runner.cleanup(), { apps: 0, stores: 1, dns: 0 });
    assert.equal(f.deletes().length, 1);
  });
}

for (const branch of ['feature/retired', 'Feature/Retired', 'feature-retired']) {
  test(`live branch or sanitized collision protects both resources: ${branch}`, () => {
    const f = fixture();
    f.state.branches.push(branch);
    f.runner.cleanup();
    noDeletes(f);
  });
}
test('hashed long branch names use the existing sanitizer, not truncation guesses', () => {
  const f = fixture();
  const branch = 'feature/this-is-a-deliberately-long-branch-name';
  const env = sanitize(branch);
  f.state.branches.push(branch);
  f.state.apps = [app(`ca-web-${env}`, env)];
  f.state.stores = [account(env)];
  f.runner.cleanup();
  noDeletes(f);
});

for (const [env, kind] of [
  ['production', 'production'], ['production-north', 'production'], ['local-dev', 'standalone'],
  ['shared', 'shared'], ['production', 'branch'], ['production-north', 'branch'], ['main', 'branch']
]) {
  test(`protects ${kind}/${env} stores and production app forms`, () => {
    const f = fixture({ withApp: false });
    f.state.stores = [account(env, 'exampleprotected', kind)];
    if (env.startsWith('production')) f.state.apps = [app(`ca-web-${env}`, env, 'exampleprotected')];
    f.runner.cleanup();
    noDeletes(f);
  });
}
for (const mutate of [
  store => { delete store.tags; },
  store => { store.tags = null; },
  store => { store.tags = []; },
  store => { store.tags = 'branch'; },
  store => { delete store.tags['azd-env-name']; },
  store => { delete store.tags['astervoids-deployment-kind']; },
  store => { delete store.tags['astervoids-data']; },
  store => { delete store.tags['astervoids-retention']; },
  store => { store.tags['astervoids-retention'] = 'keep'; },
  store => { store.tags['astervoids-deployment-kind'] = 'Branch'; },
  store => { store.tags['azd-env-name'] = ['feature-retired']; },
  store => { store.tags['azd-env-name'] = 'feature/retired'; },
  store => { store.tags['azd-env-name'] = 'feature-retired-'; }
]) {
  test(`missing, malformed or non-branch ownership safely skips the store: ${mutate}`, () => {
    const f = fixture({ withApp: false });
    mutate(f.state.stores[0]);
    f.runner.cleanup();
    noDeletes(f);
    assert.ok(f.logs.some(line => line.startsWith('Safe skip:')));
  });
}
test('duplicate environment ownership is ambiguous, regardless of account name', () => {
  const f = fixture({ withApp: false });
  f.state.stores.push(account(environment, 'exampleotherstore'));
  f.runner.cleanup();
  noDeletes(f);
  assert.ok(f.logs.some(line => /ambiguous/.test(line)));
});
test('a differently named app referencing the account keeps the store', () => {
  const f = fixture({ withApp: false });
  f.state.apps = [app('other-deployment', 'other-environment')];
  f.runner.cleanup();
  noDeletes(f);
});
test('an orphan app can retire while a differently named live branch protects its shared store', () => {
  const f = fixture();
  f.state.branches.push('live');
  f.state.apps.push(app('ca-web-live', 'live'));
  assert.deepEqual(f.runner.cleanup(), { apps: 1, stores: 0, dns: 0 });
  assert.equal(f.state.stores.length, 1);
  assert.deepEqual(f.state.apps.map(value => value.name), ['ca-web-live']);
});
test('a still-active older revision also protects a store after its latest template changed', () => {
  const f = fixture({ withApp: false });
  const old = app('other-deployment', 'other-environment');
  const latest = app('other-deployment', 'other-environment', 'examplenewstore');
  latest.properties.latestRevisionName = 'other-deployment--rev2';
  f.state.apps = [latest];
  f.state.revisions.set(latest.name, [revision(old), revision(latest)]);
  f.runner.cleanup();
  noDeletes(f);
});
test('an expected app with ambiguous ownership is not deleted and protects storage', () => {
  const f = fixture();
  delete f.state.apps[0].tags;
  f.runner.cleanup();
  noDeletes(f);
});

for (const operation of ['branches', 'containerapp list', 'containerapp revision list', 'storage account list']) {
  test(`failed ${operation} never becomes evidence of absence`, () => {
    const f = fixture();
    f.intercept(op => { if (op === operation) throw new Error('private-inventory-sentinel'); });
    failWithoutDeletes(f);
    assert.ok(f.logs.every(line => !line.includes('private-inventory-sentinel')));
  });
}
for (const output of [
  '', '{}', 'not-a-ref', `${sha}\trefs/heads/feature/retired`,
  `${sha}\trefs/heads/main\n${sha}\trefs/heads/main`,
  `${sha}\trefs/heads/main\n${sha}\trefs/heads/invalid..ref`,
  `${sha}\trefs/heads/main\nincomplete`
]) {
  test(`invalid or incomplete remote branches fail closed: ${JSON.stringify(output)}`, () => {
    const f = fixture();
    f.intercept(op => op === 'branches' ? output : undefined);
    failWithoutDeletes(f);
  });
}
for (const operation of ['containerapp list', 'containerapp revision list', 'storage account list']) {
  for (const output of ['', '{}', 'null', '[', '[{}]', '{"value":[],"nextLink":"unread-page"}']) {
    test(`malformed/incomplete ${operation}: ${JSON.stringify(output)}`, () => {
      const f = fixture();
      f.intercept(op => op === operation ? output : undefined);
      failWithoutDeletes(f);
    });
  }
}
for (const mutate of [
  state => { delete state.apps[0].properties.template; },
  state => { state.apps[0].properties.template.containers = []; },
  state => { state.apps[0].properties.template.containers[0].env = []; },
  state => { state.apps[0].properties.template.containers[0].env[1] = { name: 'Identity__TableEndpoint', secretRef: 'unreadable' }; },
  state => { state.apps[0].properties.template.containers[0].env.push({ name: 'identity__tableendpoint', value: endpoint('otherstore') }); },
  state => { state.apps[0].properties.configuration.activeRevisionsMode = 'Multiple'; },
  state => { delete state.stores[0].id; },
  state => { delete state.stores[0].creationTime; },
  state => { delete state.stores[0].primaryEndpoints; },
  state => { state.stores[0].resourceGroup = 'rg-other'; },
  state => { state.stores[0].primaryEndpoints.table = endpoint('otherstore'); },
  state => { state.stores[0].provisioningState = 'Creating'; },
  state => { state.stores.push(structuredClone(state.stores[0])); },
  state => { state.apps[0].id = state.apps[0].id.replace(subscription, principal); }
]) {
  test(`incomplete, indirect or ambiguous inventory blocks deletion: ${mutate}`, () => {
    const f = fixture();
    mutate(f.state);
    failWithoutDeletes(f, /inventory|configuration|metadata|endpoint|Ambiguous/);
  });
}
test('empty revision discovery is not a claim that the deployment has no active references', () => {
  const f = fixture();
  f.state.revisions.set(f.state.apps[0].name, []);
  failWithoutDeletes(f);
});

for (const operation of ['containerapp delete', 'storage account delete']) {
  test(`${operation} failure is explicit and retryable, without successful retirement claims`, () => {
    const f = fixture();
    f.intercept(op => { if (op === operation) throw new Error('private-delete-sentinel'); });
    assert.throws(() => f.runner.cleanup(), /deletion failed/);
    assert.equal(f.state.stores.length, 1);
    if (operation === 'containerapp delete') {
      assert.ok(!f.deletes().some(call => call[1] === 'storage'));
    }
    f.intercept(() => undefined);
    assert.equal(f.runner.cleanup().stores, 1);
  });
}
for (const operation of ['containerapp delete', 'storage account delete']) {
  test(`${operation} must be confirmed absent even after CLI success`, () => {
    const f = fixture();
    f.intercept(op => op === operation ? '' : undefined);
    assert.throws(() => f.runner.cleanup(), /not confirmed absent/);
    assert.equal(f.state.stores.length, 1);
  });
}
for (const operation of ['containerapp list', 'storage account list']) {
  test(`failed post-delete ${operation} is not successful confirmation`, () => {
    const f = fixture();
    f.intercept(op => {
      if (op === operation && (operation === 'containerapp list' ? !f.state.apps.length : !f.state.stores.length)) {
        throw new Error('private-inventory-sentinel');
      }
    });
    assert.throws(() => f.runner.cleanup(), /discovery failed/);
    if (operation === 'containerapp list') assert.equal(f.state.stores.length, 1);
  });
}
for (const operation of ['branches', 'containerapp list', 'storage account list']) {
  test(`revalidation ${operation} failure prevents deletion`, () => {
    const f = fixture();
    f.intercept((op, count) => { if (op === operation && count === 2) throw new Error('failed-refresh'); });
    failWithoutDeletes(f);
  });
}
test('a branch recreated before app deletion protects the deployment and store', () => {
  const f = fixture();
  f.intercept((op, count) => { if (op === 'branches' && count === 2) f.state.branches.push('feature/retired'); });
  f.runner.cleanup();
  noDeletes(f);
});
test('a branch recreated after app removal still prevents storage deletion', () => {
  const f = fixture();
  f.intercept((op, count) => { if (op === 'branches' && count === 3) f.state.branches.push('Feature/Retired'); });
  assert.deepEqual(f.runner.cleanup(), { apps: 1, stores: 0, dns: 0 });
  assert.equal(f.state.stores.length, 1);
});
test('a newly discovered differently named deployment prevents storage deletion', () => {
  const f = fixture({ withApp: false });
  f.intercept((op, count) => {
    if (op === 'containerapp list' && count === 2) f.state.apps.push(app('new-deployment', 'new-environment'));
  });
  f.runner.cleanup();
  noDeletes(f);
});
test('an app recreated after confirmed removal prevents storage deletion', () => {
  const f = fixture();
  f.intercept((op, count) => {
    if (op === 'containerapp list' && count === 4) f.state.apps.push(app());
  });
  assert.deepEqual(f.runner.cleanup(), { apps: 1, stores: 0, dns: 0 });
  assert.equal(f.state.stores.length, 1);
});
test('a replaced app principal is not deleted from a stale plan', () => {
  const f = fixture();
  f.intercept((op, count) => {
    if (op === 'containerapp list' && count === 2) f.state.apps[0].identity.principalId = subscription;
  });
  f.runner.cleanup();
  noDeletes(f);
});
for (const mutation of ['generation', 'ownership', 'retention']) {
  test(`storage ${mutation} changes after planning prevent retirement`, () => {
    const f = fixture({ withApp: false });
    f.intercept((op, count) => {
      if (op === 'storage account list' && count === 2) {
        if (mutation === 'generation') f.state.stores[0].creationTime = '2026-10-08T00:00:00Z';
        if (mutation === 'ownership') f.state.stores[0].tags['astervoids-deployment-kind'] = 'production';
        if (mutation === 'retention') f.state.stores[0].tags['astervoids-retention'] = 'keep';
      }
    });
    f.runner.cleanup();
    noDeletes(f);
  });
}

test('DNS/certificate cleanup keeps base, regional, wildcard and live-branch artifacts private and protected', () => {
  const f = fixture({ withApp: false, withStore: false });
  f.state.apps = [app('ca-web-production-north', 'production', 'exampleproduction')];
  f.state.branches.push('feature/live');
  f.state.cname = ['app', 'app-production', 'app-production-north', 'app-north', 'app-feature-live', 'app-retired'];
  f.state.txt = f.state.cname.map(name => `asuid.${name}`);
  f.state.environments = ['cae-production', 'cae-production-north', 'cae-unrelated'];
  f.state.certificates.set('cae-production-north', [
    'cert-app-example-com', 'wildcard-example-com', 'cert-app-north-example-com',
    'cert-app-production-example-com', 'cert-app-production-north-example-com',
    'cert-app-feature-live-example-com', 'cert-app-retired-example-com'
  ]);
  assert.equal(f.runner.cleanup({ domain: 'example.com', subdomain: 'app' }).dns, 3);
  assert.ok(f.deletes().every(call => call.some(value => value.includes('retired'))));
  assert.ok(f.logs.every(line => !/example\.com|example-com|exampleproduction|subscriptions/.test(line)));
});
for (const operation of [
  'network dns record-set cname list', 'network dns record-set txt list',
  'containerapp env list', 'containerapp env certificate list'
]) {
  for (const malformed of [false, true]) {
    test(`DNS/cert discovery fails closed: ${operation}, malformed=${malformed}`, () => {
      const f = fixture({ withApp: false, withStore: false });
      f.state.environments = ['cae-production'];
      f.state.cname = ['app-retired'];
      f.intercept(op => {
        if (op === operation) {
          if (malformed) return '{"value":[],"nextLink":"unread-page"}';
          throw new Error('private-hostname-sentinel');
        }
      });
      assert.throws(() => f.runner.cleanup({ domain: 'example.com', subdomain: 'app' }), /discovery|inventory/i);
      noDeletes(f);
    });
  }
}
test('DNS deletion failure is not reported as successful cleanup', () => {
  const f = fixture({ withApp: false, withStore: false });
  f.state.cname = ['app-retired'];
  f.intercept(op => { if (op.endsWith('cname delete')) throw new Error('private-hostname-sentinel'); });
  assert.throws(() => f.runner.cleanup({ domain: 'example.com', subdomain: 'app' }), /deletion failed/);
});
test('DNS revalidation protects a recreated branch even before its app appears', () => {
  const f = fixture({ withApp: false, withStore: false });
  f.state.cname = ['app-retired'];
  f.intercept((op, count) => { if (op === 'branches' && count === 2) f.state.branches.push('retired'); });
  assert.equal(f.runner.cleanup({ domain: 'example.com', subdomain: 'app' }).dns, 0);
  noDeletes(f);
});
test('queued deployments must still match a live remote branch head after acquiring the interlock', () => {
  const f = fixture();
  f.runner.verifyDeploymentRef('refs/heads/main', sha);
  assert.throws(() => f.runner.verifyDeploymentRef('refs/heads/retired', sha), /removed or superseded/);
  assert.throws(() => f.runner.verifyDeploymentRef('refs/heads/main', 'b'.repeat(40)), /removed or superseded/);
  assert.throws(() => f.runner.verifyDeploymentRef('refs/tags/main', sha), /removed or superseded/);
  assert.throws(() => f.runner.verifyDeploymentRef('refs/heads/retired', undefined), /removed or superseded/);
  assert.throws(() => f.runner.verifyDeploymentRef(undefined, undefined), /removed or superseded/);
  assert.ok(f.calls.every(call => call[0] !== 'az'));
});
test('cleanup and deploy share a non-cancelling job interlock; validation uses the production runner', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');
  const deploy = read('../workflows/azure-deploy.yml');
  const cleanup = read('../workflows/cleanup-orphans.yml');
  for (const workflow of [deploy, cleanup]) {
    assert.match(workflow, /    concurrency:\n      group: astervoids-azure-resource-mutations\n      cancel-in-progress: false/);
  }
  assert.match(deploy, /run: node \.github\/scripts\/cleanup-orphans\.mjs --verify-deployment-ref/);
  assert.ok(deploy.indexOf('--verify-deployment-ref') < deploy.indexOf('- name: Set deployment variables'));
  assert.match(cleanup, /run: node \.github\/scripts\/cleanup-orphans\.mjs\n/);
  assert.match(cleanup, /CUSTOM_DOMAIN_NAME: \$\{\{ secrets.CUSTOM_DOMAIN_NAME \}\}/);
  assert.match(cleanup, /--ago 14d --untagged --keep 1/);
  assert.doesNotMatch(cleanup.split('- name: Cleanup old ACR')[0], /\|\| echo ""|az\s+.*delete/);
  assert.match(read('./workflow-helpers.test.sh'), /node --test "\$SCRIPT_DIR\/orphan-cleanup\.test\.mjs"/);
});
